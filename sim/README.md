# 网页驱动 MuJoCo 仿真

把 Q1 的 MJCF 模型跑成独立进程，用 HTTP 暴露控制与状态，让 PrimebotX 网页真正驱动仿真里的机器人。

链路：网页 → C++ 后端 `:8080`（限幅、幂等、鉴权边界）→ 仿真桥 `:8090`（物理循环、离屏渲染）。

```
浏览器 frontend/            backend (C++17)              mujoco_bridge.py
Advance 弹窗 ── /api/v1/... ──► 校验 + 转发 ── /cmd/* ──►  MjModel/MjData
             ◄── /api/v1/sim/{state,frame} ◄── 透传 ◄──  100 Hz 循环 + 15 fps JPEG
```

## 快速开始

三条命令，Windows 与 Ubuntu 都一样（Windows 在 Git Bash 里执行）：

```bash
pip install -r sim/requirements.txt          # mujoco / numpy / pillow
bash scripts/fetch_model.sh                  # 拉官方模型到 sim/assets/q1-urdf
bash scripts/run_sim_stack.sh                # 起桥(8090) + 后端(8080)
```

Windows 不想记 Git Bash 的路径就直接双击 `scripts\run_sim_stack.cmd`，或者在 cmd 里跑它：脚本会自己找 `C:\Program Files\Git\bin\bash.exe` 并转交给 `run_sim_stack.sh`（这条路径保留 Ctrl+C 收尾）；机器上没装 Git Bash 时，它退化成用 `python` 直接起桥、再用 `backend-build\primebot_backend.exe` 起后端，两个窗口各自独立，关掉前端窗口时会顺带把桥的窗口一起收掉。`PORT` / `SIM_PORT` / `SIM_MODE` / `PYTHON` / `PRIMEBOT_BIN` 照样认。

浏览器打开 http://127.0.0.1:8080/ui/PrrimebotX.html ，点顶栏 Advance，点弹窗标题区右上角的「连接仿真」。连上之后这枚按钮变成「已连接」并保持主题色底，点一下先转成 warning 色的「断连」（确认态，3 秒内不再点一下会退回已连接），再点一下才真正断开（走 `DELETE /connection`，会先给桥发一次急停），面板退回「请先连接仿真」。

弹窗里能做的事：左侧画面（拖动旋转、滚轮缩放、右下角有操作提示），右侧顶部是全局速度条（不分分区、四个 tab 共用），下面是「手臂 / 腰 / 腿 / 联动」四个等宽 tab——前三个出关节滑块，联动出姿态、动作、步态三排按钮；面板外侧左边是一列工具（重置姿态、急停、切换驱动模式、左右转、复位视角、存图），右边是参数栏（逐行读数，底部是状态提示）。键盘也能开：WASD 平移、Q/E 转向、空格急停，焦点在滑块上时不抢按键。页面左侧那个九宫格方向键照旧驱动底盘。

初次构建后端（或改了 `backend/src/main.cpp`）需要先编一次：

```bash
bash scripts/fetch_deps.sh    # cpp-httplib + nlohmann/json 拉到 third_party
bash scripts/build_backend.sh # Linux 用 make，Windows 用 VS2022 自带 cmake+ninja
```

验收整条链路（后端与桥都在跑时）：

```bash
python scripts/verify_sim_chain.py
```

它会依次打健康检查、连接、关节表、关节控位、手势、底盘前进与转向、急停、JPEG 帧、模式切换、姿态预设、步态摆动、视角、速度倍率、静态页面，逐步打印 PASS/FAIL，退出码非零表示有环节断了。

## 模型

`q1_v3_mc.xml`：22 个铰链 + 1 个浮动基座，nq=29 / nv=28，整机 16.9 kg。
桥按下面顺序找模型，找到就用，不必每次传参数：

1. `--xml <路径>`
2. 环境变量 `SIM_XML`
3. `sim/assets/q1-urdf/xml/q1_v3_mc.xml`
4. `./q1-urdf/xml/q1_v3_mc.xml`

路径必须全英文。MuJoCo 解析器遇到中文目录会直接报错，而且报错信息不会指向路径。

核对模型是否对得上：

```bash
python sim/mujoco_bridge.py --print-joints   # 关节名、类型、限位、是否可控
```

## 两种驱动模式

| 模式 | 做了什么 | 现象 | 用途 |
|---|---|---|---|
| `kinematic`（默认） | 只改 `qpos` + `mj_forward`，从不 `mj_step` | 机器人稳稳停在空中，随指令摆姿势 | 网页滑块、手势、底盘演示 |
| `dynamic` | `mj_step` + `qfrc_applied` 上的 PD 保持 | 没有站立控制器时会被重力带倒 | 验证力矩、接触、真实动力学 |

`dynamic` 倒下去是正确结果，不是故障。要站住得另加平衡控制器（RL 策略或 ZMP/MPC），不在本桥范围内。
弹窗里的「切到动力学」按钮就是这条切换，切过去后滑块会自动禁用，避免一边倒一边改目标。

## 底盘怎么动

运动学模式下桥直接积分浮动基座：`qpos[0:3]` 是位置，`qpos[3:7]` 是四元数。

- `vx` 沿机头方向、`vy` 指向左侧，都是机体系，随转向一起旋转
- `wz` 绕 z 轴自转，累积成四元数写回 `qpos`
- 指令**不持久**：页面按住时每 100 ms 续发一次，桥 0.5 s 收不到就清零，所以关标签页、断网、后端崩掉都不会让机器人一直走

相机取景按机器人本体包围盒计算（不能用 `model.stat.center`，这个模型带地面，包围盒中心会被地面拉偏），并跟随底盘平移，机器人走到哪画面跟到哪。

## 手势

六个动作都落在 `q1_v3_mc.xml` 的真实限位上。这台机器人没有腕关节、前臂也短，够不到身体中线，胸前合掌做不出来，所以比心做成双手举过头顶的版本。

| 名字 | 关节组合 | 视觉效果 |
|---|---|---|
| `wave` | 右肩 roll -2.3、pitch -0.3，yaw 与肘按 2.5 rad/s 摆动 | 右臂举起挥手 |
| `heart` | 双肩 pitch -2.6、roll ±0.4、yaw ±1.2，肘 1.2 | 双臂举过头顶在头顶合拢 |
| `cheer` | 双肩 roll ±2.5、pitch 0.15，pitch 再叠加 3 rad/s 摆动 | 双臂 V 字上下振 |
| `wave_both` | 双肩 roll ±2.3，yaw 反相摆 2.6 rad/s | 双手一起挥 |
| `dance` | 双肩 roll ±1.6，pitch 分别按 3.0 / 4.5 rad/s 交叠，腰 yaw 叠加 0.35 摆动 | 左右手交错摆、腰跟着扭 |
| `stretch` | 双肩 roll ±2.55、pitch 0.45，pitch 以 1.2 rad/s 缓慢起伏 | 伸懒腰 |

要加动作就在 `GESTURES` 里加一项，`pose` 是基准姿势，`osc` 是正弦摆动（幅度, 角频率），`label` 是页面按钮上的中文名。

## 姿态、步态、视角

三类操作的区别：姿态是一次性目标，步态是持续写 target 直到停，动作（手势）同理但只动上半身。

姿态预设（`/cmd/preset`，`stand` / `tpose` / `squat` / `hands_up` / `reach`）会先把所有关节归零再叠加，所以从任意姿势切过去都是可预期的。`squat` 带 `base_dz:-0.105`：屈膝会让脚离地，机身要一起压下去才对得上，这个值是按腿长算的，再深就变成单膝跪地。

步态（`/cmd/gait`，`walk` / `march`）用正弦相位驱动两条腿：髋 pitch 摆幅 0.35、膝在摆动相屈起、踝反向补偿保持脚掌水平、手臂反向摆、腰轻微扭。只写 target，实际角速度仍受 `--joint-speed` 限制，所以从站姿切进步态不会瞬移。`{"name":"off"}` 停止。

视角（`/cmd/camera`）传 `azimuth` / `elevation` / `distance` 的任意组合，或 `{"reset": true}` 回到启动时的机位。页面里在画面上拖动就是改 azimuth 与 elevation，滚轮缩放 distance。窗口模式没有离屏相机，这个接口会返回 422，页面上的相机控件随之置灰。

速度倍率（`/cmd/speed`，0.2–3.0）是全局量，同时作用于手势相位、步态频率、关节限速，以及滑块与姿态预设的过渡速度（`apply_pose` 里按倍率缩放 slew），所以四个分区共用一根速度条；页面滑块给的是 0.3–2.5。动力学模式下关节由 PD 直接跟 target，不受这条速度条影响。

## 接口

桥（`127.0.0.1:8090`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 模式、`nq/nv/nu`、渲染是否可用 |
| GET | `/joints` | 关节表：名字、类型、限位、是否可控，另有 `gestures` / `presets` / `gaits` / `camera` |
| GET | `/state` | `t`、`mode`、关节角、底盘位姿、`gait`、`speed`、`base_dz`、`camera`、接触数、`stale` |
| GET | `/frame` | 单帧 JPEG；窗口模式下返回 503 |
| GET | `/stream` | MJPEG 流，可直接塞进 `<img>` |
| POST | `/cmd/pose` | `{pose:{关节名:弧度}, duration_ms}`，按 duration 限速过渡 |
| POST | `/cmd/gesture` | `{name, speed}`，清掉正在跑的步态 |
| POST | `/cmd/preset` | `{name}`，回站姿再叠加该预设 |
| POST | `/cmd/gait` | `{name: walk\|march\|off}` |
| POST | `/cmd/camera` | `{azimuth?, elevation?, distance?, reset?}` |
| POST | `/cmd/speed` | `{speed}`，0.2–3.0 夹紧 |
| POST | `/cmd/base` | `{vx,vy,wz}`，仅运动学模式 |
| POST | `/cmd/stop` | 清底盘速度、手势、步态与机身升降 |
| POST | `/cmd/reset` | `mj_resetData` 回初始姿态 |
| POST | `/cmd/mode` | `{mode: kinematic\|dynamic}` |

后端对外（`/api/v1`，写操作都要 `Idempotency-Key`）：

| 方法 | 路径 | 转发到 |
|---|---|---|
| GET | `/sim/state` `/sim/joints` `/sim/frame` | 同名接口，直接透传 |
| POST | `/control/joints` `{joints, duration_ms}` | `/cmd/pose` |
| POST | `/control/gesture` `{name}` | `/cmd/gesture` |
| POST | `/motion/base` `{vx,vy,wz}` | `/cmd/base`，线速度限幅 0.5 m/s、角速度 1.0 rad/s |
| POST | `/motion/stop` | `/cmd/stop` |
| POST | `/sim/reset` `/sim/mode` | `/cmd/reset` `/cmd/mode` |
| POST | `/sim/preset` `{name}` | `/cmd/preset` |
| POST | `/sim/gait` `{name}` | `/cmd/gait`，`off` 或空名表示停止 |
| POST | `/sim/camera` `{azimuth?, elevation?, distance?, reset?}` | `/cmd/camera` |
| POST | `/sim/speed` `{speed}` | `/cmd/speed` |
| POST | `/connections` `{robot_id:"q1-sim", mode:"sim"}` | 先探 `/health`，桥没起就返回 502 |

状态与画面是高频只读转发，刻意放在后端全局锁之外：仿真卡住时页面不会一起卡死。

## 启动方式

| 场景 | 命令 |
|---|---|
| 桥 + 后端一起起（推荐） | `bash scripts/run_sim_stack.sh`，Windows 也可以双击 `scripts\run_sim_stack.cmd` |
| 弹 MuJoCo 原生窗口看机器人 | `SIM_MODE=viewer bash scripts/run_sim_stack.sh`（此时网页没有画面） |
| 只要后端，连已在跑的桥 | `bash scripts/run_local.sh --sim` |
| 只要桥 | `python sim/mujoco_bridge.py --headless` |
| 改端口 | `PORT=8081 SIM_PORT=8091 bash scripts/run_sim_stack.sh` |

常用桥参数：

| 参数 | 默认 | 作用 |
|---|---|---|
| `--headless` | 关 | 不开窗口，离屏渲染出 JPEG 给网页 |
| `--dynamic` | 关 | 以动力学模式启动 |
| `--ctrl-hz` | 100 | 物理循环频率 |
| `--render-hz` | 20 | 出图上限；实际有请求才画，页面关掉就不占 CPU |
| `--shadows` | 关 | 打开阴影贴图，画面更立体，单帧渲染慢约 3 倍（69ms → 23ms） |
| `--width/--height` | 640×480 | 画面尺寸 |
| `--azimuth/--elevation` | 200 / -5 | 视角；180 是正脸，0 是背面 |
| `--distance` | 0 | 0 表示按本体高度自动取景 |
| `--joint-speed` | 3.0 | 运动学模式关节最大角速度 rad/s |
| `--watchdog-s` | 0.5 | 断流多久后底盘清零 |

## 已知边界

- **窗口模式没有网页画面**。GLFW 窗口和离屏渲染抢同一个 GL 上下文，所以 `SIM_MODE=viewer` 时 `/frame` 明确返回 503，页面只给数值和滑块。
- **WSL 里开窗口需要 WSLg**（Win11 自带）。无显示设备时用 `--headless`；离屏渲染报 GL 错误时依次试 `MUJOCO_GL=egl` 和 `MUJOCO_GL=osmesa`。Windows 原生运行不要设 `MUJOCO_GL`，设了反而报错。
- **底盘是运动学积分**：不走轮子或足端动力学，不会打滑也不会被台阶挡住。
- **没有认证**：桥只监听 `127.0.0.1`，不要改成 `0.0.0.0` 暴露到局域网。
- **后端默认仍是 mock**：不给 `--sim-url` 时 `/motion`、`/control` 继续返回 422，`robot_executed` 保持 false，现有测试不受影响。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 连接仿真报 502 SIM_UNAVAILABLE | 桥没起或端口不对 | `curl 127.0.0.1:8090/health` 先确认 |
| 报 `Unexpected end of JSON input` 或「返回空响应」 | 页面不是从后端 8080 打开的（file:// 或别的静态服务器），请求打到了没有接口的那一端 | 直接开 `http://127.0.0.1:8080/ui/PrrimebotX.html`；若必须用别的端口打开，加 `?api=http://127.0.0.1:8080/api/v1`（后端已对 localhost 来源放开 CORS） |
| 报 422 SIM_NOT_CONFIGURED | 后端没带 `--sim-url` | 用 `run_sim_stack.sh` 或 `run_local.sh --sim` |
| 页面只有数值没有画面 | 桥跑在窗口模式，或离屏渲染不可用 | 换 `--headless`；看桥启动日志里的 warn |
| 点按钮没反应，弹窗里报 ROBOT_NOT_READY | 还没建立仿真连接 | 先点「连接仿真」 |
| 模型加载报 XML 解析错误 | 路径含中文，或 `meshes/` 没一起拷 | 模型放纯英文路径，且保留 `xml/` 与 `meshes/` 同级结构 |
| MSVC 报 C2001 常量中有换行符 | 源码是 UTF-8，MSVC 默认按 GBK 读 | 编译加 `/utf-8`；`CMakeLists.txt` 已带 |
