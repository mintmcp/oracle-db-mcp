#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPSTREAM_DIR="${SCRIPT_DIR}/upstream"

DOCKER_USER="keomaplank"
DOCKER_REPO="oracle-db-mcp"
VERSION="latest"
UPSTREAM_REF=""

usage() {
  cat <<'EOF'
Usage: ./build-and-push.sh [options]

Options:
  --version, -v <value>   Image tag to build (defaults to latest)
  --ref <value>           Upstream oracle/mcp ref to build from (defaults to main for
                          latest, otherwise the same value as --version)
  --user, -u <value>      Docker Hub username/namespace (defaults to keomaplank)
  --repo, -r <value>      Docker Hub repository name (defaults to oracle-db-mcp)
  --help, -h              Show this message

Examples:
  ./build-and-push.sh --version latest
  ./build-and-push.sh --version 1.0.0 --ref 1f1c05c
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|-v) shift; [[ $# -gt 0 ]] || { echo "Error: --version requires a value" >&2; usage; exit 1; }; VERSION="$1" ;;
    --ref)        shift; [[ $# -gt 0 ]] || { echo "Error: --ref requires a value" >&2; usage; exit 1; }; UPSTREAM_REF="$1" ;;
    --user|-u)    shift; [[ $# -gt 0 ]] || { echo "Error: --user requires a value" >&2; usage; exit 1; }; DOCKER_USER="$1" ;;
    --repo|-r)    shift; [[ $# -gt 0 ]] || { echo "Error: --repo requires a value" >&2; usage; exit 1; }; DOCKER_REPO="$1" ;;
    --help|-h)    usage; exit 0 ;;
    *) echo "Error: unknown argument '$1'" >&2; usage; exit 1 ;;
  esac
  shift
done

IMAGE_NAME="${DOCKER_USER}/${DOCKER_REPO}"

echo "Building ${IMAGE_NAME}:${VERSION}"

# Ensure submodule is present
git -C "${SCRIPT_DIR}" submodule update --init --recursive upstream

# Fetch latest refs from upstream
git -C "${UPSTREAM_DIR}" fetch origin --tags --prune

if [[ -z "${UPSTREAM_REF}" ]]; then
  if [[ "${VERSION}" == "latest" ]]; then
    UPSTREAM_REF="main"
  else
    UPSTREAM_REF="${VERSION}"
  fi
fi

if [[ "${UPSTREAM_REF}" == "main" ]]; then
  echo "Checking out upstream main branch..."
  git -C "${UPSTREAM_DIR}" checkout main
  git -C "${UPSTREAM_DIR}" pull --ff-only origin main
else
  echo "Checking out upstream ref '${UPSTREAM_REF}'..."
  git -C "${UPSTREAM_DIR}" checkout "${UPSTREAM_REF}"
fi

# Build using upstream submodule as context
docker build --platform linux/amd64 \
  -f "${SCRIPT_DIR}/Dockerfile" \
  -t "${IMAGE_NAME}:${VERSION}" \
  "${UPSTREAM_DIR}"

# Push the version
docker push "${IMAGE_NAME}:${VERSION}"

# Get and display the image SHA
IMAGE_SHA=$(docker inspect --format='{{index .RepoDigests 0}}' "${IMAGE_NAME}:${VERSION}")
echo "Image SHA: ${IMAGE_SHA}"
