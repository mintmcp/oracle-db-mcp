# Oracle Database MCP Docker Image

This repository contains the build configuration for the Oracle Database MCP image MintMCP publishes on Docker Hub (`<namespace>/oracle-db-mcp` below). The image vendors Oracle's [Database MCP Toolkit](https://github.com/oracle/mcp/tree/main/src/oracle-db-mcp-java-toolkit) (`src/oracle-db-mcp-java-toolkit` in the [`oracle/mcp`](https://github.com/oracle/mcp) monorepo) as a git submodule and adds what is required to run it inside MintMCP's hosted environment.

## Motivation
- The toolkit is configured through JVM system properties. The image adds an entrypoint (`oracle-db-mcp-toolkit`) that maps environment variables to those properties, using the variable names from upstream's `manifest.json`: `DB_URL`, `DB_USER`, `DB_PASSWORD`, `TOOLS`, `CONFIG_FILE`, `OJDBC_EXT_DIR`.
- The server runs over stdio. Its HTTP mode is HTTPS-only and requires bearer or OAuth2 authentication, which the hosted runtime does not supply. MintMCP's stdio wrapper needs Node.js in the image, so the runtime stage is `node:22-bookworm-slim` plus a headless OpenJDK 17.
- Tracking the upstream source as a submodule lets us follow upstream commits for fixes while keeping MintMCP-specific tooling in the container.

The toolkit itself is unmodified and runs with its default tool set. See the upstream README for the tools and their configuration.

## Build and test locally

```bash
git submodule update --init --recursive

docker buildx build --platform linux/amd64 -t <namespace>/oracle-db-mcp:local --load .
```

The build context is the repo root; `.dockerignore` sends only `upstream/src/oracle-db-mcp-java-toolkit` to the build. The image runs over stdio, so test it by feeding MCP JSON-RPC on stdin:

```bash
docker run -i --rm --platform linux/amd64 \
  -e DB_URL=jdbc:oracle:thin:@db.example.com:1521/ORCLPDB1 \
  -e DB_USER=mcp_user \
  -e DB_PASSWORD=... \
  <namespace>/oracle-db-mcp:local
```

Send `initialize`, then `tools/list`; 17 tools come back. Anything the entrypoint or the toolkit logs goes to stderr, stdout carries only JSON-RPC.

## Private Network routes

To reach a database that is only reachable inside a customer network, move the connector into a MintMCP [Private Network](https://www.mintmcp.com/docs/private-networks) that has a route to the database listener with **Hosted connectors** enabled. MintMCP then injects `MINTMCP_PRIVATE_NETWORK_ROUTES_JSON` into the container, listing each route's `id`, `name`, and the private `host` and `port` that carry raw TCP to the listener.

Keep `DB_URL` pointing at the database's real address and tell the connector which route serves it, with one of:

| Variable | Use it when | Example |
| --- | --- | --- |
| `DB_PRIVATE_NETWORK_ROUTE_ID` | `DB_URL` names a single address (EZConnect, or a descriptor with one `ADDRESS`) | `pnrte_...` |
| `DB_PRIVATE_NETWORK_ROUTES` | Several addresses: a failover descriptor, RAC SCAN and node listeners, datasources in `CONFIG_FILE` | `scan.internal:1521=pnrte_a,node1-vip.internal:1521=pnrte_b` |

With either variable set, the entrypoint runs the JVM under `private-network.js`:

- Each mapped host gets its own loopback address (`127.0.10.N`), where a forwarder listens on the database port and pipes every connection to the host's route.
- The JVM resolves mapped hostnames to those addresses through a hosts file (`-Djdk.net.hosts.file`), so `DB_URL` is passed unchanged and the driver still sees the real hostname, including for TLS server name checks. Any URL form works, and redirects to a mapped host (a RAC SCAN listener sending the client to a node VIP) land on the forwarder too.
- Hosts written as IP literals can't be redirected by name, so their occurrences in `DB_URL` are replaced with the loopback address.
- The wrapper never writes to stdout, forwards signals to the JVM, and exits with its status.

The connector refuses to start, with the reason on stderr, if a route is missing from the injected list, the list is missing, `DB_PRIVATE_NETWORK_ROUTE_ID` meets a URL with several addresses or none, or both variables are set. Without either variable, the JVM starts directly as before.

Limits:

- With a hosts file set, the JVM resolves only the mapped hostnames. Database traffic is unaffected, and in this stdio deployment nothing else in the JVM looks up names: the Object Storage and RAG tools run inside the database (`DBMS_CLOUD`), and the JVM's only outbound HTTP (OAuth2 token validation, DeepSec) is unused. It would matter if a future toolkit feature called out from the JVM.
- Database ports must be 1024 or higher (the container runs as a non-root user).
- TNS aliases need a `tnsnames.ora`, which the image doesn't ship.
- For RAC, map the SCAN address and every node VIP the listeners redirect to, each to a route that reaches it. Listeners that register node addresses as IP literals can't be redirected.

The wrapper's tests run during the image build (`node --test`); run them locally with:

```bash
docker run --rm -v "$PWD":/w -w /w node:22-bookworm-slim node --test private-network.test.js
```

## Publishing

```bash
docker buildx build --platform linux/amd64 -t <namespace>/oracle-db-mcp:<tag> --load .
docker push <namespace>/oracle-db-mcp:<tag>
```

Tags follow the toolkit version from upstream's `pom.xml` (`1.0.0`), with a `-N` suffix for image-only rebuilds of the same upstream version (`1.0.0-1`). Update `image` in the MintMCP registry entry to the pushed tag.

## Bumping the upstream version

```bash
git -C upstream fetch origin
git -C upstream checkout <commit or tag>
git add upstream
git commit -m "Bump upstream to <commit or tag>"
```

Then build and publish with a new tag. Deploying a stdio connector works through the MintMCP panel or the registry entry; `hosted-cli build-and-push --transport stdio` did not provision the platform's stdio adapter when the Grafana image was tried (hosted-cli 0.0.20).
