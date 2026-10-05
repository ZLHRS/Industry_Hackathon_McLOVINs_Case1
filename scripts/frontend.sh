#!/usr/bin/env bash
set -euo pipefail
project_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
node_version="$(cat "$project_root/.node-version")"
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
  *) echo 'Unsupported architecture; use Ubuntu x64/arm64.' >&2; exit 1 ;;
esac
node_bin="$project_root/var/node/node-v${node_version}-linux-${node_arch}/bin"
if [ -x "$node_bin/node" ]; then
  export PATH="$node_bin:$PATH"
elif [ "$(node --version 2>/dev/null || true)" != "v${node_version}" ]; then
  echo 'Run: uv run python scripts/dev_frontend.py bootstrap' >&2
  exit 1
fi
cd "$project_root/frontend"
exec npm "$@"
