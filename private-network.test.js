"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { buildTargets, urlAddresses, parseRouteMap, javaArgs, canonicalHost, startProxy } = require("./private-network.js");

const routes = JSON.stringify([
  { id: "pnrte_a", name: "Node A", host: "route-a.flycast", port: 20000 },
  { id: "pnrte_b", name: "Node B", host: "route-b.flycast", port: 20001 },
]);
const DESCRIPTOR =
  "jdbc:oracle:thin:@(DESCRIPTION=(FAILOVER=on)(ADDRESS_LIST=" +
  "(ADDRESS=(PROTOCOL=TCP)(HOST=db-a.internal)(PORT=1521))" +
  "(ADDRESS=(PROTOCOL=TCP)(HOST=db-b.internal)(PORT=1522)))" +
  "(CONNECT_DATA=(SERVICE_NAME=EBSPROD)))";

test("finds the addresses in EZConnect URLs and descriptors", () => {
  assert.deepEqual(urlAddresses("jdbc:oracle:thin:@db.internal:1521/EBSPROD").addresses, [{ host: "db.internal", port: 1521 }]);
  assert.deepEqual(urlAddresses("jdbc:oracle:thin:@//db.internal/EBSPROD").addresses, [{ host: "db.internal", port: 1521 }]);
  assert.deepEqual(urlAddresses("jdbc:oracle:thin:@db.internal:1521:EBSDB").addresses, [{ host: "db.internal", port: 1521 }]);
  assert.deepEqual(urlAddresses(DESCRIPTOR).addresses, [
    { host: "db-a.internal", port: 1521 },
    { host: "db-b.internal", port: 1522 },
  ]);
  assert.equal(urlAddresses("jdbc:oracle:thin:@EBSPROD").form, "other");
});

test("canonical hosts: lowercase names, compressed IPv6", () => {
  assert.equal(canonicalHost("DB.Internal"), "db.internal");
  assert.equal(canonicalHost("[FD00:0:0:0:0:0:0:5]"), "fd00::5");
  assert.equal(canonicalHost("10.1.2.30"), "10.1.2.30");
});

test("parses the route map", () => {
  assert.deepEqual(parseRouteMap(" db-a.internal:1521=pnrte_a , [fd00::5]:1522=pnrte_b\n"), [
    { host: "db-a.internal", port: 1521, routeId: "pnrte_a" },
    { host: "[fd00::5]", port: 1522, routeId: "pnrte_b" },
  ]);
  assert.throws(() => parseRouteMap("db-a.internal=pnrte_a"), /host:port=pnrte_/);
});

test("single route takes the one address from DB_URL", () => {
  const targets = buildTargets({ dbUrl: "jdbc:oracle:thin:@DB.internal:1521/S", routeId: " pnrte_a ", routesJson: routes });
  assert.deepEqual([...targets.keys()], ["db.internal:1521"]);
  assert.equal(targets.get("db.internal:1521").route.id, "pnrte_a");
});

test("route map covers several addresses", () => {
  const targets = buildTargets({
    dbUrl: DESCRIPTOR,
    routeMap: "db-a.internal:1521=pnrte_a,db-b.internal:1522=pnrte_b",
    routesJson: routes,
  });
  assert.deepEqual([...targets.entries()].map(([k, t]) => [k, t.route.id]), [
    ["db-a.internal:1521", "pnrte_a"],
    ["db-b.internal:1522", "pnrte_b"],
  ]);
});

test("rejects configurations it cannot honour", () => {
  assert.throws(() => buildTargets({ dbUrl: "x", routeId: "pnrte_a", routeMap: "a:1=pnrte_a", routesJson: routes }), /not both/);
  assert.throws(() => buildTargets({ dbUrl: DESCRIPTOR, routeId: "pnrte_a", routesJson: routes }), /lists 2 addresses/);
  assert.throws(() => buildTargets({ dbUrl: "jdbc:oracle:thin:@EBSPROD", routeId: "pnrte_a", routesJson: routes }), /tnsnames/);
  assert.throws(() => buildTargets({ dbUrl: "", routeMap: "a:1521=pnrte_a,A:1521=pnrte_b", routesJson: routes }), /more than once/);
  assert.throws(() => buildTargets({ dbUrl: "", routeMap: "a:1521=pnrte_nope", routesJson: routes }), /pnrte_nope is not available/);
  assert.throws(() => buildTargets({ dbUrl: "jdbc:oracle:thin:@db:1521/s", routeId: "pnrte_a", routesJson: "" }), /ROUTES_JSON is empty/);
  assert.throws(() => buildTargets({ dbUrl: "jdbc:oracle:thin:@db:1521/s", routeId: "pnrte_a", routesJson: "{}" }), /not a JSON array/);
});

test("adds the driver's SOCKS properties before -jar", () => {
  assert.deepEqual(javaArgs(["/usr/bin/java", "-Ddb.url=u", "-Xmx1g", "-jar", "/app/t.jar"], 40000), [
    "/usr/bin/java",
    "-Ddb.url=u",
    "-Xmx1g",
    "-Doracle.net.socksProxyHost=127.0.0.1",
    "-Doracle.net.socksProxyPort=40000",
    "-Doracle.net.socksRemoteDNS=true",
    "-jar",
    "/app/t.jar",
  ]);
});

// --- SOCKS5 server, over real sockets ---

function listenEcho() {
  return new Promise((resolve) => {
    const server = net.createServer((s) => s.pipe(s));
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// Performs a SOCKS5 CONNECT and returns { reply, socket }.
function socksConnect(proxyPort, request, greeting = Buffer.from([5, 1, 0])) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let buf = Buffer.alloc(0);
    let stage = 0;
    socket.on("error", reject);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        const method = buf[1];
        buf = buf.subarray(2);
        stage = 1;
        if (method === 0xff) return resolve({ method, socket });
        socket.write(request);
      }
      if (stage === 1 && buf.length >= 10) {
        stage = 2;
        resolve({ reply: buf[1], socket, rest: buf.subarray(10) });
      }
    });
    socket.on("connect", () => socket.write(greeting));
  });
}

function domainRequest(host, port) {
  const h = Buffer.from(host);
  const b = Buffer.alloc(7 + h.length);
  b.set([5, 1, 0, 3, h.length]);
  h.copy(b, 5);
  b.writeUInt16BE(port, 5 + h.length);
  return b;
}

test("proxies a mapped hostname to its route and carries data both ways", async () => {
  const echo = await listenEcho();
  const targets = buildTargets({
    dbUrl: "",
    routeMap: "db.internal:1521=pnrte_x",
    routesJson: JSON.stringify([{ id: "pnrte_x", host: "127.0.0.1", port: echo.address().port }]),
  });
  const proxy = await startProxy(targets, () => {});
  const { reply, socket } = await socksConnect(proxy.address().port, domainRequest("DB.internal", 1521));
  assert.equal(reply, 0);
  const echoed = await new Promise((resolve) => {
    socket.once("data", (d) => resolve(d.toString()));
    socket.write("ping");
  });
  assert.equal(echoed, "ping");
  socket.destroy();
  proxy.close();
  echo.close();
});

test("proxies an IPv4 target", async () => {
  const echo = await listenEcho();
  const targets = buildTargets({
    dbUrl: "",
    routeMap: "10.1.2.30:1521=pnrte_x",
    routesJson: JSON.stringify([{ id: "pnrte_x", host: "127.0.0.1", port: echo.address().port }]),
  });
  const proxy = await startProxy(targets, () => {});
  const req = Buffer.from([5, 1, 0, 1, 10, 1, 2, 30, 0x05, 0xf1]);
  const { reply, socket } = await socksConnect(proxy.address().port, req);
  assert.equal(reply, 0);
  socket.destroy();
  proxy.close();
  echo.close();
});

test("refuses unmapped targets, unsupported commands and auth-only clients", async () => {
  const logs = [];
  const targets = buildTargets({ dbUrl: "", routeMap: "db:1521=pnrte_a", routesJson: routes });
  const proxy = await startProxy(targets, (m) => logs.push(m));
  const port = proxy.address().port;

  const unmapped = await socksConnect(port, domainRequest("other.internal", 1521));
  assert.equal(unmapped.reply, 2);
  assert.match(logs.join("\n"), /no Private Network route for other.internal:1521/);
  unmapped.socket.destroy();

  const bind = domainRequest("db", 1521);
  bind[1] = 2;
  const cmd = await socksConnect(port, bind);
  assert.equal(cmd.reply, 7);
  cmd.socket.destroy();

  const auth = await socksConnect(port, Buffer.alloc(0), Buffer.from([5, 1, 2]));
  assert.equal(auth.method, 0xff);
  auth.socket.destroy();
  proxy.close();
});

test("reports a route that cannot be reached", async () => {
  const logs = [];
  const closed = await listenEcho();
  const deadPort = closed.address().port;
  closed.close();
  const targets = buildTargets({
    dbUrl: "",
    routeMap: "db:1521=pnrte_x",
    routesJson: JSON.stringify([{ id: "pnrte_x", host: "127.0.0.1", port: deadPort }]),
  });
  const proxy = await startProxy(targets, (m) => logs.push(m));
  const { reply, socket } = await socksConnect(proxy.address().port, domainRequest("db", 1521));
  assert.equal(reply, 5);
  assert.match(logs.join("\n"), /route pnrte_x to db:1521 failed/);
  socket.destroy();
  proxy.close();
});
