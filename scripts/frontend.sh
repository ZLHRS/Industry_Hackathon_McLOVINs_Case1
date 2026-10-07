#!/usr/bin/env bash
set -euo pipefail
project_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
node_version="$(cat "$project_root/.node-version")"
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) echo 'Unsupported architecture; use x64/arm64.' >&2; exit 1 ;;
esac
case "$(uname -s)" in
  Darwin) node_platform=darwin ;;
  Linux) node_platform=linux ;;
  *) echo 'Use Linux, WSL or macOS.' >&2; exit 1 ;;
esac
node_bin="$project_root/var/node/node-v${node_version}-${node_platform}-${node_arch}/bin"
if [ -x "$node_bin/node" ]; then
  export PATH="$node_bin:$PATH"
else
  case "$(node --version 2>/dev/null || true)" in
    v24.*) ;;
    *) echo 'Use Node 24 LTS or run: uv run python scripts/dev_frontend.py bootstrap' >&2; exit 1 ;;
  esac
fi
cd "$project_root/frontend"
exec npm "$@"
