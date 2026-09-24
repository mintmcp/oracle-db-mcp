"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPlan, urlAddresses, parseRouteMap, javaArgs, replaceHostLiteral } = require("./private-network.js");

const routes = JSON.stringify([
  { id: "pnrte_a", name: "Node A", host: "route-a.flycast", port: 20000 },
  { id: "pnrte_b", name: "Node B", host: "route-b.flycast", port: 20001 },
]);
const DESCRIPTOR =
  "jdbc:oracle:thin:@(DESCRIPTION=(FAILOVER=on)(ADDRESS_LIST=" +
  "(ADDRESS=(PROTOCOL=TCP)(HOST=db-a.internal)(PORT=1521))" +
  "(ADDRESS=(PROTOCOL=TCP)(HOST=db-b.internal)(PORT=1522)))" +
  "(CONNECT_DATA=(SERVICE_NAME=EBSPROD)))";

test("finds the address in EZConnect URLs", () => {
  assert.deepEqual(urlAddresses("jdbc:oracle:thin:@db.internal:1521/EBSPROD"), {
    form: "ezconnect",
    addresses: [{ host: "db.internal", port: 1521 }],
  });
  assert.deepEqual(urlAddresses("jdbc:oracle:thin:@//db.internal/EBSPROD").addresses, [{ host: "db.internal", port: 1521 }]);
  assert.deepEqual(urlAddresses("jdbc:oracle:thin:@db.internal:1521:EBSDB").addresses, [{ host: "db.internal", port: 1521 }]);
  assert.deepEqual(urlAddresses("jdbc:oracle:thin:@[fd00::5]:1521/svc").addresses, [{ host: "fd00::5", port: 1521 }]);
});

test("finds every address in a TNS descriptor", () => {
  assert.deepEqual(urlAddresses(DESCRIPTOR), {
    form: "descriptor",
    addresses: [
      { host: "db-a.internal", port: 1521 },
      { host: "db-b.internal", port: 1522 },
    ],
  });
  assert.deepEqual(
    urlAddresses("jdbc:oracle:thin:@( description = ( address = ( protocol = tcp )( host = db )( port = 1600 ) ) )").addresses,
    [{ host: "db", port: 1600 }],
  );
});

test("reports aliases as another form", () => {
  assert.equal(urlAddresses("jdbc:oracle:thin:@EBSPROD").form, "other");
  assert.equal(urlAddresses("").form, "other");
});

test("parses the route map", () => {
  assert.deepEqual(parseRouteMap(" db-a.internal:1521=pnrte_a , [fd00::5]:1522=pnrte_b\n"), [
    { host: "db-a.internal", port: 1521, routeId: "pnrte_a" },
    { host: "fd00::5", port: 1522, routeId: "pnrte_b" },
  ]);
  assert.throws(() => parseRouteMap("db-a.internal=pnrte_a"), /host:port=pnrte_/);
  assert.throws(() => parseRouteMap(" , "), /empty/);
});

test("single route for a hostname: hosts file, URL unchanged", () => {
  const url = "jdbc:oracle:thin:@db.internal:1521/EBSPROD";
  const plan = buildPlan({ dbUrl: url, routeId: " pnrte_a ", routesJson: routes });
  assert.equal(plan.dbUrl, url);
  assert.deepEqual(plan.hostsLines, ["127.0.10.1 db.internal"]);
  assert.equal(plan.listeners.length, 1);
  assert.deepEqual(
    { ip: plan.listeners[0].listenIp, port: plan.listeners[0].port, route: plan.listeners[0].route.id },
    { ip: "127.0.10.1", port: 1521, route: "pnrte_a" },
  );
});

test("single route also accepts a one-address descriptor", () => {
  const url = "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db.internal)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=S)))";
  const plan = buildPlan({ dbUrl: url, routeId: "pnrte_a", routesJson: routes });
  assert.equal(plan.dbUrl, url);
  assert.deepEqual(plan.hostsLines, ["127.0.10.1 db.internal"]);
});

test("single route for an IP literal rewrites the URL", () => {
  const plan = buildPlan({ dbUrl: "jdbc:oracle:thin:@10.1.2.30:1521/EBSPROD", routeId: "pnrte_a", routesJson: routes });
  assert.equal(plan.dbUrl, "jdbc:oracle:thin:@127.0.10.1:1521/EBSPROD");
  assert.deepEqual(plan.hostsLines, []);
});

test("route map covers every address of a descriptor", () => {
  const plan = buildPlan({
    dbUrl: DESCRIPTOR,
    routeMap: "db-a.internal:1521=pnrte_a,db-b.internal:1522=pnrte_b",
    routesJson: routes,
  });
  assert.equal(plan.dbUrl, DESCRIPTOR);
  assert.deepEqual(plan.hostsLines, ["127.0.10.1 db-a.internal", "127.0.10.2 db-b.internal"]);
  assert.deepEqual(
    plan.listeners.map((l) => [l.listenIp, l.port, l.route.id]),
    [
      ["127.0.10.1", 1521, "pnrte_a"],
      ["127.0.10.2", 1522, "pnrte_b"],
    ],
  );
});

test("one host on two ports shares a loopback address", () => {
  const plan = buildPlan({ dbUrl: "", routeMap: "db:1521=pnrte_a,DB:2484=pnrte_b", routesJson: routes });
  assert.deepEqual(plan.listeners.map((l) => l.listenIp), ["127.0.10.1", "127.0.10.1"]);
  assert.deepEqual(plan.hostsLines, ["127.0.10.1 db"]);
});

test("rejects configurations it cannot honour", () => {
  assert.throws(() => buildPlan({ dbUrl: "x", routeId: "pnrte_a", routeMap: "a:1=pnrte_a", routesJson: routes }), /not both/);
  assert.throws(() => buildPlan({ dbUrl: DESCRIPTOR, routeId: "pnrte_a", routesJson: routes }), /lists 2 addresses.*DB_PRIVATE_NETWORK_ROUTES/);
  assert.throws(() => buildPlan({ dbUrl: "jdbc:oracle:thin:@EBSPROD", routeId: "pnrte_a", routesJson: routes }), /DB_PRIVATE_NETWORK_ROUTES/);
  assert.throws(() => buildPlan({ dbUrl: "", routeMap: "a:1521=pnrte_a,A:1521=pnrte_b", routesJson: routes }), /mapped more than once/);
  assert.throws(() => buildPlan({ dbUrl: "", routeMap: "a:1521=pnrte_nope", routesJson: routes }), /pnrte_nope is not available.*pnrte_a, pnrte_b/);
});

test("rejects missing or malformed routes", () => {
  const url = "jdbc:oracle:thin:@db:1521/s";
  assert.throws(() => buildPlan({ dbUrl: url, routeId: "pnrte_a", routesJson: "" }), /ROUTES_JSON is empty/);
  assert.throws(() => buildPlan({ dbUrl: url, routeId: "pnrte_a", routesJson: "{oops" }), /not valid JSON/);
  assert.throws(() => buildPlan({ dbUrl: url, routeId: "pnrte_a", routesJson: "{}" }), /not a JSON array/);
  const noHost = JSON.stringify([{ id: "pnrte_a", host: "", port: 1 }]);
  assert.throws(() => buildPlan({ dbUrl: url, routeId: "pnrte_a", routesJson: noHost }), /empty host/);
  const badPort = JSON.stringify([{ id: "pnrte_a", host: "h", port: "1" }]);
  assert.throws(() => buildPlan({ dbUrl: url, routeId: "pnrte_a", routesJson: badPort }), /invalid port/);
});

test("replaces IP literals only where they are hosts", () => {
  assert.equal(replaceHostLiteral("jdbc:oracle:thin:@//10.0.0.5:1521/s10.0.0.5", "10.0.0.5", "127.0.10.1"), "jdbc:oracle:thin:@//127.0.10.1:1521/s10.0.0.5");
  assert.equal(replaceHostLiteral("jdbc:oracle:thin:@[fd00::5]:1521/s", "fd00::5", "127.0.10.1"), "jdbc:oracle:thin:@127.0.10.1:1521/s");
  assert.equal(
    replaceHostLiteral("jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST = 10.0.0.5 )(PORT=1521)))", "10.0.0.5", "127.0.10.1"),
    "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST = 127.0.10.1 )(PORT=1521)))",
  );
});

test("builds the java command line", () => {
  const plan = { dbUrl: "jdbc:oracle:thin:@127.0.10.1:1521/s" };
  assert.deepEqual(javaArgs(["/usr/bin/java", "-Ddb.url=old", "-Ddb.user=u", "-jar", "/app/t.jar"], plan, "/tmp/h"), [
    "/usr/bin/java",
    "-Ddb.url=jdbc:oracle:thin:@127.0.10.1:1521/s",
    "-Ddb.user=u",
    "-Djdk.net.hosts.file=/tmp/h",
    "-jar",
    "/app/t.jar",
  ]);
  assert.deepEqual(javaArgs(["/usr/bin/java", "-jar", "/app/t.jar"], plan, null), ["/usr/bin/java", "-jar", "/app/t.jar"]);
});
