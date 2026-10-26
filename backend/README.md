# Primebot 管理后端 0.1.0

当前为 **C++17 模拟 HTTP 后端**，不会连接机器人或发送 ROS 指令。Ubuntu 22.04 下构建，使用系统 cpp-httplib 与 nlohmann-json。

```bash
sudo apt-get install build-essential cmake ninja-build pkg-config libcpp-httplib-dev nlohmann-json3-dev python3
cmake -S ~/primebot_ws/project/backend -B ~/primebot_ws/backend-build -G Ninja
cmake --build ~/primebot_ws/backend-build -j2
ctest --test-dir ~/primebot_ws/backend-build --output-on-failure
~/primebot_ws/backend-build/primebot_backend --port 8080
```

仅监听127.0.0.1；用WSL curl或Windows localhost访问。当前无认证、无CORS，未开放局域网。退出按Ctrl+C。每次进程重启，模拟状态、操作记录和日志清空。

接口以文档3所列“已实现”为准。示例：

```bash
curl http://127.0.0.1:8080/api/v1/health
curl -X POST http://127.0.0.1:8080/api/v1/connections -H 'Content-Type: application/json' -H 'Idempotency-Key: connect-1' -d '{"robot_id":"q1-mock","mode":"mock"}'
curl -X POST http://127.0.0.1:8080/api/v1/tts -H 'Content-Type: application/json' -H 'Idempotency-Key: tts-1' -d '{"text":"你好，启元机器人","interrupt":false}'
curl http://127.0.0.1:8080/api/v1/logs
```

每个新操作使用新的Idempotency-Key；重复同键同内容返回原结果。返回simulated和robot_executed=false表示仅模拟，不会发声或运动。
