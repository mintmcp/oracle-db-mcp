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
