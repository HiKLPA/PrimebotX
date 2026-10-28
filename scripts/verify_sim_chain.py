#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端验收：网页后端 → MuJoCo 仿真桥。

只依赖标准库，不改任何状态，只按顺序打一遍真实接口，逐步打印结论。
用法（后端与仿真桥都跑起来之后）：
    python scripts/verify_sim_chain.py
    python scripts/verify_sim_chain.py --backend http://127.0.0.1:8080

退出码 0 表示全链路通，1 表示有步骤失败（会打印具体响应）。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

PASS, FAIL = "PASS", "FAIL"


class Chain:
    def __init__(self, backend: str) -> None:
        self.base = backend.rstrip("/") + "/api/v1"
        self.failures: list[str] = []

    def call(self, method: str, path: str, body: dict | None = None, raw: bool = False):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        if method != "GET":
            request.add_header("Idempotency-Key", str(uuid.uuid4()))
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        payload = response.read()
        if raw:
            return response.status, payload
        try:
            return response.status, json.loads(payload)
        except json.JSONDecodeError:
            return response.status, {"raw": payload[:200].decode("utf-8", "replace")}

    def step(self, name: str, ok: bool, detail: str = "") -> bool:
        print(f"  [{PASS if ok else FAIL}] {name}{'  ' + detail if detail else ''}")
        if not ok:
            self.failures.append(name)
        return ok

    def wait_state(self, predicate, timeout: float = 3.0, interval: float = 0.1):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            status, body = self.call("GET", "/sim/state")
            if status == 200:
                last = body["data"]
                if predicate(last):
                    return last
            time.sleep(interval)
        return last


def main() -> int:
    parser = argparse.ArgumentParser(description="PrimebotX ↔ MuJoCo 全链路验收")
    parser.add_argument("--backend", default="http://127.0.0.1:8080")
    args = parser.parse_args()
    chain = Chain(args.backend)

    print("1. 后端与仿真配置")
    status, body = chain.call("GET", "/health")
    data = body.get("data") or {}
    chain.step("后端在线", status == 200, f"HTTP {status}")
    chain.step(
        "后端已挂仿真（--sim-url）",
        bool(data.get("sim_enabled")),
        "未启用仿真时请重启后端并加 --sim-url http://127.0.0.1:8090",
    )
    if chain.failures:
        print("\n后端没准备好，后面的检查没有意义，先解决上面这条。")
        return 1

    print("\n2. 机型列表与仿真连接")
    status, body = chain.call("GET", "/robots")
    ids = [r.get("robot_id") for r in body.get("data", [])]
    chain.step("列表里有 q1-sim", "q1-sim" in ids, str(ids))
    status, body = chain.call("POST", "/connections", {"robot_id": "q1-sim", "mode": "sim"})
    op = (body.get("data") or {})
    chain.step(
        "建立仿真连接",
        status == 200 and op.get("state") == "applied" and op.get("robot_executed") is True,
        f"HTTP {status} {op.get('error') or op.get('state')}",
    )

    print("\n3. 模型与关节表")
    status, body = chain.call("GET", "/sim/joints")
    table = body.get("data") or {}
    chain.step("读到关节表", status == 200, f"nq={table.get('nq')} nv={table.get('nv')}")
    chain.step(
        "q1_v3_mc 规格 29 / 28",
        table.get("nq") == 29 and table.get("nv") == 28,
        "对不上说明 --xml 指的不是 q1_v3_mc.xml",
    )
    gesture_ids = {g.get("id") for g in table.get("gestures") or []}
    chain.step("手势库可用", gesture_ids >= {"wave", "heart", "cheer"}, str(sorted(gesture_ids)))
    chain.step("姿态预设可用", {p.get("id") for p in table.get("presets") or []} >= {"stand", "tpose", "squat"}, "")
    chain.step("步态可用", {g.get("id") for g in table.get("gaits") or []} >= {"walk", "march"}, "")

    print("\n4. 关节控制")
    target = 1.1
    status, body = chain.call(
        "POST",
        "/control/joints",
        {"joints": {"right_shoulder_pitch_joint": target}, "duration_ms": 300},
    )
    chain.step("下发关节目标", status == 200 and (body.get("data") or {}).get("state") == "applied", f"HTTP {status}")
    state = chain.wait_state(
        lambda s: abs(s["joints"].get("right_shoulder_pitch_joint", 0) - target) < 0.12
    )
    got = (state or {}).get("joints", {}).get("right_shoulder_pitch_joint")
    chain.step("关节运动到位", got is not None and abs(got - target) < 0.12, f"目标 {target} 实际 {got}")

    print("\n5. 手势")
    status, body = chain.call("POST", "/control/gesture", {"name": "wave"})
    chain.step("触发挥手", status == 200, f"HTTP {status}")
    state = chain.wait_state(lambda s: s.get("gesture") == "wave")
    chain.step("状态里能看到 gesture=wave", (state or {}).get("gesture") == "wave")

    print("\n6. 底盘与转向")
    before = chain.wait_state(lambda s: True)
    start_x = (before or {}).get("base", {}).get("x", 0.0)
    start_qz = abs((before or {}).get("base", {}).get("quat", [1, 0, 0, 0])[3])
    # 页面按住方向键时是 10Hz 续发，这里模拟同样的节奏
    for _ in range(6):
        chain.call("POST", "/motion/base", {"vx": 0.3, "vy": 0.0, "wz": 0.5})
        time.sleep(0.1)
    chain.call("POST", "/motion/stop", {})
    after = chain.wait_state(lambda s: True)
    moved = (after or {}).get("base", {}).get("x", 0.0) - start_x
    turned = abs((after or {}).get("base", {}).get("quat", [1, 0, 0, 0])[3]) > start_qz + 0.02
    chain.step("底盘前移", moved > 0.05, f"Δx={moved:.3f} m")
    chain.step("底盘转向", turned, "绕 z 轴quad分量有变化")

    print("\n7. 急停与看门狗")
    stopped = chain.wait_state(lambda s: True)
    time.sleep(0.6)
    later = chain.wait_state(lambda s: True)
    drift = abs((later or {}).get("base", {}).get("x", 0.0) - (stopped or {}).get("base", {}).get("x", 0.0))
    chain.step("stop 之后不再移动", drift < 0.01, f"Δx={drift:.4f} m")

    print("\n8. 画面")
    status, blob = chain.call("GET", "/sim/frame", raw=True)
    jpeg = blob[:2] == b"\xff\xd8"
    chain.step("取到 JPEG 帧", status == 200 and jpeg, f"HTTP {status} {len(blob)} 字节")

    print("\n9. 两种驱动模式")
    status, body = chain.call("POST", "/sim/mode", {"mode": "dynamic"})
    chain.step("切到动力学", status == 200, f"HTTP {status}")
    state = chain.wait_state(lambda s: s.get("mode") == "dynamic")
    chain.step("状态显示 dynamic", (state or {}).get("mode") == "dynamic")
    status, body = chain.call("POST", "/sim/mode", {"mode": "kinematic"})
    state = chain.wait_state(lambda s: s.get("mode") == "kinematic")
    chain.step("切回运动学", (state or {}).get("mode") == "kinematic")

    print("\n10. 姿态预设、步态、视角与速度")
    status, body = chain.call("POST", "/sim/preset", {"name": "squat"})
    chain.step("切换姿态 squat", status == 200, f"HTTP {status}")
    # 容差 0.06 逼它真的走完 500ms 过渡，0.15 会在半路就判过
    state = chain.wait_state(
        lambda s: abs(s.get("joints", {}).get("left_knee_joint", 0) - 0.8) < 0.06
        and abs(((s.get("base") or {}).get("z") or 0) - 0.314) < 0.02
    )
    knee = (state or {}).get("joints", {}).get("left_knee_joint")
    base_z = ((state or {}).get("base") or {}).get("z")
    chain.step("屈膝到位", knee is not None and abs(knee - 0.8) < 0.06, f"膝 {knee}")
    chain.step("机身随预设下沉", base_z is not None and abs(base_z - 0.314) < 0.02, f"base.z={base_z}")

    status, body = chain.call("POST", "/sim/gait", {"name": "walk"})
    chain.step("启动步态 walk", status == 200, f"HTTP {status}")
    state = chain.wait_state(lambda s: s.get("gait") == "walk")
    chain.step("状态里能看到 gait=walk", (state or {}).get("gait") == "walk")
    time.sleep(0.4)
    first = (chain.wait_state(lambda s: True) or {}).get("joints", {}).get("left_hip_pitch_joint")
    time.sleep(0.45)
    second = (chain.wait_state(lambda s: True) or {}).get("joints", {}).get("left_hip_pitch_joint")
    swing = abs((first or 0) - (second or 0))
    chain.step("腿部在交替摆动", swing > 0.05, f"hip {first} → {second}")
    status, body = chain.call("POST", "/sim/gait", {"name": "off"})
    state = chain.wait_state(lambda s: not s.get("gait"))
    chain.step("停止步态", status == 200 and not (state or {}).get("gait"), f"HTTP {status}")

    status, body = chain.call("POST", "/sim/camera", {"azimuth": 150, "elevation": -10, "distance": 1.6})
    state = chain.wait_state(lambda s: (s.get("camera") or {}).get("azimuth") == 150)
    cam = (state or {}).get("camera") or {}
    chain.step("设置视角", status == 200 and cam.get("azimuth") == 150, str(cam))
    chain.call("POST", "/sim/camera", {"reset": True})
    state = chain.wait_state(lambda s: (s.get("camera") or {}).get("azimuth") != 150)
    chain.step("视角复位", (state or {}).get("camera") is not None, str((state or {}).get("camera")))

    status, body = chain.call("POST", "/sim/speed", {"speed": 1.5})
    state = chain.wait_state(lambda s: abs(s.get("speed", 0) - 1.5) < 0.01)
    chain.step("设置速度倍率", status == 200 and abs((state or {}).get("speed", 0) - 1.5) < 0.01, f"{status}")
    chain.call("POST", "/sim/speed", {"speed": 1.0})
    chain.call("POST", "/sim/preset", {"name": "stand"})

    print("\n11. 网页静态资源")
    page = args.backend.rstrip("/") + "/ui/PrrimebotX.html"
    try:
        with urllib.request.urlopen(page, timeout=5) as response:
            html = response.read().decode("utf-8", "replace")
            ok = response.status == 200 and "data-sim-frame" in html
    except (urllib.error.URLError, urllib.error.HTTPError) as error:
        ok, html = False, str(error)
    chain.step("页面能打开且含仿真面板", ok, page)

    chain.call("DELETE", "/connection")

    print()
    if chain.failures:
        print(f"结果：{len(chain.failures)} 项未通过 → " + "；".join(chain.failures))
        return 1
    print("结果：全链路通过。打开 http://127.0.0.1:8080/ui/PrrimebotX.html 点顶栏 Advance。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
