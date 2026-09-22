# MintMCP hosted build for Oracle's Database MCP Toolkit.
#
# Build context is the upstream monorepo (./upstream); the toolkit lives in
# src/oracle-db-mcp-java-toolkit. The upstream Dockerfile stays pristine; this
# one differs in two ways only:
#   1. The runtime stage ships Node.js, because the hosted stdio runtime wrapper
#      exec's `npx` to bridge stdio<->HTTP (same reason okta-mcp builds on a
#      python-nodejs base).
#   2. An entrypoint script turns env vars into the -D system properties the
#      toolkit reads, using the same variable names as upstream's manifest.json.
#
# The toolkit is served over stdio: its HTTP mode is HTTPS-only and requires
# bearer/OAuth2 auth, neither of which the hosted runtime provides.

# ---------- 1) Build stage (same as upstream) ----------
FROM maven:3.9.12-eclipse-temurin-17 AS builder

WORKDIR /src
COPY src/oracle-db-mcp-java-toolkit/ .
RUN mvn -B -q -DskipTests clean package

# ---------- 2) Runtime stage ----------
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jre-headless curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The hosted stdio wrapper runs `npx @mintmcp/stdio-to-server` as this user, and
# npm needs a writable home for its cache and logs, so create one (-m).
RUN useradd -r -u 10001 -m appuser \
    && mkdir -p /app /ext && chown -R appuser:appuser /app /ext

WORKDIR /app

COPY --from=builder /src/target/oracle-db-mcp-toolkit-*.jar /app/oracle-db-mcp-toolkit.jar

# The hosted stdio wrapper spawns the startup command with a minimal env, so the
# entrypoint lives on the default PATH and uses absolute paths internally.
COPY --chmod=0755 <<'EOF' /usr/local/bin/oracle-db-mcp-toolkit
#!/bin/sh
# Map env vars to the -D system properties the toolkit reads. Names follow
# upstream's manifest.json; unset variables are simply not passed.
set -- /usr/bin/java
[ -n "${CONFIG_FILE:-}" ]        && set -- "$@" "-DconfigFile=${CONFIG_FILE}"
[ -n "${DB_URL:-}" ]             && set -- "$@" "-Ddb.url=${DB_URL}"
[ -n "${DB_USER:-}" ]            && set -- "$@" "-Ddb.user=${DB_USER}"
[ -n "${DB_PASSWORD:-}" ]        && set -- "$@" "-Ddb.password=${DB_PASSWORD}"
[ -n "${TOOLS:-}" ]              && set -- "$@" "-Dtools=${TOOLS}"
[ -n "${OJDBC_EXT_DIR:-}" ]      && set -- "$@" "-Dojdbc.ext.dir=${OJDBC_EXT_DIR}"
[ -n "${JAVA_OPTS:-}" ]          && set -- "$@" ${JAVA_OPTS}
exec "$@" -jar /app/oracle-db-mcp-toolkit.jar
EOF

USER appuser

ENTRYPOINT ["oracle-db-mcp-toolkit"]
