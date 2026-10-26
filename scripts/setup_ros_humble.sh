#!/usr/bin/env bash
set -euo pipefail
. /etc/os-release
[[ "$VERSION_ID" == "22.04" ]] || { echo 'Ubuntu 22.04 required'; exit 1; }
[[ $EUID == 0 ]] || { echo 'Run with sudo'; exit 1; }
locale-gen en_US.UTF-8
export LANG=en_US.UTF-8
add-apt-repository -y universe
curl --fail --location --retry 3 https://raw.githubusercontent.com/ros/rosdistro/master/ros.key -o /usr/share/keyrings/ros-archive-keyring.gpg
printf 'deb [arch=%s signed-by=/usr/share/keyrings/ros-archive-keyring.gpg] http://packages.ros.org/ros2/ubuntu jammy main\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/ros2.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ros-humble-ros-base ros-humble-rmw-fastrtps-cpp python3-colcon-common-extensions
