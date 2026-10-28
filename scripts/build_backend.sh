#!/usr/bin/env bash
# 构建 primebot_backend。
#   Linux         直接用系统 cmake + make
#   Windows(MSYS) 用 VS2022 自带 cmake/ninja，并显式拼 MSVC + Windows SDK 的
#                 PATH/INCLUDE/LIB。不调 vcvars64.bat：它内部会用 reg.exe 探测
#                 安装信息，受限环境下会失败，显式给路径更稳。
# 依赖缺失时先跑 scripts/fetch_deps.sh。
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${BUILD_DIR:-$ROOT/backend-build}"
SRC="$ROOT/backend"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    VS_ROOT="$(ls -d "/c/Program Files/Microsoft Visual Studio/2022/"* 2>/dev/null | head -1)"
    MSVC_DIR="$(ls -d "$VS_ROOT"/VC/Tools/MSVC/*/ 2>/dev/null | sort -V | tail -1)"
    CMAKE="$(ls "$VS_ROOT"/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe 2>/dev/null | head -1)"
    NINJA_DIR="$(ls -d "$VS_ROOT"/Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja 2>/dev/null | head -1)"
    SDK_BIN_ROOT="/c/Program Files (x86)/Windows Kits/10"
    SDK_VER="$(ls "$SDK_BIN_ROOT/Include" 2>/dev/null | sort -V | tail -1)"
    if [ -z "$MSVC_DIR" ] || [ -z "$CMAKE" ] || [ -z "$SDK_VER" ]; then
      echo "找不到 MSVC / CMake / Windows SDK，请确认装了「使用 C++ 的桌面开发」工作负载" >&2
      exit 2
    fi
    MSVC_WIN="$(cygpath -w "${MSVC_DIR%/}")"
    SDK_WIN="$(cygpath -w "$SDK_BIN_ROOT")"
    TMP_BAT="$(mktemp -d)/build_primebot.bat"
    {
      echo "@echo off"
      echo "set \"PATH=$(cygpath -w "${MSVC_DIR%/}")\\bin\\Hostx64\\x64;$SDK_WIN\\bin\\$SDK_VER\\x64;$(cygpath -w "$NINJA_DIR");%PATH%\""
      echo "set \"INCLUDE=$MSVC_WIN\\include;$SDK_WIN\\Include\\$SDK_VER\\ucrt;$SDK_WIN\\Include\\$SDK_VER\\um;$SDK_WIN\\Include\\$SDK_VER\\shared\""
      echo "set \"LIB=$MSVC_WIN\\lib\\x64;$SDK_WIN\\Lib\\$SDK_VER\\ucrt\\x64;$SDK_WIN\\Lib\\$SDK_VER\\um\\x64\""
      echo "\"$(cygpath -w "$CMAKE")\" -S \"$(cygpath -w "$SRC")\" -B \"$(cygpath -w "$BUILD")\" -G Ninja -DCMAKE_BUILD_TYPE=Release || exit /b 1"
      echo "\"$(cygpath -w "$CMAKE")\" --build \"$(cygpath -w "$BUILD")\" || exit /b 1"
    } > "$TMP_BAT"
    cmd //c "$(cygpath -w "$TMP_BAT")"
    echo "== 产物：$BUILD/primebot_backend.exe"
    ;;
  *)
    echo "== 配置（Unix Makefiles）"
    cmake -S "$SRC" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release
    echo "== 编译"
    cmake --build "$BUILD" -j"$(nproc 2>/dev/null || echo 2)"
    echo "== 产物：$BUILD/primebot_backend"
    ;;
esac
