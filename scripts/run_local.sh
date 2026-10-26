#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
workspace="${PRIMEBOT_WORKSPACE:-$HOME/primebot_ws}"
exec "$workspace/backend-build-primebotx/primebot_backend" --port "${PORT:-8080}" --web-root "$project_dir/frontend"
