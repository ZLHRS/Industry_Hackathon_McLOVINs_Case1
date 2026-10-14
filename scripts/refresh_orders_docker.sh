#!/usr/bin/env bash
# Replace orders only in the existing Docker database; never remove database volumes.
set -euo pipefail
cd "$(dirname "$0")/.."
apply=0
anchor=()
seed=2026
while (($#)); do
  case "$1" in
    --apply) apply=1; shift ;;
    --anchor) [[ $# -ge 2 ]] || { echo 'Missing --anchor value' >&2; exit 2; }; anchor=(--anchor "$2"); shift 2 ;;
    --seed) [[ $# -ge 2 ]] || { echo 'Missing --seed value' >&2; exit 2; }; seed=$2; shift 2 ;;
    -h|--help) echo "Usage: bash scripts/refresh_orders_docker.sh [--anchor ISO_TIME_WITH_OFFSET] [--seed 2026] [--apply]"; echo 'Without --apply: preview only. With --apply: back up and replace ALL orders; preserve accounts/catalogs.'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
compose=(docker compose --env-file .env.docker --profile demo)
"${compose[@]}" build seed
"${compose[@]}" up -d --wait postgres
# Use the same fixed anchor for preview and apply, even across midnight.
if ((${#anchor[@]} == 0)); then
  anchor=(--anchor "$(date -u '+%Y-%m-%dT%H:%M:%S+00:00')")
fi
"${compose[@]}" run --rm --no-deps seed python -m seeds.industrial preview-orders "${anchor[@]}" --seed "$seed"
if ((apply == 0)); then
  echo 'Preview complete; no orders changed. Add --apply to replace ALL orders.'
  exit 0
fi
restart=()
running_services=$("${compose[@]}" ps --status running --services)
while IFS= read -r service; do
  case "$service" in api|worker) restart+=("$service");; esac
done <<< "$running_services"
container="technaryad-orders-refresh-$(date -u '+%Y%m%d%H%M%S')-$$"
cleanup() {
  local result=$?
  trap - EXIT
  docker rm -f "$container" >/dev/null 2>&1 || true
  if ((${#restart[@]})); then
    "${compose[@]}" start "${restart[@]}" || { echo 'Restart failed; run docker compose --env-file .env.docker start api worker' >&2; result=1; }
  fi
  exit "$result"
}
trap cleanup EXIT
if ((${#restart[@]})); then "${compose[@]}" stop "${restart[@]}"; fi
"${compose[@]}" run --name "$container" --no-deps seed python -m seeds.industrial replace-orders \
  "${anchor[@]}" --seed "$seed" --confirm REPLACE-ORDERS
umask 077
mkdir -p var/docker/order-backups
docker cp "$container:/app/var/order-backups/." var/docker/order-backups/
echo 'Orders replaced. Private backups: var/docker/order-backups and the persistent demo_output Docker volume.'
echo 'Reload the site to load the new order list. Accounts and passwords are unchanged.'
