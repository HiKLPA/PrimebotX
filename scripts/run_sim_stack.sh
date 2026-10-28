#!/usr/bin/env bash
# 一条命令起整条仿真链：MuJoCo 桥（默认 :8090）+ C++ 后端（默认 :8080）。
# 退出时（Ctrl+C / 关终端）自动收掉桥进程，不会留下占端口的孤儿。
#
#   bash scripts/run_sim_stack.sh                 离屏渲染，网页里能看画面
#   SIM_MODE=viewer bash scripts/run_sim_stack.sh 弹 MuJoCo 原生窗口，网页只给数值
#   PORT=8081 SIM_PORT=8091 bash scripts/run_sim_stack.sh
#   PYTHON=python3 bash scripts/run_sim_stack.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8080}"
SIM_PORT="${SIM_PORT:-8090}"
SIM_MODE="${SIM_MODE:-headless}"
PYTHON="${PYTHON:-python}"

case "$SIM_MODE" in
  headless) BRIDGE_FLAGS=(--headless) ;;
  viewer)   BRIDGE_FLAGS=() ;;
  *) echo "SIM_MODE 只能是 headless 或 viewer" >&2; exit 2 ;;
esac

# 后端产物：优先环境变量，其次仓库内构建目录，最后 Ubuntu 工作区旧路径
if [ -n "${PRIMEBOT_BIN:-}" ]; then
  BIN="$PRIMEBOT_BIN"
elif [ -x "$ROOT/backend-build/primebot_backend" ]; then
  BIN="$ROOT/backend-build/primebot_backend"
elif [ -x "$ROOT/backend-build/primebot_backend.exe" ]; then
  BIN="$ROOT/backend-build/primebot_backend.exe"
elif [ -x "${PRIMEBOT_WORKSPACE:-$HOME/primebot_ws}/backend-build-primebotx/primebot_backend" ]; then
  BIN="${PRIMEBOT_WORKSPACE:-$HOME/primebot_ws}/backend-build-primebotx/primebot_backend"
else
  echo "找不到 primebot_backend，先跑 bash scripts/fetch_deps.sh && bash scripts/build_backend.sh" >&2
  exit 2
fi

echo "== 启动仿真桥 :$SIM_PORT（$SIM_MODE）"
"$PYTHON" "$ROOT/sim/mujoco_bridge.py" --port "$SIM_PORT" "${BRIDGE_FLAGS[@]}" &
BRIDGE_PID=$!
cleanup() { kill "$BRIDGE_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# 等桥真正可用再拉后端，避免后端一起来就报 SIM_UNAVAILABLE
for _ in $(seq 1 60); do
  if curl -fsS --max-time 1 "http://127.0.0.1:$SIM_PORT/health" >/dev/null 2>&1; then
    READY=1; break
  fi
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "仿真桥启动失败，看上面的报错（多数是模型路径或 GL 后端）" >&2
    exit 1
  fi
  sleep 0.5
done
if [ "${READY:-0}" != "1" ]; then
  echo "仿真桥 30 秒内没起来，放弃" >&2
  exit 1
fi
echo "== 仿真桥就绪，启动后端 :$PORT"
echo "== 打开 http://127.0.0.1:$PORT/ui/PrrimebotX.html ，点顶栏 Advance 里的「连接仿真」"

"$BIN" --port "$PORT" --web-root "$ROOT/frontend" --sim-url "http://127.0.0.1:$SIM_PORT"
