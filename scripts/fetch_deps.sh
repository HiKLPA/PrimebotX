#!/usr/bin/env bash
# 拉取后端需要的两个头文件依赖到 third_party/。
# 默认走 Gitee 镜像（国内直连 GitHub 经常 502）；有代理时可设 DEPS_MIRROR=github。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPS="$ROOT/third_party"
MIRROR="${DEPS_MIRROR:-gitee}"
mkdir -p "$DEPS"

fetch() {
  local name="$1" dest="$2" gitee="$3" github="$4" marker="$5"
  if [ -f "$dest/$marker" ]; then
    echo "== $name 已存在，跳过"
    return
  fi
  local url="$gitee"
  [ "$MIRROR" = "github" ] && url="$github"
  echo "== 拉取 $name：$url"
  git clone --depth 1 "$url" "$dest"
}

fetch "cpp-httplib" "$DEPS/cpp-httplib" \
  https://gitee.com/mirrors_yhirose/cpp-httplib.git \
  https://github.com/yhirose/cpp-httplib.git httplib.h

fetch "nlohmann/json" "$DEPS/json" \
  https://gitee.com/mirrors/nlohmann-json.git \
  https://github.com/nlohmann/json.git single_include/nlohmann/json.hpp

echo "== 完成：$DEPS"
