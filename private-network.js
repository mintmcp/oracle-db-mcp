// MintMCP Private Network support for the Oracle Database MCP Toolkit.
//
// When the connector runs in a Private Network, MintMCP injects
// MINTMCP_PRIVATE_NETWORK_ROUTES_JSON, e.g. [{"id":"pnrte_...","name":"...","host":"...","port":20000}].
// Each "Hosted connectors" route carries raw TCP to one internal host:port.
//
// Instead of rewriting the JDBC URL, this wrapper leaves the database hostnames alone and
// changes where their TCP connections go:
//   1. every mapped database host gets its own loopback address (127.0.10.N), with a small
//      forwarder listening there on the database port and piping each connection to its route;
//   2. the JVM resolves the mapped hostnames to those loopback addresses through a hosts file
//      (-Djdk.net.hosts.file), so the driver still sees the real hostname (TLS server name,
//      certificate match) and any URL form works, including multi-address descriptors;
//   3. hosts given as IP literals cannot be redirected by name, so their occurrences in
//      DB_URL are replaced with the loopback address;
//   4. the toolkit JVM runs as a child with inherited stdio; this process never writes to
//      stdout (the MCP channel) and exits with the child's status.
//
// Configuration (one of):
//   DB_PRIVATE_NETWORK_ROUTE_ID=pnrte_...      the single address in DB_URL goes through this route
//   DB_PRIVATE_NETWORK_ROUTES=host:port=pnrte_...,host2:port=pnrte_...
//                                              explicit mapping, e.g. every address of a descriptor,
//                                              or RAC SCAN and node VIP listeners
//
// Trade-off: with a hosts file set, the JVM resolves only the mapped hostnames. Database traffic
// is unaffected, and in this stdio deployment nothing else in the JVM resolves names (Object
// Storage and RAG tools run in the database; OAuth2/DeepSec HTTP calls are unused).
//
// Usage (from the entrypoint): node private-network.js /usr/bin/java [-D...] -jar /app/oracle-db-mcp-toolkit.jar

"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const LOOPBACK_PREFIX = "127.0.10.";
const MAX_HOSTS = 250;
const DEFAULT_PORT = 1521;

class ConfigError extends Error {}

function normalizeHost(host) {
  const h = host.trim();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

// Routes injected by MintMCP.
function parseRoutes(routesJson, context) {
  if (!routesJson) {
    throw new ConfigError(
      `${context} is set, but MINTMCP_PRIVATE_NETWORK_ROUTES_JSON is empty. ` +
        "Move the connector into the Private Network that owns the route, and enable Hosted connectors on the route.",
    );
  }
  let routes;
  try {
    routes = JSON.parse(routesJson);
  } catch (err) {
    throw new ConfigError(`MINTMCP_PRIVATE_NETWORK_ROUTES_JSON is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(routes)) {
    throw new ConfigError("MINTMCP_PRIVATE_NETWORK_ROUTES_JSON is not a JSON array");
  }
  return routes;
}

function findRoute(routes, id) {
  const route = routes.find((r) => r && r.id === id);
  if (!route) {
    const available = routes.map((r) => r && r.id).filter(Boolean).join(", ") || "none";
    throw new ConfigError(`Private Network route ${id} is not available to this connector (available: ${available})`);
  }
  if (typeof route.host !== "string" || route.host.trim() === "") {
    throw new ConfigError(`Private Network route ${id} has an empty host`);
  }
  if (!Number.isInteger(route.port) || route.port < 1 || route.port > 65535) {
    throw new ConfigError(`Private Network route ${id} has an invalid port: ${route.port}`);
  }
  return route;
}

// The database addresses named in a JDBC thin URL.
const EZCONNECT = /^(jdbc:oracle:thin:@(?:\/\/)?)(\[[^\]]+\]|[^:/?()\s]+)(?::(\d+))?([/:].*)$/i;
const DESCRIPTOR_ADDRESS = /\(\s*ADDRESS\s*=((?:[^()]|\([^()]*\))*)\)/gi;

function urlAddresses(dbUrl) {
  const url = (dbUrl || "").trim();
  const ez = EZCONNECT.exec(url);
  if (ez) {
    return { form: "ezconnect", addresses: [{ host: normalizeHost(ez[2]), port: ez[3] ? Number(ez[3]) : DEFAULT_PORT }] };
  }
  if (/^jdbc:oracle:thin:@\s*\(/i.test(url)) {
    const addresses = [];
    for (const m of url.matchAll(DESCRIPTOR_ADDRESS)) {
      const host = /\(\s*HOST\s*=\s*([^)\s]+)\s*\)/i.exec(m[1]);
      const port = /\(\s*PORT\s*=\s*(\d+)\s*\)/i.exec(m[1]);
      if (host) addresses.push({ host: normalizeHost(host[1]), port: port ? Number(port[1]) : DEFAULT_PORT });
    }
    return { form: "descriptor", addresses };
  }
  return { form: "other", addresses: [] };
}

// DB_PRIVATE_NETWORK_ROUTES: "host:port=pnrte_...,host2:port=pnrte_..."
function parseRouteMap(spec) {
  const entries = spec
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new ConfigError("DB_PRIVATE_NETWORK_ROUTES is empty");
  return entries.map((entry) => {
    const m = /^(\[[^\]]+\]|[^\s:=\[\]]+):(\d+)\s*=\s*(\S+)$/.exec(entry);
    if (!m) {
      throw new ConfigError(`DB_PRIVATE_NETWORK_ROUTES entry "${entry}" must look like host:port=pnrte_...`);
    }
    return { host: normalizeHost(m[1]), port: Number(m[2]), routeId: m[3] };
  });
}

// Everything the wrapper needs: listeners, hosts file lines, and the DB_URL to pass on.
function buildPlan({ dbUrl, routeId, routeMap, routesJson }) {
  const id = (routeId || "").trim();
  const map = (routeMap || "").trim();
  if (id && map) {
    throw new ConfigError("Set either DB_PRIVATE_NETWORK_ROUTE_ID or DB_PRIVATE_NETWORK_ROUTES, not both");
  }

  let targets;
  if (id) {
    const parsed = urlAddresses(dbUrl);
    if (parsed.form === "other") {
      throw new ConfigError(
        "DB_PRIVATE_NETWORK_ROUTE_ID needs the database address in DB_URL (jdbc:oracle:thin:@host:port/service_name " +
          "or a TNS descriptor). TNS aliases need a tnsnames.ora, which this image does not ship; " +
          "for datasources defined in CONFIG_FILE, map each host with DB_PRIVATE_NETWORK_ROUTES",
      );
    }
    const unique = [...new Map(parsed.addresses.map((a) => [`${a.host.toLowerCase()}:${a.port}`, a])).values()];
    if (unique.length !== 1) {
      throw new ConfigError(
        `DB_URL lists ${unique.length} addresses; map each one to a route with DB_PRIVATE_NETWORK_ROUTES ` +
          "(host:port=pnrte_...,host:port=pnrte_...)",
      );
    }
    targets = [{ ...unique[0], routeId: id }];
  } else {
    targets = parseRouteMap(map);
  }

  const routes = parseRoutes(routesJson, id ? "DB_PRIVATE_NETWORK_ROUTE_ID" : "DB_PRIVATE_NETWORK_ROUTES");

  const seen = new Set();
  const listenIps = new Map(); // lowercased host -> loopback address
  const listeners = [];
  for (const t of targets) {
    const key = `${t.host.toLowerCase()}:${t.port}`;
    if (seen.has(key)) throw new ConfigError(`${t.host}:${t.port} is mapped more than once`);
    seen.add(key);
    const route = findRoute(routes, t.routeId);
    if (!listenIps.has(t.host.toLowerCase())) {
      if (listenIps.size >= MAX_HOSTS) throw new ConfigError(`At most ${MAX_HOSTS} database hosts can be mapped`);
      listenIps.set(t.host.toLowerCase(), `${LOOPBACK_PREFIX}${listenIps.size + 1}`);
    }
    listeners.push({ host: t.host, port: t.port, listenIp: listenIps.get(t.host.toLowerCase()), route });
  }

  // Hostnames go through the hosts file; IP literals are replaced in DB_URL.
  const hostsLines = [];
  let url = dbUrl || "";
  const done = new Set();
  for (const l of listeners) {
    const k = l.host.toLowerCase();
    if (done.has(k)) continue;
    done.add(k);
    if (net.isIP(l.host)) {
      url = replaceHostLiteral(url, l.host, l.listenIp);
    } else {
      hostsLines.push(`${l.listenIp} ${l.host}`);
    }
  }
  return { listeners, hostsLines, dbUrl: url };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replace an IP literal where it appears as a host in the URL: "@ip:", "@//ip:", "[ip]", "(HOST=ip)".
function replaceHostLiteral(url, ip, replacement) {
  const e = escapeRegExp(ip);
  return url
    .replace(new RegExp(`\\[${e}\\]`, "gi"), replacement)
    .replace(new RegExp(`(@(?://)?)${e}(?=[:/])`, "gi"), `$1${replacement}`)
    .replace(new RegExp(`(\\(\\s*HOST\\s*=\\s*)${e}(\\s*\\))`, "gi"), `$1${replacement}$2`);
}

// The java command line with the rewritten DB_URL and the hosts file option.
function javaArgs(argv, plan, hostsFile) {
  const args = argv.map((a) => (a.startsWith("-Ddb.url=") ? `-Ddb.url=${plan.dbUrl}` : a));
  if (hostsFile) {
    const jar = args.indexOf("-jar");
    args.splice(jar === -1 ? 1 : jar, 0, `-Djdk.net.hosts.file=${hostsFile}`);
  }
  return args;
}

function log(message) {
  process.stderr.write(`oracle-db-mcp: ${message}\n`);
}

function listen(l) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect({ host: l.route.host, port: l.route.port });
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      upstream.on("error", (err) => {
        log(`route ${l.route.id} to ${l.host}:${l.port} failed: ${err.message}`);
        close();
      });
      client.on("error", close);
      client.pipe(upstream).pipe(client);
    });
    server.once("error", (err) =>
      reject(new ConfigError(`cannot listen on ${l.listenIp}:${l.port} for ${l.host}: ${err.message}`)),
    );
    server.listen(l.port, l.listenIp, () => resolve(server));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) throw new ConfigError("usage: private-network.js <java command...>");

  const plan = buildPlan({
    dbUrl: process.env.DB_URL,
    routeId: process.env.DB_PRIVATE_NETWORK_ROUTE_ID,
    routeMap: process.env.DB_PRIVATE_NETWORK_ROUTES,
    routesJson: process.env.MINTMCP_PRIVATE_NETWORK_ROUTES_JSON,
  });

  const servers = await Promise.all(plan.listeners.map(listen));
  for (const l of plan.listeners) {
    log(`${l.host}:${l.port} goes through Private Network route ${l.route.id} (${l.route.name || "unnamed"})`);
  }

  let hostsFile = null;
  if (plan.hostsLines.length > 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-db-mcp-"));
    hostsFile = path.join(dir, "hosts");
    fs.writeFileSync(hostsFile, `${plan.hostsLines.join("\n")}\n`);
  }

  const [cmd, ...args] = javaArgs(argv, plan, hostsFile);
  const child = spawn(cmd, args, { stdio: "inherit" });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => child.kill(sig));
  }
  child.on("error", (err) => {
    log(`cannot start ${cmd}: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    for (const s of servers) s.close();
    process.exit(code ?? 128 + (os.constants.signals[signal] || 0));
  });
}

module.exports = { buildPlan, urlAddresses, parseRouteMap, javaArgs, replaceHostLiteral, ConfigError };

if (require.main === module) {
  main().catch((err) => {
    log(err instanceof ConfigError ? err.message : err.stack || String(err));
    process.exit(1);
  });
}
