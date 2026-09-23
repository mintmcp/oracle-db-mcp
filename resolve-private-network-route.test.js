"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveRoutedUrl } = require("./resolve-private-network-route.js");

const routes = JSON.stringify([
  { id: "pnrte_other", name: "Other", host: "other.flycast", port: 20001 },
  { id: "pnrte_db", name: "EBS DB", host: "route-db.flycast", port: 20000 },
]);
const resolve = (dbUrl, routeId = "pnrte_db", routesJson = routes) => resolveRoutedUrl({ dbUrl, routeId, routesJson }).url;

test("rewrites host:port and keeps the service name", () => {
  assert.equal(
    resolve("jdbc:oracle:thin:@db.internal:1521/EBSPROD.example.com"),
    "jdbc:oracle:thin:@route-db.flycast:20000/EBSPROD.example.com",
  );
});

test("handles the // prefix, a missing port and URL parameters", () => {
  assert.equal(resolve("jdbc:oracle:thin:@//10.0.2.15:1521/svc"), "jdbc:oracle:thin:@//route-db.flycast:20000/svc");
  assert.equal(resolve("jdbc:oracle:thin:@db.internal/svc"), "jdbc:oracle:thin:@route-db.flycast:20000/svc");
  assert.equal(
    resolve("jdbc:oracle:thin:@db.internal:1521/svc?oracle.net.CONNECT_TIMEOUT=5000"),
    "jdbc:oracle:thin:@route-db.flycast:20000/svc?oracle.net.CONNECT_TIMEOUT=5000",
  );
});

test("keeps a SID", () => {
  assert.equal(resolve("jdbc:oracle:thin:@db.internal:1521:EBSDB"), "jdbc:oracle:thin:@route-db.flycast:20000:EBSDB");
});

test("brackets IPv6 hosts", () => {
  assert.equal(resolve("jdbc:oracle:thin:@[fd00::5]:1521/svc"), "jdbc:oracle:thin:@route-db.flycast:20000/svc");
  const v6 = JSON.stringify([{ id: "pnrte_db", host: "fdaa::3", port: 20000 }]);
  assert.equal(resolve("jdbc:oracle:thin:@db:1521/svc", "pnrte_db", v6), "jdbc:oracle:thin:@[fdaa::3]:20000/svc");
});

test("trims the route id", () => {
  assert.equal(resolve("jdbc:oracle:thin:@db:1521/svc", "  pnrte_db\n"), "jdbc:oracle:thin:@route-db.flycast:20000/svc");
});

test("fails when the routes variable is missing or malformed", () => {
  assert.throws(() => resolve("jdbc:oracle:thin:@db:1521/svc", "pnrte_db", ""), /ROUTES_JSON is empty/);
  assert.throws(() => resolve("jdbc:oracle:thin:@db:1521/svc", "pnrte_db", "{not json"), /not valid JSON/);
  assert.throws(() => resolve("jdbc:oracle:thin:@db:1521/svc", "pnrte_db", "{}"), /not a JSON array/);
});

test("fails when the route is absent or incomplete", () => {
  assert.throws(() => resolve("jdbc:oracle:thin:@db:1521/svc", "pnrte_nope"), /pnrte_nope is not available.*pnrte_other, pnrte_db/);
  const noHost = JSON.stringify([{ id: "pnrte_db", host: "", port: 20000 }]);
  assert.throws(() => resolve("jdbc:oracle:thin:@db:1521/svc", "pnrte_db", noHost), /empty host/);
  const badPort = JSON.stringify([{ id: "pnrte_db", host: "h", port: "20000" }]);
  assert.throws(() => resolve("jdbc:oracle:thin:@db:1521/svc", "pnrte_db", badPort), /invalid port/);
});

test("refuses URLs it cannot rewrite", () => {
  const descriptor = "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=svc)))";
  assert.throws(() => resolve(descriptor), /EZConnect/);
  assert.throws(() => resolve("jdbc:oracle:thin:@EBSPROD_ALIAS"), /EZConnect/);
  assert.throws(() => resolve(""), /EZConnect/);
});
