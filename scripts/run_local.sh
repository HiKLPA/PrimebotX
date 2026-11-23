#!/usr/bin/env bash
# 只启动本地后端。AI 服务未启动时，账号、页面和动作演示仍可使用。
#   PORT=8081 bash scripts/run_local.sh
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"

# 依次找：环境变量 > 仓库内构建目录
if [ -n "${PRIMEBOTX_BIN:-}" ]; then
  bin="$PRIMEBOTX_BIN"
elif [ -x "$project_dir/backend-build/primebotx_backend" ]; then
  bin="$project_dir/backend-build/primebotx_backend"
elif [ -x "$project_dir/backend-build/primebotx_backend.exe" ]; then
  bin="$project_dir/backend-build/primebotx_backend.exe"
else
  echo "找不到 primebotx_backend，先跑 bash scripts/fetch_deps.sh && bash scripts/build_backend.sh" >&2
  exit 2
fi

exec "$bin" --port "${PORT:-8080}" --web-root "$project_dir/frontend"
