#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Q1 MuJoCo 仿真桥。

把 q1_v3_mc.xml 的仿真实例包装成 HTTP 接口，供 C++ 后端转发网页指令。
两种驱动模式，对应 part3 文档里说的两类用法：

  kinematic  只改 qpos + mj_forward，不跑 mj_step。机器人不会因重力瘫倒，
             适合摆姿势、挥手、网页滑块调试。默认。
  dynamic    走 mj_step，用 qfrc_applied 做 PD 保持。没有站立控制器时
             机器人会倒，属于正常的物理结果，不是 bug。

启动：
    python mujoco_bridge.py --xml ../q1-urdf/xml/q1_v3_mc.xml --viewer
    python mujoco_bridge.py --xml ../q1-urdf/xml/q1_v3_mc.xml --headless

窗口模式（--viewer）用 GLFW 开原生窗口，物理循环在主线程并每帧 sync，
此时 /frame 返回 503，页面只能看数值。无窗口模式（--headless）在主线程
离屏渲染成 JPEG 供网页 <img> 取图。
"""

from __future__ import annotations

import argparse
import io
import json
import math
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
import mujoco

STATE_LOCK = threading.RLock()


def scan_joints(model: mujoco.MjModel):
    """抽出所有铰链关节的 qpos 地址与限位。freejoint 单独处理，不算可控关节。"""
    qadr: dict[str, int] = {}
    dofadr: dict[str, int] = {}
    ranges: dict[str, list[float] | None] = {}
    for i in range(model.njnt):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, i)
        if not name or model.jnt_type[i] != mujoco.mjtJoint.mjJNT_HINGE:
            continue
        qadr[name] = int(model.jnt_qposadr[i])
        dofadr[name] = int(model.jnt_dofadr[i])
        ranges[name] = (
            [float(model.jnt_range[i][0]), float(model.jnt_range[i][1])]
            if model.jnt_limited[i]
            else None
        )
    return qadr, dofadr, ranges


def joint_table(model: mujoco.MjModel, xml_path: str, qadr: dict, ranges: dict) -> dict:
    rows = []
    for i in range(model.njnt):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, i)
        if not name:
            continue
        rows.append(
            {
                "name": name,
                "type": {
                    mujoco.mjtJoint.mjJNT_HINGE: "hinge",
                    mujoco.mjtJoint.mjJNT_SLIDE: "slide",
                    mujoco.mjtJoint.mjJNT_FREE: "free",
                }.get(int(model.jnt_type[i]), "other"),
                "range": [round(v, 3) for v in ranges[name]] if ranges.get(name) else None,
                "controllable": name in qadr,
            }
        )
    return {
        "model": xml_path,
        "nq": int(model.nq),
        "nv": int(model.nv),
        "nu": int(model.nu),
        "njnt": int(model.njnt),
        "total_mass": round(float(sum(model.body_mass)), 3),
        "joints": rows,
        "gestures": [{"id": k, "label": GESTURES[k].get("label", k)} for k in sorted(GESTURES)],
    }


class Sim:
    """仿真状态机。HTTP 线程只写 target，物理线程独占 model/data。"""

    def __init__(self, xml_path: str, args: argparse.Namespace) -> None:
        self.model = mujoco.MjModel.from_xml_path(xml_path)
        self.data = mujoco.MjData(self.model)
        mujoco.mj_resetData(self.model, self.data)
        mujoco.mj_forward(self.model, self.data)

        self.args = args
        self.mode = "dynamic" if args.dynamic else "kinematic"
        self.xml_path = xml_path
        self.running = True
        self.headless = args.headless
        self.joint_speed = args.joint_speed
        self.ctrl_hz = args.ctrl_hz
        self.kp = args.kp
        self.kd = args.kd

        # 关节名 -> qpos / dof 地址。freejoint 的 7 个位置量单独处理。
        self.hinge_qadr, self.hinge_dofadr, self.hinge_range = scan_joints(self.model)

        self.free_qadr: int | None = None
        for i in range(self.model.njnt):
            if self.model.jnt_type[i] == mujoco.mjtJoint.mjJNT_FREE:
                self.free_qadr = int(self.model.jnt_qposadr[i])
                break

        # 站姿基准：保留模型初始 qpos，只记录一份，reset 用它复原。
        self.home_qpos = np.array(self.data.qpos, copy=True)
        self.home_base = np.zeros(2)
        self.home_z = 0.0
        if self.free_qadr is not None:
            self.home_base = np.array(
                [float(self.data.qpos[self.free_qadr]), float(self.data.qpos[self.free_qadr + 1])]
            )
            self.home_z = float(self.data.qpos[self.free_qadr + 2])
        self.focus = np.array([0.0, 0.0, 0.4])   # 渲染时按本体包围盒覆盖
        # 一启动就把手臂放下来：模型默认是前臂朝前的僵尸手。写进 qpos 的同时
        # 也写进 home_qpos，启动画面和复位之后看到的是同一个站姿
        for _name, _value in ARM_REST.items():
            _adr = self.hinge_qadr.get(_name)
            if _adr is not None:
                self.data.qpos[_adr] = _value
                self.home_qpos[_adr] = _value
        mujoco.mj_forward(self.model, self.data)
        self.target = {n: float(self.data.qpos[a]) for n, a in self.hinge_qadr.items()}
        self.slew = {n: self.joint_speed for n in self.hinge_qadr}
        self.base_cmd = np.zeros(3)      # vx, vy, wz（kinematic 下按机体系积分）
        self.yaw = 0.0
        self.gesture: dict | None = None
        self.gait: dict | None = None
        self.base_dz = 0.0             # 预设姿态带来的机身升降，仅 kinematic 生效
        self.speed = 1.0               # 动作倍率，影响手势/步态相位与关节限速
        self.last_cmd_at = time.time()
        self.sim_time = 0.0
        self.step_count = 0
        self.frame: bytes | None = None
        self.frame_seq = 0
        # 出图改成「有请求才画」：页面关掉或弹窗收起时不再空转占 CPU。
        # demand 由 /frame 与 /stream 置位，物理循环画完一帧就清掉
        self.demand = False
        self.frame_cv = threading.Condition()
        self.last_render = 0.0          # 上一帧的时刻，用来按 render_hz 限速
        self.renderer = None
        self.camera = None
        self.cam_home: tuple[float, float, float] | None = None
        self.error: str | None = None
        if self.headless:
            self._init_renderer()

    # ---------- 渲染 ----------

    def _body_bbox(self) -> tuple[np.ndarray, np.ndarray]:
        """按刚体位置算包围盒。模型自带地面，model.stat.center 会被地面拉偏，
        所以取景必须只看机器人本体。"""
        pts = []
        for i in range(self.model.nbody):
            name = mujoco.mj_id2name(self.model, mujoco.mjtObj.mjOBJ_BODY, i)
            if not name or name == "world":
                continue
            pts.append(np.array(self.data.xpos[i], copy=True))
        if not pts:
            return np.zeros(3), np.zeros(3)
        arr = np.array(pts)
        return arr.min(axis=0), arr.max(axis=0)

    def _lookat(self) -> np.ndarray:
        """取景中心跟随底盘平移，机器人走到哪画面就跟到哪。"""
        point = np.array(self.focus, copy=True)
        if self.free_qadr is not None:
            adr = self.free_qadr
            point[0] += float(self.data.qpos[adr]) - self.home_base[0]
            point[1] += float(self.data.qpos[adr + 1]) - self.home_base[1]
        return point

    def _init_renderer(self) -> None:
        try:
            self.renderer = mujoco.Renderer(self.model, self.args.height, self.args.width)
            # 阴影贴图每帧要多跑一遍 pass：实测 640×480 下 23ms 变 69ms，
            # 离屏小画面里那点接触阴影不值这个价，默认关掉；要立体感加 --shadows
            self.renderer.scene.flags[mujoco.mjtRndFlag.mjRND_SHADOW] = bool(
                getattr(self.args, "shadows", False))
            lo, hi = self._body_bbox()
            self.focus = (lo + hi) / 2.0
            span = float(max(hi[2] - lo[2], 0.4))
            cam = mujoco.MjvCamera()
            cam.lookat[:] = self.focus
            # 45° 视场下人物约占画面一半：要留出双手举过头顶的余量
            cam.distance = self.args.distance or max(1.2, span * 2.35)
            cam.azimuth = self.args.azimuth
            cam.elevation = self.args.elevation
            self.camera = cam
            # 记下开机那套机位，相机复位才有得回
            self.cam_home = (float(cam.azimuth), float(cam.elevation), float(cam.distance))
        except Exception as exc:  # 没有可用的 GL 后端时降级为纯数值模式
            self.renderer = None
            self.error = f"离屏渲染不可用：{exc}"
            print(f"[warn] {self.error}", file=sys.stderr)

    def _render(self) -> None:
        if self.renderer is None:
            return
        try:
            self.camera.lookat[:] = self._lookat()
            self.renderer.update_scene(self.data, self.camera)
            pixels = self.renderer.render()
            from PIL import Image

            buf = io.BytesIO()
            Image.fromarray(pixels).save(buf, format="JPEG", quality=self.args.quality)
            self.frame = buf.getvalue()
            self.frame_seq += 1
            self.last_render = time.perf_counter()
            with self.frame_cv:
                self.frame_cv.notify_all()
        except Exception as exc:
            self.error = f"渲染失败：{exc}"
            self.renderer = None

    # ---------- 指令 ----------

    def set_mode(self, mode: str) -> None:
        if mode not in ("kinematic", "dynamic"):
            raise ValueError("mode 只能是 kinematic 或 dynamic")
        self.mode = mode
        if mode == "kinematic":
            self.base_cmd[:] = 0.0

    def reset(self) -> None:
        mujoco.mj_resetData(self.model, self.data)
        # mj_resetData 会把关节全推回模型默认值，手臂于是又变成前臂朝前的样子，
        # 这里补上自然下垂那一档，复位后手臂垂在体侧
        for name, value in ARM_REST.items():
            adr = self.hinge_qadr.get(name)
            if adr is not None:
                self.data.qpos[adr] = value
        mujoco.mj_forward(self.model, self.data)
        self.sim_time = 0.0
        self.step_count = 0
        self.gesture = None
        self.gait = None
        self.base_dz = 0.0
        self.base_cmd[:] = 0.0
        self.yaw = 0.0
        self.target = {n: float(self.data.qpos[a]) for n, a in self.hinge_qadr.items()}
        self.slew = {n: self.joint_speed for n in self.hinge_qadr}

    def apply_pose(self, pose: dict, duration_ms: float) -> list[str]:
        """写入关节目标。未在模型里的名字跳过，返回真正的命中列表。"""
        applied: list[str] = []
        seconds = max(0.05, duration_ms / 1000.0)
        for name, value in pose.items():
            adr = self.hinge_qadr.get(name)
            if adr is None:
                continue
            lo_hi = self.hinge_range.get(name)
            angle = float(value)
            if lo_hi:
                angle = min(lo_hi[1], max(lo_hi[0], angle))
            self.target[name] = angle
            # 按 duration 摊开：一次大幅跳变被拆成若干小步，页面滑块不会瞬移；
            # 再乘全局倍率，让滑块与姿态预设跟手势、步态用同一个速度条
            delta = abs(angle - float(self.data.qpos[adr]))
            self.slew[name] = max(0.2 * self.speed,
                                  min(8.0 * self.speed, delta * self.speed / seconds))
            applied.append(name)
        self.last_cmd_at = time.time()
        self.gesture = None
        self.gait = None
        return applied

    def apply_gesture(self, name: str, speed: float) -> None:
        if name not in GESTURES:
            raise ValueError(f"未知动作：{name}")
        missing = [j for j in GESTURES[name]["pose"] if j not in self.hinge_qadr]
        if missing:
            raise ValueError("模型缺少关节：" + ", ".join(missing))
        self.gesture = {"name": name, "speed": float(speed), "t0": time.time()}
        self.gait = None
        self.last_cmd_at = time.time()

    def apply_preset(self, name: str) -> dict:
        """预设姿态：先回站姿再叠加，避免上一组关节残留（比如蹲下之后直接平举）。"""
        if name not in PRESETS:
            raise ValueError(f"未知姿态：{name}，可选 {', '.join(PRESETS)}")
        preset = PRESETS[name]
        self.gesture = None
        self.gait = None
        rest = {n: 0.0 for n in self.hinge_qadr}
        rest.update({k: float(v) for k, v in preset["pose"].items() if k in self.hinge_qadr})
        applied = self.apply_pose(rest, 500)
        self.base_dz = float(preset.get("base_dz", 0.0)) if self.mode == "kinematic" else 0.0
        self.last_cmd_at = time.time()
        return {"applied": applied, "base_dz": self.base_dz}

    def apply_gait(self, name: str) -> None:
        if name not in GAITS:
            raise ValueError(f"未知步态：{name}，可选 {', '.join(GAITS)}")
        self.gesture = None
        # 步态只写腿和肩 pitch，所以先把上半身摆回体侧、机身高度归零，
        # 否则从「举手」或「半蹲」切过来会一直举着手、低着走。
        # 肘角分两档，写在 GAITS 里：走路把肘弯到底（前臂贴着大臂垂下），
        # 跑步反过来把肘留在 0 附近 —— 模型的前臂本来就跟大臂成 90°，
        # 肩微外张后略作负角补偿正好回到 90°（偏 0.1°）
        elbow = float(GAITS[name]["elbow"])
        for side in ("left", "right"):
            self._set_target(f"{side}_shoulder_roll_joint", 0.22 if side == "left" else -0.22)
            self._set_target(f"{side}_shoulder_yaw_joint", 0.0)
            self._set_target(f"{side}_elbow_joint", elbow)
        self._set_target("waist_roll_joint", 0.0)
        self._set_target("waist_yaw_joint", 0.0)
        self.base_dz = 0.0
        self.gait = {"name": name, "t0": time.time()}
        self.last_cmd_at = time.time()

    def set_camera(self, body: dict) -> dict:
        """调视角。没传的字段保持原值；reset=true 回到启动参数那套。"""
        if self.camera is None:
            raise ValueError("当前没有渲染相机（窗口模式或离屏渲染不可用）")
        if body.get("reset"):
            az, el, dist = self.cam_home or (self.args.azimuth, self.args.elevation, 1.9)
            self.camera.azimuth = az
            self.camera.elevation = el
            self.camera.distance = dist
        for key, limit in (("azimuth", None), ("elevation", (-89.0, 89.0)), ("distance", (0.4, 8.0))):
            if key not in body:
                continue
            value = float(body[key])
            if limit:
                value = min(limit[1], max(limit[0], value))
            setattr(self.camera, key, value)
        return self.camera_state()

    def camera_state(self) -> dict | None:
        if self.camera is None:
            return None
        return {
            "azimuth": round(float(self.camera.azimuth), 1),
            "elevation": round(float(self.camera.elevation), 1),
            "distance": round(float(self.camera.distance), 2),
        }

    def set_speed(self, value: float) -> float:
        self.speed = min(3.0, max(0.2, float(value)))
        return self.speed

    def stop(self) -> None:
        self.base_cmd[:] = 0.0
        self.gesture = None
        self.gait = None
        self.base_dz = 0.0
        self.target = {n: float(self.data.qpos[a]) for n, a in self.hinge_qadr.items()}
        self.last_cmd_at = time.time()

    # ---------- 物理 ----------

    def step(self, dt: float) -> None:
        with STATE_LOCK:
            # 底盘速度不做持久化：页面每 100ms 续一次，断流就自己停。
            # 关标签页、切网络、后端崩掉都不会让机器人一直走。
            if time.time() - self.last_cmd_at > self.args.watchdog_s and not np.allclose(self.base_cmd, 0.0):
                self.base_cmd[:] = 0.0
            if self.gesture is not None:
                t = (time.time() - self.gesture["t0"]) * self.speed
                pose = GESTURES[self.gesture["name"]]["pose"]
                osc = GESTURES[self.gesture["name"]].get("osc", {})
                for joint, value in pose.items():
                    # osc 是 (幅值, 角频率) 或 (幅值, 角频率, 初相)：
                    # 双手动作要靠初相把左右错开半个周期，才不会像镜像同步
                    spec = osc.get(joint, (0.0, 0.0))
                    amp, omega = spec[0], spec[1]
                    phase = spec[2] if len(spec) > 2 else 0.0
                    self._set_target(joint, value + amp * math.sin(omega * t + phase))
                for joint in pose:
                    self.slew[joint] = 6.0 * self.speed
            elif self.gait is not None:
                self._drive_gait()

            if self.mode == "kinematic":
                self._step_kinematic(dt)
            else:
                self._step_dynamic(dt)
            self.sim_time += dt
            self.step_count += 1

    def _set_target(self, joint: str, angle: float) -> None:
        """写目标角，先按模型限位夹紧。关节不在模型里就静默跳过。"""
        if joint not in self.target:
            return
        lo_hi = self.hinge_range.get(joint)
        if lo_hi:
            angle = min(lo_hi[1], max(lo_hi[0], angle))
        self.target[joint] = angle

    def _drive_gait(self) -> None:
        """正弦步态：左右腿差 π 相位，膝在摆动相屈起，手臂反向摆，腰跟着扭。"""
        g = GAITS[self.gait["name"]]
        phase = 2 * math.pi * g["freq"] * (time.time() - self.gait["t0"]) * self.speed
        for side, off in (("left", 0.0), ("right", math.pi)):
            p = phase + off
            knee = g["knee"] * (0.5 - 0.5 * math.cos(p))
            self._set_target(f"{side}_hip_pitch_joint", g["hip"] * math.sin(p))
            self._set_target(f"{side}_knee_joint", knee)
            # 踝反向补偿，脚掌尽量保持水平
            self._set_target(f"{side}_ankle_pitch_joint", -0.45 * knee)
            # 摆臂必须与同侧腿反相：髋与肩的 pitch 轴同向（正角都往后），
            # 所以同一条腿的值取负号，手臂就摆到相反一侧，不会顺拐。
            # 左右腿本身差 π，负号一加，两臂自然也是一前一后
            self._set_target(f"{side}_shoulder_pitch_joint", -g["arm"] * math.sin(p))
        self._set_target("waist_yaw_joint", g["waist"] * math.sin(phase))
        # 摆臂的角速度按各自的幅值与频率算：跑步 1.8 Hz、幅值 0.5 时峰值已经
        # 超过 5 rad/s，沿用站姿的 joint_speed 会把手臂削成一个几乎不动的小晃
        arm_rate = 2 * math.pi * g["freq"] * g["arm"] * 1.6
        for name in self.hinge_qadr:
            if name.endswith(("hip_pitch_joint", "knee_joint", "ankle_pitch_joint")):
                self.slew[name] = max(self.slew[name], 5.0 * self.speed)
            elif name.endswith("shoulder_pitch_joint"):
                self.slew[name] = max(self.slew[name], arm_rate * self.speed)

    def _step_kinematic(self, dt: float) -> None:
        for name, adr in self.hinge_qadr.items():
            cur = float(self.data.qpos[adr])
            delta = self.target[name] - cur
            limit = self.slew[name] * dt
            self.data.qpos[adr] = cur + max(-limit, min(limit, delta))
        if self.free_qadr is not None:
            adr = self.free_qadr
            vx, vy, wz = (float(v) for v in self.base_cmd[:3])
            # 指令按机体系给出：vx 沿朝向，vy 指向左侧，wz 绕 z 轴自转
            self.yaw = math.remainder(self.yaw + wz * dt, 2 * math.pi)
            cos_y, sin_y = math.cos(self.yaw), math.sin(self.yaw)
            self.data.qpos[adr] += (vx * cos_y - vy * sin_y) * dt
            self.data.qpos[adr + 1] += (vx * sin_y + vy * cos_y) * dt
            # 机身高度按预设平滑升降（下蹲要把机身一起压下去，否则脚会离地）
            want_z = self.home_z + self.base_dz
            cur_z = float(self.data.qpos[adr + 2])
            step_z = 0.6 * dt
            self.data.qpos[adr + 2] = cur_z + max(-step_z, min(step_z, want_z - cur_z))
            half = self.yaw / 2.0
            self.data.qpos[adr + 3 : adr + 7] = [math.cos(half), 0.0, 0.0, math.sin(half)]
        mujoco.mj_forward(self.model, self.data)

    def _step_dynamic(self, dt: float) -> None:
        self.data.qfrc_applied[:] = 0.0
        for name, dof in self.hinge_dofadr.items():
            adr = self.hinge_qadr[name]
            error = self.target[name] - float(self.data.qpos[adr])
            self.data.qfrc_applied[dof] = self.kp * error - self.kd * float(self.data.qvel[dof])
        mujoco.mj_step(self.model, self.data)

    # ---------- 快照 ----------

    def snapshot(self) -> dict:
        with STATE_LOCK:
            joints = {n: round(float(self.data.qpos[a]), 4) for n, a in self.hinge_qadr.items()}
            base = None
            if self.free_qadr is not None:
                adr = self.free_qadr
                base = {
                    "x": round(float(self.data.qpos[adr]), 4),
                    "y": round(float(self.data.qpos[adr + 1]), 4),
                    "z": round(float(self.data.qpos[adr + 2]), 4),
                    "quat": [round(float(v), 4) for v in self.data.qpos[adr + 3 : adr + 7]],
                }
            return {
                "t": round(self.sim_time, 3),
                "step": self.step_count,
                "mode": self.mode,
                "headless": self.headless,
                "frame_seq": self.frame_seq,
                "stale": round(time.time() - self.last_cmd_at, 3),
                "gesture": self.gesture["name"] if self.gesture else None,
                "gait": self.gait["name"] if self.gait else None,
                "speed": round(float(self.speed), 2),
                "base_dz": round(float(self.base_dz), 3),
                "camera": self.camera_state(),
                "base": base,
                "joints": joints,
                "contact_count": int(self.data.ncon),
                "render": self.error is None,
            }

    def joint_table(self) -> dict:
        table = joint_table(self.model, self.xml_path, self.hinge_qadr, self.hinge_range)
        table["presets"] = [{"id": k, "label": v["label"]} for k, v in PRESETS.items()]
        table["gaits"] = [{"id": k, "label": v["label"], "freq": v["freq"]} for k, v in GAITS.items()]
        table["camera"] = self.camera_state()
        return table


# 动作库。所有角度都落在 q1_v3_mc.xml 的实际限位内（见 --print-joints 的输出），
# 数值不是估的：每个姿势都拿正运动学验过 —— 手腕落点、小臂方向、肘部夹角、
# 掌心朝向都打印出来对过。这台机器人的前臂够不到身体中线，所以比心做成
# 双手举过头顶、指尖朝头顶汇聚的版本，而不是胸前合掌。
GESTURES: dict[str, dict] = {
    # 挥手：单手（右手）。大臂侧平举、肘几乎伸直，小臂竖直向上、掌心朝前；
    # 摆动挂在 shoulder_roll 上 —— 那是绕前后轴的转动，整条手臂带着小臂在手侧左右摆，
    # 比用 yaw 更接近人手「摆手」，也不会把手掌转成翻腕。
    # 左臂显式写成垂在体侧：手不动的那条手臂不能被上一次动作的位置留下来
    "wave": {
        "label": "挥手",
        "pose": {
            "right_shoulder_pitch_joint": -2.95,
            "right_shoulder_roll_joint": -1.81,
            "right_shoulder_yaw_joint": 1.38,
            "right_elbow_joint": -0.14,
            "left_shoulder_pitch_joint": 0.0,
            "left_shoulder_roll_joint": 0.22,
            "left_shoulder_yaw_joint": 0.0,
            "left_elbow_joint": 1.45,
        },
        "osc": {"right_shoulder_roll_joint": (0.42, 6.0)},
    },
    # 比心：双手举到头顶两侧，小臂折向头顶，指尖朝向头顶正上方那一点、掌心朝前。
    # 这组角是从模型正运动学反解出来的：手腕落在 (±0.094, +0.910)，
    # 前臂方向 (-0.11, ∓0.83, +0.54)，与「手腕→头顶」的方向只差 21°，
    # 肘部约 93°，两只手在头顶上方围成一个心形
    "heart": {
        "label": "比心",
        "pose": {
            "left_shoulder_pitch_joint": -2.73,
            "right_shoulder_pitch_joint": -2.73,
            "left_shoulder_roll_joint": 0.80,
            "right_shoulder_roll_joint": -0.80,
            "left_shoulder_yaw_joint": -1.22,
            "right_shoulder_yaw_joint": 1.22,
            "left_elbow_joint": -0.2,
            "right_elbow_joint": -0.2,
        },
        "osc": {},
    },
    # 加油：单手（右手）高举到脸前上方，小臂朝前上，靠 shoulder_pitch 往复
    # 前后推，像举手敲门；左臂垂在体侧
    "cheer": {
        "label": "加油",
        "pose": {
            "right_shoulder_pitch_joint": -0.04,
            "right_shoulder_roll_joint": -2.39,
            "right_shoulder_yaw_joint": -0.76,
            "right_elbow_joint": 0.56,
            "left_shoulder_roll_joint": 0.25,
            "left_elbow_joint": 1.4,
        },
        "osc": {"right_shoulder_pitch_joint": (0.32, 6.5)},
    },
    # 双手同时挥：挥手的镜像，两条手臂由同一个正弦驱动，幅值取负（roll 的符号
    # 约定左右相反）就得到同一时刻的对称姿态 —— 一起向外张、一起向内收，
    # 世界坐标里方向相反，节奏完全同步。不要再加初相，那会让一臂升一臂降
    "wave_both": {
        "label": "双手挥",
        "pose": {
            "left_shoulder_pitch_joint": -2.95,
            "right_shoulder_pitch_joint": -2.95,
            "left_shoulder_roll_joint": 1.81,
            "right_shoulder_roll_joint": -1.81,
            "left_shoulder_yaw_joint": -1.38,
            "right_shoulder_yaw_joint": 1.38,
            "left_elbow_joint": -0.14,
            "right_elbow_joint": -0.14,
        },
        "osc": {
            "left_shoulder_roll_joint": (0.42, 6.0),
            "right_shoulder_roll_joint": (-0.42, 6.0),
        },
    },
    # 舞动：手臂收到体前屈肘，左右按不同频率上下摆，腰跟着扭；
    # 小臂单独再摆一层 —— 肘角跟着各自肩的节拍开合，前臂在体前画小圈，
    # 不是整条手臂僵着一起晃
    "dance": {
        "label": "舞动",
        "pose": {
            "left_shoulder_roll_joint": 0.55,
            "right_shoulder_roll_joint": -0.55,
            "left_shoulder_pitch_joint": -0.9,
            "right_shoulder_pitch_joint": -0.9,
            "left_elbow_joint": -0.25,
            "right_elbow_joint": -0.25,
            "waist_yaw_joint": 0.0,
        },
        "osc": {
            "left_shoulder_pitch_joint": (0.65, 3.0),
            "right_shoulder_pitch_joint": (0.65, 4.5),
            "left_elbow_joint": (0.45, 3.0),
            "right_elbow_joint": (0.45, 4.5),
            "waist_yaw_joint": (0.35, 3.0),
        },
    },
    # 伸懒腰：大臂举到竖直，小臂向后折 54°，双手落在头后 ——
    # 手腕 (±0.164, -0.098) 已经在后脑勺平面（头枕 x=-0.044）的后面，
    # 高度 0.948 也高过头顶 0.926；肩与肘再慢速小幅开合，像伸完舒展一下
    "stretch": {
        "label": "伸懒腰",
        "pose": {
            "left_shoulder_roll_joint": 0.22,
            "right_shoulder_roll_joint": -0.22,
            "left_shoulder_pitch_joint": -3.03,
            "right_shoulder_pitch_joint": -3.03,
            "left_shoulder_yaw_joint": -0.28,
            "right_shoulder_yaw_joint": 0.28,
            "left_elbow_joint": 0.48,
            "right_elbow_joint": 0.48,
        },
        "osc": {
            "left_shoulder_roll_joint": (0.06, 1.0),
            "right_shoulder_roll_joint": (-0.06, 1.0),
            "left_elbow_joint": (0.1, 1.0),
            "right_elbow_joint": (0.1, 1.0),
        },
    },
}

# 手臂自然下垂的那一组角。模型的前臂默认是向前平伸的（肘 0 就是僵尸手），
# 光把肩归零不会让手垂下来，必须把肘折到底、肩再微外张一点（±0.22 让手臂
# 离开躯干）。重置姿态和刚启动时的初始站姿共用这一份
ARM_REST: dict[str, float] = {
    "left_shoulder_roll_joint": 0.22,
    "right_shoulder_roll_joint": -0.22,
    "left_elbow_joint": 1.45,
    "right_elbow_joint": 1.45,
}

# 静态姿态预设。kinematic 下另带 base_dz：屈膝时把机身一起压下去，
# 否则脚会被抬离地面（qpos 里腿短了、机身没降）。dynamic 下不用这个值。
PRESETS: dict[str, dict] = {
    "tpose": {
        "label": "平举",
        "pose": {
            "left_shoulder_roll_joint": 1.45,
            "right_shoulder_roll_joint": -1.45,
            "left_elbow_joint": 0.0,
            "right_elbow_joint": 0.0,
        },
        "base_dz": 0.0,
    },
    # 半蹲。髋向前摆（负角）让大腿压到接近水平、膝同量回弯让小臂（小腿）立回竖直，
    # 踝回到 0 使脚掌仍是平的。这一蹲机身要降 0.18，否则脚掌被抬离地面
    "squat": {
        "label": "半蹲",
        "pose": {
            "left_hip_pitch_joint": -1.6,
            "right_hip_pitch_joint": -1.6,
            "left_knee_joint": 1.7,
            "right_knee_joint": 1.7,
            "left_ankle_pitch_joint": 0.0,
            "right_ankle_pitch_joint": 0.0,
            "left_shoulder_roll_joint": 0.3,
            "right_shoulder_roll_joint": -0.3,
            "left_elbow_joint": 1.4,
            "right_elbow_joint": 1.4,
        },
        "base_dz": -0.18,
    },
    # 举手（投降式）：大臂侧平举、肘微屈，小臂竖直向上、掌心朝前。
    # 这组角度是照模型算出来的（肩 pitch -2.95 / roll -1.81 / yaw 1.38），
    # 只看 roll 举不起来 —— 侧举之后肘轴变成竖直的，必须先用 yaw 把肘轴掰回水平
    "hands_up": {
        "label": "举手",
        "pose": {
            "left_shoulder_pitch_joint": -2.95,
            "right_shoulder_pitch_joint": -2.95,
            "left_shoulder_roll_joint": 1.81,
            "right_shoulder_roll_joint": -1.81,
            "left_shoulder_yaw_joint": -1.38,
            "right_shoulder_yaw_joint": 1.38,
            "left_elbow_joint": -0.14,
            "right_elbow_joint": -0.14,
        },
        "base_dz": 0.0,
    },
    # 伸手：大臂竖直垂在体侧，只有小臂向前平伸（肘角度接近 0，靠的是模型本身的
    # 前臂朝向），另一条手臂自然收着
    "reach": {
        "label": "伸手",
        "pose": {
            "right_shoulder_pitch_joint": 0.05,
            "right_shoulder_roll_joint": -0.05,
            "right_elbow_joint": -0.15,
            "left_shoulder_roll_joint": 0.2,
            "left_elbow_joint": 1.35,
        },
        "base_dz": 0.0,
    },
}

# 步态：两条腿按正弦相位交替，膝在摆动相屈起，手臂反向摆、腰轻微扭。
# 只写 target，实际的角速度仍受 joint_speed 限制，所以从站姿切进来不会瞬移。
# elbow 是肘的目标角：walk 1.45 让前臂垂下来（手臂自然下垂），
# march -0.15 让小臂与大臂成 90°（模型前臂默认就朝前，肘 0 已是直角，
# 肩 roll 外张 0.22 会把它带偏 8.6°，负角补回来）
GAITS: dict[str, dict] = {
    "walk": {"label": "行走", "hip": 0.35, "knee": 0.55, "arm": 0.45, "waist": 0.12, "freq": 1.1, "elbow": 1.45},
    "march": {"label": "跑步", "hip": 0.3, "knee": 0.8, "arm": 0.5, "waist": 0.06, "freq": 1.8, "elbow": -0.15},
}


def physics_loop(sim: Sim, args: argparse.Namespace) -> None:
    """主线程物理循环。窗口模式下每帧 sync，无窗口模式按 render_hz 出图。"""
    dt = 1.0 / args.ctrl_hz
    render_gap = 1.0 / max(1.0, args.render_hz)   # 出图的最小间隔，按 render_hz 限速
    next_tick = time.perf_counter()
    viewer_ctx = None
    viewer = None
    if not args.headless:
        import mujoco.viewer

        viewer_ctx = mujoco.viewer.launch_passive(sim.model, sim.data)
        viewer = viewer_ctx.__enter__()
        viewer.opt.flags[mujoco.mjtVisFlag.mjVIS_CONTACTPOINT] = 0
    try:
        while sim.running:
            sim.step(dt)
            if viewer is not None:
                viewer.sync()
            elif sim.frame is None or (sim.demand
                                       and time.perf_counter() - sim.last_render >= render_gap):
                # 有请求就画，且距上一帧至少 render_gap：一次请求对应一帧，
                # 不会像固定 Hz 那样让请求拿到上一轮画好的旧帧
                sim.demand = False
                sim._render()
            next_tick += dt
            sleep = next_tick - time.perf_counter()
            if sleep > 0:
                time.sleep(sleep)
            else:  # 落后太多就重新对时，不做追帧
                next_tick = time.perf_counter()
    finally:
        if viewer_ctx is not None:
            viewer_ctx.__exit__(None, None, None)


class Handler(BaseHTTPRequestHandler):
    sim: Sim
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):  # 静音默认访问日志，避免刷屏
        pass

    def handle_one_request(self) -> None:
        # 后端转发和浏览器的 <img> 换帧都可能先一步关掉连接，
        # 这是正常现象，不该在终端刷一屏 traceback
        try:
            super().handle_one_request()
        except (ConnectionError, TimeoutError):
            self.close_connection = True

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionError):
            self.close_connection = True

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return data

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        try:
            if path in ("/health", "/api/v1/health"):
                snap = self.sim.snapshot()
                self._json(
                    200,
                    {
                        "ok": True,
                        "model": self.sim.xml_path,
                        "mode": snap["mode"],
                        "headless": snap["headless"],
                        "nq": int(self.sim.model.nq),
                        "nv": int(self.sim.model.nv),
                        "render": snap["render"],
                    },
                )
            elif path == "/state":
                self._json(200, self.sim.snapshot())
            elif path == "/joints":
                self._json(200, self.sim.joint_table())
            elif path == "/frame":
                self.sim.demand = True
                frame = self.sim.frame
                if frame is None:      # 冷启动：等物理循环补出第一帧，最多 200ms
                    with self.sim.frame_cv:
                        if self.sim.frame is None:
                            self.sim.frame_cv.wait(timeout=0.2)
                    frame = self.sim.frame
                if frame is None:
                    self._json(503, {"error": "没有可用画面：窗口模式或渲染不可用"})
                    return
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Content-Length", str(len(frame)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(frame)
                except (BrokenPipeError, ConnectionError):
                    self.close_connection = True
            elif path == "/stream":
                self._stream()
            else:
                self._json(404, {"error": "接口不存在"})
        except (BrokenPipeError, ConnectionError):
            self.close_connection = True
        except Exception as exc:
            self._json(500, {"error": str(exc)})

    def _stream(self) -> None:
        boundary = "q1frame"
        self.send_response(200)
        self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={boundary}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            last = -1
            while self.sim.running:
                self.sim.demand = True
                if self.sim.frame is None or self.sim.frame_seq == last:
                    time.sleep(0.01)
                    continue
                last = self.sim.frame_seq
                self.wfile.write(
                    f"--{boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: "
                    f"{len(self.sim.frame)}\r\n\r\n".encode()
                    + self.sim.frame
                    + b"\r\n"
                )
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            body = self._body()
        except Exception as exc:
            self._json(400, {"error": f"请求体解析失败：{exc}"})
            return
        try:
            if path == "/cmd/pose" or path == "/cmd/joints":
                pose = body.get("pose") or body.get("joints") or {}
                if not isinstance(pose, dict) or not pose:
                    self._json(400, {"error": "pose 需为非空对象"})
                    return
                with STATE_LOCK:
                    applied = self.sim.apply_pose(pose, float(body.get("duration_ms", 300)))
                if not applied:
                    self._json(422, {"error": "没有匹配到模型中的关节"})
                    return
                self._json(200, {"ok": True, "applied": applied})
            elif path == "/cmd/gesture":
                name = str(body.get("name", ""))
                with STATE_LOCK:
                    self.sim.apply_gesture(name, float(body.get("speed", 2.5)))
                self._json(200, {"ok": True, "gesture": name})
            elif path == "/cmd/preset":
                name = str(body.get("name", ""))
                with STATE_LOCK:
                    result = self.sim.apply_preset(name)
                self._json(200, {"ok": True, "preset": name, **result})
            elif path == "/cmd/gait":
                name = str(body.get("name", ""))
                with STATE_LOCK:
                    if name in ("", "off", "stop"):
                        # 停步态时顺手停手势：两者都在持续写 target，页面上的「停」只有一处
                        self.sim.gait = None
                        self.sim.gesture = None
                    else:
                        self.sim.apply_gait(name)
                    gait = self.sim.gait["name"] if self.sim.gait else None
                self._json(200, {"ok": True, "gait": gait})
            elif path == "/cmd/camera":
                with STATE_LOCK:
                    cam = self.sim.set_camera(body)
                self._json(200, {"ok": True, "camera": cam})
            elif path == "/cmd/speed":
                with STATE_LOCK:
                    value = self.sim.set_speed(float(body.get("speed", 1.0)))
                self._json(200, {"ok": True, "speed": value})
            elif path == "/cmd/base":
                if self.sim.mode != "kinematic":
                    self._json(422, {"error": "动态模式不接收底盘速度，请切回 kinematic"})
                    return
                with STATE_LOCK:
                    self.sim.base_cmd[:] = [
                        float(body.get("vx", 0.0)),
                        float(body.get("vy", 0.0)),
                        float(body.get("wz", 0.0)),
                    ]
                    self.sim.last_cmd_at = time.time()
                    sent = [round(float(v), 3) for v in self.sim.base_cmd[:3]]
                self._json(200, {"ok": True, "vx": sent[0], "vy": sent[1], "wz": sent[2]})
            elif path == "/cmd/stop":
                with STATE_LOCK:
                    self.sim.stop()
                self._json(200, {"ok": True})
            elif path == "/cmd/reset":
                with STATE_LOCK:
                    self.sim.reset()
                self._json(200, {"ok": True})
            elif path == "/cmd/mode":
                with STATE_LOCK:
                    self.sim.set_mode(str(body.get("mode", "")))
                self._json(200, {"ok": True, "mode": self.sim.mode})
            else:
                self._json(404, {"error": "接口不存在"})
        except ValueError as exc:
            self._json(422, {"error": str(exc)})
        except Exception as exc:
            self._json(500, {"error": str(exc)})


def find_model(explicit: str | None) -> str:
    """按优先级找 MJCF：命令行 > 环境变量 > 工程内自带 > 同级 q1-urdf 克隆。"""
    import os

    here = os.path.dirname(os.path.abspath(__file__))
    candidates = []
    if explicit:
        candidates.append(explicit)
    if os.environ.get("SIM_XML"):
        candidates.append(os.environ["SIM_XML"])
    candidates += [
        os.path.join(here, "assets", "q1-urdf", "xml", "q1_v3_mc.xml"),
        os.path.join(here, "..", "q1-urdf", "xml", "q1_v3_mc.xml"),
    ]
    for path in candidates:
        if os.path.exists(path):
            return os.path.abspath(path)
    raise SystemExit(
        "找不到 q1_v3_mc.xml。把模型放到 sim/assets/q1-urdf/xml/ 下，"
        "或显式传 --xml <路径>：\n"
        "  git clone https://atomgit.com/primebot/q1-urdf.git sim/assets/q1-urdf"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Q1 MuJoCo 仿真桥")
    parser.add_argument("--xml", help="MJCF 路径；不传则用 sim/assets/q1-urdf/xml/q1_v3_mc.xml")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--headless", action="store_true", help="不出窗口，改用离屏渲染供网页取图")
    parser.add_argument("--dynamic", action="store_true", help="以动力学模式启动（会受重力坠落）")
    parser.add_argument("--ctrl-hz", type=float, default=100.0)
    parser.add_argument("--render-hz", type=float, default=20.0,
                        help="出图上限；实际按页面请求出图，不请求就不画")
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--quality", type=int, default=75)
    parser.add_argument("--shadows", action="store_true",
                        help="打开阴影贴图：画面更立体，但单帧渲染慢约 3 倍")
    parser.add_argument("--distance", type=float, default=0.0, help="相机距离，0 表示按本体高度自动取景")
    parser.add_argument("--azimuth", type=float, default=200.0)
    parser.add_argument("--elevation", type=float, default=-5.0)
    parser.add_argument("--joint-speed", type=float, default=3.0, help="运动学模式关节最大角速度 rad/s")
    parser.add_argument("--kp", type=float, default=60.0)
    parser.add_argument("--kd", type=float, default=4.0)
    parser.add_argument("--watchdog-s", type=float, default=0.5, help="无指令多久清零底盘速度")
    parser.add_argument("--print-joints", action="store_true", help="打印关节表后退出，用于核对限位")
    args = parser.parse_args()

    xml_path = find_model(args.xml)
    if args.print_joints:
        model = mujoco.MjModel.from_xml_path(xml_path)
        qadr, _, ranges = scan_joints(model)
        print(json.dumps(joint_table(model, xml_path, qadr, ranges), ensure_ascii=False, indent=2))
        return 0

    sim = Sim(xml_path, args)
    Handler.sim = sim
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(
        f"Q1 仿真桥：http://{args.host}:{args.port}  mode={sim.mode} "
        f"joints={len(sim.hinge_qadr)} nq={sim.model.nq} nv={sim.model.nv} "
        f"headless={args.headless}",
        flush=True,
    )

    def shutdown(*_):
        sim.running = False

    signal.signal(signal.SIGINT, shutdown)
    try:
        physics_loop(sim, args)
    except KeyboardInterrupt:
        pass
    finally:
        sim.running = False
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
