# PrimebotX 后端

C++17 + cpp-httplib + nlohmann/json；SQLite 保存账号、页面会话和用户状态，libsodium 提供 Argon2id 密码哈希。默认只监听 `127.0.0.1`。

## 启动与测试

从仓库根目录启动完整本地服务：

```bash
python run.py
```

只需启动后端时，在仓库根目录执行：

```bash
bash scripts/run_web.sh
```

另一个终端运行测试：

```bash
ctest --test-dir backend-build --output-on-failure
```

启动后打开 <http://localhost:8080/ui/PrimebotX.html>。默认数据库为 `~/primebotx_ws/data/primebotx.db`；`PORT`、`BUILD_DIR`、`DB_PATH` 可覆盖。直接启动程序时可用 `--port`、`--web-root`、`--db-path`、`--ai-url` 指定配置。

## 接口

统一前缀 `/api/v1`，JSON 响应为 `{request_id,data,error}`；失败时 `error` 包含 `code` 和 `message`。除注册、登录、健康检查与模型配置读取外，下列接口需要携带 `Authorization: Bearer <token>`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | 服务版本与健康检查 |
| `POST /auth/register` | username、password、可选 display_name；成功返回 201，不自动登录 |
| `POST /auth/login` | 登录并返回 access_token、expires_in、user |
| `GET /auth/me` | 返回当前账号 |
| `GET /auth/state` | 返回当前账号保存的对话、外观与界面状态 |
| `PUT /auth/state` | 保存当前账号状态，JSON 上限 256KB |
| `POST /auth/logout` | 注销当前登录令牌 |
| `GET /browser/actions` | 返回公共浏览器动作目录 |
| `POST /browser/sessions` | 创建独立页面会话 |
| `GET /browser/sessions/{id}` | 查询页面最近一次授权动作 |
| `DELETE /browser/sessions/{id}` | 释放页面会话 |
| `POST /browser/sessions/{id}/actions` | 校验 action_id 并返回浏览器播放信息 |
| `POST /chat` | 经过当前账号认证的 AI 对话代理 |
| `POST /ai/speech` | 经过当前账号认证的语音合成代理 |
| `GET /ai/config` | 读取模型配置，不返回 API Key |
| `PUT /ai/config` | 更新模型配置，仅允许本机请求 |
| `POST /ai/models` | 获取模型服务返回的可用模型列表 |

用户名需为 3–24 位字母、数字或下划线，统一转为小写；密码需为 8–16 位可见 ASCII 字符；昵称最多 32 个字符。登录令牌有效 8 小时，注销后立即失效，数据库只保存令牌摘要。注册和登录带有请求限流。

常见错误码：400 参数错误、401 未登录或凭据错误、404 资源不存在、409 用户名重复、422 动作不可用、429 请求过频、503 AI 服务未配置。

## 前端接入

登录令牌保存在 `localStorage`，401 时清理并返回登录入口。账号状态以白名单保存近期对话、压缩后的头像、内置外观选择、界面偏好、自定义角色与快捷指令；API Key、头像原文件和导入模型文件不会进入账号状态。

每次页面加载创建新的 `session_id`，不共享页面状态；每个登录最多保留 20 个页面会话。动作请求示例为 `{"action_id":"raise_hand"}`。浏览器动作只返回播放信息，前端调用 `window.robot3d.playClip(clip, loop)` 执行；`robot-playback` 事件报告播放状态。

## AI 代理

`POST /api/v1/chat` 接收 `message`、最多 10 条 `history`，以及可选的 `persona` 角色设定（最多 1200 字）。响应包含 `reply`、兼容单动作的 `action_id`、最多四个 `actions`、`stop` 和模型名。

AI 返回的动作、姿态、视角和表情必须存在于 `assistant/capabilities.json`。模型配置通过 `GET/PUT /api/v1/ai/config` 同步到本地 AI 服务；API Key 不会通过读取接口返回，也不会保存在浏览器。

## 限制

- 当前不提供密码找回、邮箱验证或私人动作库。
- 后端默认仅供本机使用；公网部署需要 HTTPS、反向代理和部署侧安全配置。
- 首页 3D 机器人由浏览器动画数据驱动，不连接 ROS 2 或真实机器人设备。
- 自动测试覆盖认证持久化、账号状态、浏览器动作和 AI 代理。
- 可选浏览器验收：安装 Playwright 与 Chromium 后，运行 `python backend/tests/browser_test.py <后端程序绝对路径>`。
