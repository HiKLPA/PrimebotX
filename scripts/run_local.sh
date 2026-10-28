#!/usr/bin/env bash
# 只启动后端。默认纯 mock（不连真机、也不连仿真）。
#   bash scripts/run_local.sh            纯 mock，/motion 与 /control 返回 422
#   bash scripts/run_local.sh --sim      转发到已经在跑的 MuJoCo 桥
#   PORT=8081 bash scripts/run_local.sh
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
workspace="${PRIMEBOT_WORKSPACE:-$HOME/primebot_ws}"
extra=()
for arg in "$@"; do
  case "$arg" in
    --sim) extra+=(--sim-url "${SIM_URL:-http://127.0.0.1:8090}") ;;
    *) echo "未知参数：$arg（可用：--sim）" >&2; exit 2 ;;
  esac
done

# 依次找：环境变量 > 仓库内构建目录 > Ubuntu 工作区旧路径
if [ -n "${PRIMEBOT_BIN:-}" ]; then
  bin="$PRIMEBOT_BIN"
elif [ -x "$project_dir/backend-build/primebot_backend" ]; then
  bin="$project_dir/backend-build/primebot_backend"
elif [ -x "$project_dir/backend-build/primebot_backend.exe" ]; then
  bin="$project_dir/backend-build/primebot_backend.exe"
elif [ -x "$workspace/backend-build-primebotx/primebot_backend" ]; then
  bin="$workspace/backend-build-primebotx/primebot_backend"
else
  echo "找不到 primebot_backend，先跑 bash scripts/fetch_deps.sh && bash scripts/build_backend.sh" >&2
  exit 2
fi

exec "$bin" --port "${PORT:-8080}" --web-root "$project_dir/frontend" ${extra[@]+"${extra[@]}"}
