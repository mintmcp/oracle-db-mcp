// MintMCP Private Network support for the Oracle Database MCP Toolkit, through the JDBC
// driver's own SOCKS5 support.
//
// When the connector runs in a Private Network, MintMCP injects
// MINTMCP_PRIVATE_NETWORK_ROUTES_JSON, e.g. [{"id":"pnrte_...","name":"...","host":"...","port":20000}].
// Each "Hosted connectors" route carries raw TCP to one internal host:port.
//
// The Oracle JDBC driver (OJDBC) can send every connection it opens through a SOCKS5 proxy:
// oracle.net.socksProxyHost / socksProxyPort, with oracle.net.socksRemoteDNS=true so it passes
// the target hostname instead of resolving it. This wrapper:
//   1. runs a small SOCKS5 server on loopback that knows only the mapped database addresses
//      and pipes each CONNECT to that address's route (anything else is refused);
//   2. starts the toolkit JVM as a child with those three driver properties, leaving DB_URL
//      unchanged. Every URL form works, the driver keeps the real hostname (TLS checks), and
//      connections the driver opens on its own, such as a RAC SCAN listener's redirect to a
//      node VIP, go through the proxy too;
//   3. never writes to stdout (the MCP channel), forwards signals, and exits with the JVM's status.
// Only OJDBC connections use the proxy; other JVM traffic and name resolution are untouched.
//
// Configuration (one of):
//   DB_PRIVATE_NETWORK_ROUTE_ID=pnrte_...      the single address in DB_URL goes through this route
//   DB_PRIVATE_NETWORK_ROUTES=host:port=pnrte_...,host2:port=pnrte_...
//                                              explicit mapping, e.g. every address of a descriptor,
//                                              or RAC SCAN and node VIP listeners
//
// Usage (from the entrypoint): node private-network.js /usr/bin/java [-D...] -jar /app/oracle-db-mcp-toolkit.jar

"use strict";

const net = require("node:net");
const os = require("node:os");
const { spawn } = require("node:child_process");

const DEFAULT_PORT = 1521;

class ConfigError extends Error {}

// Canonical form for comparing hosts: lowercase names, compressed IPv6.
function canonicalHost(host) {
  let h = host.trim();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (net.isIPv6(h)) return new URL(`http://[${h}]`).hostname.slice(1, -1);
  return h.toLowerCase();
}

function targetKey(host, port) {
  return `${canonicalHost(host)}:${port}`;
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
    return { form: "ezconnect", addresses: [{ host: ez[2], port: ez[3] ? Number(ez[3]) : DEFAULT_PORT }] };
  }
  if (/^jdbc:oracle:thin:@\s*\(/i.test(url)) {
    const addresses = [];
    for (const m of url.matchAll(DESCRIPTOR_ADDRESS)) {
      const host = /\(\s*HOST\s*=\s*([^)\s]+)\s*\)/i.exec(m[1]);
      const port = /\(\s*PORT\s*=\s*(\d+)\s*\)/i.exec(m[1]);
      if (host) addresses.push({ host: host[1], port: port ? Number(port[1]) : DEFAULT_PORT });
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
    return { host: m[1], port: Number(m[2]), routeId: m[3] };
  });
}

// Map of "host:port" -> { host, port, route } for every address the proxy will accept.
function buildTargets({ dbUrl, routeId, routeMap, routesJson }) {
  const id = (routeId || "").trim();
  const map = (routeMap || "").trim();
  if (id && map) {
    throw new ConfigError("Set either DB_PRIVATE_NETWORK_ROUTE_ID or DB_PRIVATE_NETWORK_ROUTES, not both");
  }

  let wanted;
  if (id) {
    const parsed = urlAddresses(dbUrl);
    if (parsed.form === "other") {
      throw new ConfigError(
        "DB_PRIVATE_NETWORK_ROUTE_ID needs the database address in DB_URL (jdbc:oracle:thin:@host:port/service_name " +
          "or a TNS descriptor). TNS aliases need a tnsnames.ora, which this image does not ship; " +
          "for datasources defined in CONFIG_FILE, map each host with DB_PRIVATE_NETWORK_ROUTES",
      );
    }
    const unique = [...new Map(parsed.addresses.map((a) => [targetKey(a.host, a.port), a])).values()];
    if (unique.length !== 1) {
      throw new ConfigError(
        `DB_URL lists ${unique.length} addresses; map each one to a route with DB_PRIVATE_NETWORK_ROUTES ` +
          "(host:port=pnrte_...,host:port=pnrte_...)",
      );
    }
    wanted = [{ ...unique[0], routeId: id }];
  } else {
    wanted = parseRouteMap(map);
  }

  const routes = parseRoutes(routesJson, id ? "DB_PRIVATE_NETWORK_ROUTE_ID" : "DB_PRIVATE_NETWORK_ROUTES");
  const targets = new Map();
  for (const w of wanted) {
    const key = targetKey(w.host, w.port);
    if (targets.has(key)) throw new ConfigError(`${w.host}:${w.port} is mapped more than once`);
    targets.set(key, { host: canonicalHost(w.host), port: w.port, route: findRoute(routes, w.routeId) });
  }
  return targets;
}

// The java command line with the driver's SOCKS properties (last, so they win over JAVA_OPTS).
function javaArgs(argv, proxyPort) {
  const props = [
    "-Doracle.net.socksProxyHost=127.0.0.1",
    `-Doracle.net.socksProxyPort=${proxyPort}`,
    "-Doracle.net.socksRemoteDNS=true",
  ];
  const args = [...argv];
  const jar = args.indexOf("-jar");
  args.splice(jar === -1 ? args.length : jar, 0, ...props);
  return args;
}

function log(message) {
  process.stderr.write(`oracle-db-mcp: ${message}\n`);
}

// Minimal SOCKS5 (RFC 1928): no authentication, CONNECT only, mapped targets only.
const REPLY = { OK: 0, GENERAL: 1, NOT_ALLOWED: 2, HOST_UNREACHABLE: 4, REFUSED: 5, COMMAND: 7, ADDRESS_TYPE: 8 };

function reply(socket, code) {
  socket.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
}

function handleClient(client, targets, logger) {
  let buf = Buffer.alloc(0);
  let stage = "greeting";
  client.on("error", () => client.destroy());

  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (stage === "greeting") {
      if (buf.length < 2) return;
      const n = buf[1];
      if (buf[0] !== 5) return client.destroy();
      if (buf.length < 2 + n) return;
      const methods = buf.subarray(2, 2 + n);
      buf = buf.subarray(2 + n);
      if (!methods.includes(0)) {
        client.end(Buffer.from([5, 0xff]));
        return;
      }
      client.write(Buffer.from([5, 0]));
      stage = "request";
    }
    if (stage === "request") {
      if (buf.length < 5) return;
      if (buf[0] !== 5) return client.destroy();
      const cmd = buf[1];
      const atyp = buf[3];
      let host;
      let end;
      if (atyp === 1) {
        end = 4 + 4;
        if (buf.length < end + 2) return;
        host = [...buf.subarray(4, end)].join(".");
      } else if (atyp === 3) {
        end = 5 + buf[4];
        if (buf.length < end + 2) return;
        host = buf.subarray(5, end).toString("utf8");
      } else if (atyp === 4) {
        end = 4 + 16;
        if (buf.length < end + 2) return;
        const words = [];
        for (let i = 4; i < end; i += 2) words.push(buf.readUInt16BE(i).toString(16));
        host = words.join(":");
      } else {
        reply(client, REPLY.ADDRESS_TYPE);
        return client.end();
      }
      const port = buf.readUInt16BE(end);
      const rest = buf.subarray(end + 2);
      client.removeListener("data", onData);
      stage = "connecting";

      if (cmd !== 1) {
        reply(client, REPLY.COMMAND);
        return client.end();
      }
      const target = targets.get(targetKey(host, port));
      if (!target) {
        logger(`no Private Network route for ${host}:${port}; add it to DB_PRIVATE_NETWORK_ROUTES`);
        reply(client, REPLY.NOT_ALLOWED);
        return client.end();
      }
      const upstream = net.connect({ host: target.route.host, port: target.route.port });
      let connected = false;
      upstream.once("connect", () => {
        connected = true;
        reply(client, REPLY.OK);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", (err) => {
        logger(`route ${target.route.id} to ${host}:${port} failed: ${err.message}`);
        if (!connected) {
          reply(client, err.code === "ENOTFOUND" ? REPLY.HOST_UNREACHABLE : REPLY.REFUSED);
        }
        client.destroy();
      });
      client.on("close", () => upstream.destroy());
    }
  };
  client.on("data", onData);
}

function startProxy(targets, logger = log) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => handleClient(client, targets, logger));
    server.once("error", (err) => reject(new ConfigError(`cannot start the Private Network proxy: ${err.message}`)));
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) throw new ConfigError("usage: private-network.js <java command...>");

  const targets = buildTargets({
    dbUrl: process.env.DB_URL,
    routeId: process.env.DB_PRIVATE_NETWORK_ROUTE_ID,
    routeMap: process.env.DB_PRIVATE_NETWORK_ROUTES,
    routesJson: process.env.MINTMCP_PRIVATE_NETWORK_ROUTES_JSON,
  });
  const server = await startProxy(targets);
  for (const t of targets.values()) {
    log(`${t.host}:${t.port} goes through Private Network route ${t.route.id} (${t.route.name || "unnamed"})`);
  }

  const [cmd, ...args] = javaArgs(argv, server.address().port);
  const child = spawn(cmd, args, { stdio: "inherit" });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => child.kill(sig));
  }
  child.on("error", (err) => {
    log(`cannot start ${cmd}: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    server.close();
    process.exit(code ?? 128 + (os.constants.signals[signal] || 0));
  });
}

module.exports = { buildTargets, urlAddresses, parseRouteMap, javaArgs, canonicalHost, startProxy, ConfigError };

if (require.main === module) {
  main().catch((err) => {
    log(err instanceof ConfigError ? err.message : err.stack || String(err));
    process.exit(1);
  });
}
