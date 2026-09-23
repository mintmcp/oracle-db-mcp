// Point DB_URL at a MintMCP Private Network route.
//
// When the connector is created in a Private Network, MintMCP injects
// MINTMCP_PRIVATE_NETWORK_ROUTES_JSON, e.g. [{"id":"pnrte_...","name":"...","host":"...","port":20000}].
// Each "Hosted connectors" route carries raw TCP to one internal host:port, which is all
// Oracle Net needs. DB_PRIVATE_NETWORK_ROUTE_ID selects the route (opt-in); this script
// swaps the host:port in DB_URL for the route's and keeps the service name or SID.
//
// Run by the entrypoint: prints the rewritten URL on stdout, or a reason on stderr and exits 1.

"use strict";

// EZConnect forms: @host:port/service, @//host:port/service, @host:port:SID, [ipv6] hosts.
const EZCONNECT = /^(jdbc:oracle:thin:@(?:\/\/)?)(\[[^\]]+\]|[^:/?()\s]+)(?::(\d+))?([/:].*)$/;

function resolveRoutedUrl({ dbUrl, routeId, routesJson }) {
  const id = (routeId || "").trim();
  if (!routesJson) {
    throw new Error(
      `DB_PRIVATE_NETWORK_ROUTE_ID is set to ${id}, but MINTMCP_PRIVATE_NETWORK_ROUTES_JSON is empty. ` +
        "Create the connector in the Private Network that owns the route, and enable Hosted connectors on the route.",
    );
  }
  let routes;
  try {
    routes = JSON.parse(routesJson);
  } catch (err) {
    throw new Error(`MINTMCP_PRIVATE_NETWORK_ROUTES_JSON is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(routes)) {
    throw new Error("MINTMCP_PRIVATE_NETWORK_ROUTES_JSON is not a JSON array");
  }
  const route = routes.find((r) => r && r.id === id);
  if (!route) {
    const available = routes.map((r) => r && r.id).filter(Boolean).join(", ") || "none";
    throw new Error(`Private Network route ${id} is not available to this connector (available: ${available})`);
  }
  if (typeof route.host !== "string" || route.host.trim() === "") {
    throw new Error(`Private Network route ${id} has an empty host`);
  }
  if (!Number.isInteger(route.port) || route.port < 1 || route.port > 65535) {
    throw new Error(`Private Network route ${id} has an invalid port: ${route.port}`);
  }
  const match = EZCONNECT.exec(dbUrl || "");
  if (!match) {
    throw new Error(
      "DB_URL must be an EZConnect JDBC URL (jdbc:oracle:thin:@host:port/service_name) " +
        "to use a Private Network route; TNS descriptors and aliases are not rewritten.",
    );
  }
  const host = route.host.includes(":") && !route.host.startsWith("[") ? `[${route.host}]` : route.host;
  return { url: `${match[1]}${host}:${route.port}${match[4]}`, route };
}

module.exports = { resolveRoutedUrl };

if (require.main === module) {
  try {
    const { url, route } = resolveRoutedUrl({
      dbUrl: process.env.DB_URL,
      routeId: process.env.DB_PRIVATE_NETWORK_ROUTE_ID,
      routesJson: process.env.MINTMCP_PRIVATE_NETWORK_ROUTES_JSON,
    });
    process.stderr.write(
      `oracle-db-mcp: connecting through Private Network route ${route.id} (${route.name || "unnamed"})\n`,
    );
    process.stdout.write(url);
  } catch (err) {
    process.stderr.write(`oracle-db-mcp: ${err.message}\n`);
    process.exit(1);
  }
}
