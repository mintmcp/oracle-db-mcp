# Oracle Database MCP Docker Image

This repository contains the build configuration for the [`keomaplank/oracle-db-mcp`](https://hub.docker.com/r/keomaplank/oracle-db-mcp) image published on Docker Hub. The image vendors Oracle's [Database MCP Toolkit](https://github.com/oracle/mcp/tree/main/src/oracle-db-mcp-java-toolkit) (`src/oracle-db-mcp-java-toolkit` in the [`oracle/mcp`](https://github.com/oracle/mcp) monorepo) as a git submodule and adds what is required to run it inside MintMCP's hosted environment.

## Motivation
- The toolkit is configured through JVM system properties. The image adds an entrypoint (`oracle-db-mcp-toolkit`) that maps environment variables to those properties, using the variable names from upstream's `manifest.json`: `DB_URL`, `DB_USER`, `DB_PASSWORD`, `TOOLS`, `CONFIG_FILE`, `OJDBC_EXT_DIR`.
- The server runs over stdio. Its HTTP mode is HTTPS-only and requires bearer or OAuth2 authentication, which the hosted runtime does not supply. MintMCP's stdio wrapper needs Node.js in the image, so the runtime stage is `node:22-bookworm-slim` plus a headless OpenJDK 17.
- Tracking the upstream source as a submodule lets us follow upstream commits for fixes while keeping MintMCP-specific tooling in the container.

The toolkit itself is unmodified and runs with its default tool set. See the upstream README for the tools and their configuration.

## Testing the image locally
```bash
# Build a local image (matches the build-and-push script)
docker build \
  --platform linux/amd64 \
  -f Dockerfile \
  -t keomaplank/oracle-db-mcp:local \
  ./upstream

# Run over stdio against your database
docker run -i --rm \
  -e DB_URL=jdbc:oracle:thin:@db.example.com:1521/ORCLPDB1 \
  -e DB_USER=mcp_user \
  -e DB_PASSWORD=... \
  keomaplank/oracle-db-mcp:local
```

Then send MCP JSON-RPC (`initialize`, `tools/list`, ...) on stdin.

## Building and publishing
```bash
git submodule update --init --recursive
git -C upstream fetch --tags

docker login
./build-and-push.sh --version <tag> --ref <upstream commit or tag>
```

Examples:
- `./build-and-push.sh --version latest` (builds upstream `main`)
- `./build-and-push.sh --version 1.0.0 --ref 1f1c05c`

Image tags follow the toolkit version (`<toolkit version>` from `pom.xml`), with a `-N` suffix for image-only rebuilds of the same upstream version.
