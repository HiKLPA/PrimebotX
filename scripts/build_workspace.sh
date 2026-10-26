#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
workspace="${PRIMEBOT_WORKSPACE:-$HOME/primebot_ws}"
[[ -f "$workspace/q1-sdk-official/aimdk_msgs/package.xml" ]] || { echo 'Clone q1-sdk into workspace/q1-sdk-official first'; exit 1; }
[[ -f /opt/ros/humble/setup.bash ]] || { echo 'Install ROS 2 Humble first'; exit 1; }
for location in "$project_dir" "$workspace" "$workspace/q1-sdk-official/aimdk_msgs"; do
  case "$(realpath "$location")" in
    /mnt/*) echo "Use Linux filesystem source and workspace, not $location"; exit 1 ;;
  esac
done
[[ ! -L "$workspace/q1-sdk-official/aimdk_msgs" ]] || { echo 'aimdk_msgs must be a real directory, not a source symlink'; exit 1; }
mkdir -p "$workspace/evidence"
cmake -S "$project_dir/backend" -B "$workspace/backend-build-primebotx" -G Ninja -DCMAKE_BUILD_TYPE=Debug
cmake --build "$workspace/backend-build-primebotx" -j2
ctest --test-dir "$workspace/backend-build-primebotx" --output-on-failure
# ROS setup scripts reference unset variables, so source before restoring nounset.
set +u
source /opt/ros/humble/setup.bash
set -u
cd "$workspace"
CMAKE_BUILD_PARALLEL_LEVEL=2 colcon build --base-paths "$workspace/q1-sdk-official" --packages-select aimdk_msgs --symlink-install --executor sequential --cmake-args -DCMAKE_BUILD_TYPE=Release
