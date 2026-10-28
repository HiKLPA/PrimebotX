# Q1 管理系统开发入口

当前基线日期：2026-10-26。

1. [文档1：WSL迁移与环境复现](./docs/文档1_WSL迁移与环境复现.md)：Ubuntu22.04、依赖、构建和验证。
2. [文档2：独立需求分析](./docs/文档2_独立需求分析.md)：不受现有前端限制的产品范围与后续复刻层次。
3. [文档3：最小后端与后续工作](./docs/文档3_最小后端与后续工作.md)：已实现接口、运行说明、测试和未完成事项。

backend/ 为C++17源码；scripts/为可复现步骤。当前仅模拟模式，真机接入尚未完成。

MuJoCo 仿真联动见 [sim/README.md](./sim/README.md)：`sim/mujoco_bridge.py` 跑 Q1 的 MJCF 模型并暴露 HTTP，后端加 `--sim-url`（或 `scripts/run_local.sh --sim`）后网页即可驱动仿真；不给该参数时行为与纯 mock 完全一致。

整条链路一条命令起：`bash scripts/run_sim_stack.sh`（桥 8090 + 后端 8080），随后 `python scripts/verify_sim_chain.py` 自检十项接口。首次使用先 `pip install -r sim/requirements.txt`、`bash scripts/fetch_model.sh`，编译后端用 `bash scripts/fetch_deps.sh && bash scripts/build_backend.sh`。

旧阶段1两份文档保留作历史草案。本轮文档2取代其需求范围，文档3定义实际实现；不要混用旧规划与新程序接口。


前端源码现位于frontend，启动和协作方式见[前后端联调](./docs/前后端联调.md)。Ubuntu执行 `bash ~/primebot_ws/PrimebotX/scripts/run_local.sh`，Windows打开 http://localhost:8080/ 。开发源码仅保存在Ubuntu，Windows管理系统开发目录只保留文档。官方SDK获取地址：https://gitcode.com/primebot/q1-sdk 。
