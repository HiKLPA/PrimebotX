/* 主页中央的机器人本体，模型是 model/q1_ff.glb（Q1 基础形态，取自 PrimeFLOW
   的 /res/models/q1_ff.glb，6.4MB / 17 万面 / 带骨骼与 8 段动画）。
   只负责浏览器端展示：播 idle 呼吸，指针移动时身体与头部跟着转向。

   两档取景，Settings → Robot 切换，选择存在 px.bot：
     body —— 上半身。包围盒压成「脚底 y=0、头顶 y=1」后，可见段切在 1 → 0.48
             （腰），相机距离由这一段反解，相机高度让腰线正好压在画布下边缘；
             这一档是远看，指针只带一点点转身。
     head —— 头部特写。可见段收到 1.045 → 0.795，镜头拉到只装一颗头，
             朝向跟随指针，屏幕左右边缘对应 ±30°（Math.PI/6），基本不俯仰。

   两档共用一台相机，切档时高度与距离都走插值，读起来是一次推镜而不是硬跳。

   配色：整台刷白。原模型是白壳 + 两档深色（面罩、关节），深色那档留一点
   灰度，否则头盔与躯干连成一片白，读不出五官；要真·通体纯白，
   把 DARK_AS_WHITE 打开即可。

   表情：模型没有形态键，面罩本身也没有贴图槽，所以把面罩当一块屏 ——
   复制它的 UV 通道重投一次平面坐标，再挂一张跟着画布更新的 emissiveMap，
   表情就是这张图上白色的线，黑底不发光。图案由 faces.js 一处提供，
   底栏 Emotions 那排缩略图画的也是同一份数据。 */
import * as THREE from 'three';
import {sampleIdle, idleState} from './idle_motion.js?v=3';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createScreen, onMood, moodId, setMood, flashCheck, flashDownload, clearFlash } from './faces.js?v=15';
import { createHomeMotionController, mountHomeMotionControls, createJointBindings, sampleMotionFrame } from './homepage_motions.js?v=35';
import { Q1_REST_POSE } from './q1_motion_data.js?v=3';

const MODEL_URL = 'model/q1_ff.glb';
const POINTER_PAUSE_MOTIONS = new Set([
  'street_dance', 'mechanical_dance', 'disco_dance',
]);
const CLIP = 'idle';        /* 循环动画名；模型自带 apose/idle/standby/raisehand 等 8 段 */
const FRAME_KEY = 'primebotx.bot'; /* 与 Settings 里那组按钮共用同一个键 */

/* 每一档：可见段上下沿（归一化身高）、留白、基础朝向、转幅、俯仰、呼吸。
   body 的 yaw 是「指针贴到屏幕边」时多转的角度，0.08 约 4.6°；
   head 直接用 Math.PI/6，就是左右各 30°。
   drop 是机身整体在画面里下移的距离（按身高归一）：只抬相机注视点，
   不缩取景框，所以人不会跟着变小。数值越小机身越靠上，0.1 时整台机器
   基本居中，头顶与画布上沿之间留出一段空气 */
const FRAMES = {
  body: { top: 1,     bottom: 0,     fill: 0.9,  baseYaw: 0.12, yaw: 0.08,       pitch: 0.025, breathe: 0.012, drop: 0.1 },
  head: { top: 1.03,  bottom: 0.81,  fill: 0.92, baseYaw: 0,    yaw: Math.PI / 6, pitch: 0,     breathe: 0.006, drop: 0 },
};
const ARM_SPAN = 0.5;       /* 含边距的臂展（归一化到身高），窄屏时用它挡横向溢出 */

const WHITE = 0xe3e6e8;     /* 壳体白：全身取景下与浅灰背景保持足够轮廓 */
const DARK = 0x2f3134;      /* 关节、护甲缝隙的深色 */
const VISOR = 0x1b1d20;     /* 面罩：比关节再深一档，压成镜面 */
const DARK_AS_WHITE = false;/* true = 连面罩一起刷白，整台纯白（会丢掉五官） */

const EASE = 0.07;          /* 转身、俯仰的跟随速度 */
const CAM_EASE = 0.09;      /* 推镜速度：切档时相机沿这条曲线走过去 */

/* 绘制分辨率的上限。白壳的边缘全靠轮廓线立形状，采样不足时头盔、
   肩线的斜边会先碎成台阶，所以这里不压倍率：按设备 DPR 原样采样，
   只在 3 倍以上的移动端封到 2，避免填充率白烧 */
const DPR_CAP = 2;

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const stage = document.querySelector('.stage');
if (stage) init();

function init() {
  let renderer;
  const deviceDPR = window.devicePixelRatio || 1;
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      /* 多重采样一直开着：整台机器是白色高光壳体，轮廓线与关节缝隙的
         斜边走样最显眼，靠 DPR 单独顶不住，两者要一起给 */
      antialias: true,
      powerPreference: 'high-performance',
      /* 不要模板缓冲也不需要 alpha 以外的附件；能省掉几张大图 */
      stencil: false,
    });
  } catch (err) {
    return;   /* 没有 WebGL 就只留点阵背景，不影响页面 */
  }

  const wrap = document.createElement('div');
  wrap.className = 'robofx';
  wrap.appendChild(renderer.domElement);
  stage.appendChild(wrap);

/* 满屏画布 + 17 万面：默认按设备 DPR 原样采样，边缘才干净。
   1 倍屏再补一点超采样（头盔、肩线的斜边在这个倍率下最容易碎成台阶），
   3 倍以上的移动端封到 2。真顶不住时由 governor() 在运行时往下调 */
const DPR_STEPS = [Math.min(Math.max(deviceDPR, 1.25), DPR_CAP)];
DPR_STEPS.push(Math.max(DPR_STEPS[0] * 0.85, 0.9), Math.max(DPR_STEPS[0] * 0.72, 0.75));
let dprStep = 0;
renderer.setPixelRatio(DPR_STEPS[0]);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.95;

  const scene = new THREE.Scene();
  /* 白壳是镜面塑料，没有环境反射就会糊成一块死白：用 PMREM 的房间贴图
     给一层柔和的天地反射，形状才立得住 */
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.75;
  pmrem.dispose();

  /* 白壳压在 #f0f0f0 的底上，只靠正面光会和背景糊在一起：主光偏右上造体积，
     左侧补光压住暗面，再从背后打一道轮廓光把肩线和头盔的边缘拉开 */
  const key = new THREE.DirectionalLight(0xffffff, 1.45);
  key.position.set(1.8, 2.8, 2.0);
  const fill = new THREE.DirectionalLight(0xe8eeff, 0.35);
  fill.position.set(-2.4, 1.2, 1.6);
  const rim = new THREE.DirectionalLight(0xffffff, 0.85);
  rim.position.set(-1.6, 2.2, -3);
  scene.add(key, fill, rim);

  const camera = new THREE.PerspectiveCamera(24, 1, 0.05, 40);
  const rig = new THREE.Group();
  const motionRoot = new THREE.Group();
  motionRoot.name = 'motionRoot';
  rig.add(motionRoot);
  scene.add(rig);

  let mixer = null, model = null, motionController = null, idleAction = null, ready = false;
  let setActiveMotion = () => {};
  let clips = [], activeAction = null;
  let basePose = null, poseMode = false, aimPaused = false;
  const aimPauseSources = new Set();
  let joints = null, ritual = null;
  /* 拖卡片时头单独跟着指针走：机身那点转幅（body 档 0.08 rad）看不出在追人，
     所以额外在 head 骨骼上叠一份更大的偏转，松手后自动褪回 */
  let cardDrag = false;
  let headBone = null, headRest = null, headYawAxis = null, headPitchAxis = null;
  let headYaw = 0, headPitch = 0, headBlend = 0;
  let playback = {clip: 'idle', state: 'loading'};
  function playClip(name, loop = false) {
    clearIdleOffsets();
    if (!ready || !mixer) throw new Error('模型尚未加载');
    if (motionController?.activeId) motionController.stop();
    const clip = THREE.AnimationClip.findByName(clips, name);
    if (!clip) throw new Error('模型没有此动画：' + name);
    poseMode = false;
    const next = mixer.clipAction(clip);
    if (activeAction) activeAction.fadeOut(0.2);
    next.reset().setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = true;
    next.fadeIn(0.2).play();
    activeAction = next;
    playback = {clip: name, state: 'playing'};
    window.dispatchEvent(new CustomEvent('robot-playback', {detail: {...playback}}));
    if (REDUCED) renderer.setAnimationLoop(tick);
  }
  let yaw = 0, pitch = 0, tYaw = 0, tPitch = 0;
  /* 面罩那张贴图：512 × 584 差不多是面罩本身的宽高比（0.082 : 0.096），
     头部特写下放大到屏上也不至于糊 */
  const screen = createScreen(512, 584);
  const faceTex = new THREE.CanvasTexture(screen.canvas);
  faceTex.colorSpace = THREE.SRGBColorSpace;
  faceTex.generateMipmaps = false;
  faceTex.minFilter = THREE.LinearFilter;
  faceTex.magFilter = THREE.LinearFilter;
  let faceMats = [];
  let faceStamp = 0;
  screen.draw(0.6);
  /* 指针在屏幕上的归一化位置，范围 [-1,1]。角度按当前档位现乘，
     切档时不用把目标角度重算一遍 */
  let nx = 0, ny = 0;
  /* 取景档位：先认存下的选择；第一次取景直接落位，之后切档才推镜 */
  let frame = 'body';
  try { if (localStorage.getItem(FRAME_KEY) === 'head') frame = 'head'; } catch (e) {}
  let camY = 0, camD = 1, tgtY = 0, tgtD = 1, camPlaced = false;
  const sized = {w: 0, h: 0};

  /* 画面是满屏的（CSS inset:0），两档各自算一套相机参数：body 让腰线压在
     画布下边缘，head 把整颗头放在画面正中。这里只写目标值，相机由 tick 插值过去 */
  function fit(instant) {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    /* setSize 不看新旧，直接重设 canvas.width/height —— 那等于重新申请一张
       绘制缓冲，GPU 要等上一帧画完、再按新尺寸重建，途中必然掉一帧。
       ResizeObserver 与 resize 各会调一次 fit，尺寸没变就别再碰它 */
    if (w !== sized.w || h !== sized.h) {
      sized.w = w;
      sized.h = h;
      renderer.setSize(w, h, false);
    }
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    const f = FRAMES[frame];
    const span = f.top - f.bottom;
    const tanV = Math.tan((camera.fov * Math.PI) / 180 / 2);

    if (frame === 'head') {
      /* 头部特写：可见段就是一颗头，画面中心压在头的中心，四周留白一样宽 */
      tgtD = span / (2 * tanV) / f.fill;
      tgtY = (f.top + f.bottom) / 2;
    } else {
      const style = getComputedStyle(wrap);
      const topInset = parseFloat(style.getPropertyValue('--robofx-top')) || 88;
      const bottomInset = parseFloat(style.getPropertyValue('--robofx-bottom')) || 208;
      const avail = Math.max(240, h - topInset - bottomInset);
      /* 纵向：可见段占 avail 像素。画布比 avail 高，所以同一段在世界里
         要摊到 h 那么高，距离按 h / avail 放大 */
      const distV = (span * h) / (avail * 2 * tanV);
      /* 横向：窄窗时先撑满的是横向。0.5 是含边距的臂展（实测约 0.45 身高），
         窄屏纵向撑满后宽度会顶到九成，收一档让它离边远一点 */
      const distH = ARM_SPAN / (2 * tanV * camera.aspect);
      tgtD = Math.max(distV, distH) / f.fill;
      const contentCenter = (topInset + h - bottomInset) / 2;
      const worldPerPixel = (2 * tgtD * tanV) / h;
      /* 注视点抬高等于画面内容下移：镜头中心对着世界坐标更高的一处，
         机身在框里的位置就整个往下坐 drop 那么高。距离不动，大小不变 */
      tgtY = (f.top + f.bottom) / 2 + (contentCenter - h / 2) * worldPerPixel + (f.drop || 0);
    }

    if (instant || REDUCED || !camPlaced) {
      camY = tgtY;
      camD = tgtD;
      camPlaced = true;
      applyCam();
    }
  }

  function applyCam() {
    if (window.__robotView && window.__robotView.step) {
      window.__robotView.step(camY, camD);
      return;
    }
    camera.position.set(0, camY, camD);
    camera.lookAt(0, camY, 0);
  }

  function capturePose() {
    const pose = new Map();
    if (!model) return pose;
    model.traverse((o) => {
      if (!o.isBone) return;
      pose.set(o, {
        position: o.position.clone(),
        quaternion: o.quaternion.clone(),
        scale: o.scale.clone(),
      });
    });
    return pose;
  }

  function applyPose(pose) {
    if (!pose) return;
    pose.forEach((value, bone) => {
      bone.position.copy(value.position);
      bone.quaternion.copy(value.quaternion);
      bone.scale.copy(value.scale);
    });
    if (model) model.updateMatrixWorld(true);
  }

  function freezePose() {
    clearIdleOffsets();
    if (!ready || !mixer || poseMode) return;
    if (motionController?.activeId) motionController.stop();
    const currentPose = capturePose();
    mixer.stopAllAction();
    activeAction = null;
    applyPose(currentPose);
    poseMode = true;
    playback = {clip: 'pose', state: 'paused'};
    window.dispatchEvent(new CustomEvent('robot-playback', {detail: {...playback}}));
  }

  function resetPose() {
    clearIdleOffsets();
    if (!ready || !mixer) return;
    if (motionController?.activeId) motionController.stop();
    if (!poseMode) mixer.stopAllAction();
    activeAction = null;
    applyPose(basePose);
    poseMode = true;
    playback = {clip: 'apose', state: 'paused'};
    window.dispatchEvent(new CustomEvent('robot-playback', {detail: {...playback}}));
    if (REDUCED) renderer.render(scene, camera);
  }

  function setPointerAimPaused(paused, source = 'view') {
    if (paused) aimPauseSources.add(source);
    else aimPauseSources.delete(source);
    const next = aimPauseSources.size > 0;
    if (aimPaused === next) return;
    aimPaused = next;
    if (!aimPaused) aim();
  }

  if (!REDUCED) {
    window.addEventListener('pointermove', (e) => {
      nx = (e.clientX / window.innerWidth - 0.5) * 2;
      ny = (e.clientY / window.innerHeight - 0.5) * 2;
      if (!aimPaused) aim();
      /* 指针一动就回到满帧：机身那点跟随、面罩的眨眼都要跟得上手 */
      markActive();
    }, { passive: true });
    document.documentElement.addEventListener('pointerleave', () => { tYaw = 0; tPitch = 0; });
  }

  /* 目标朝向按当前档位的转幅算：body 只轻转，head 开到 ±30°。
     切档时也要重算一次，否则旧档位留下的目标角度会撑一会儿 */
  function aim() {
    const f = FRAMES[frame];
    /* 指针往右 → rotation.y 增大 → 模型正面朝屏幕右侧转，两档同向 */
    tYaw = nx * f.yaw;
    tPitch = ny * f.pitch;
  }

  /* ——— 拖卡时头跟着指针 ———
     body 档机身只转 0.08 rad，指针在屏幕上跑来跑去时几乎看不出在追人，
     所以额外在 head 骨骼上叠一层。轴按世界方向换到骨骼局部：绕世界竖直轴
     是转头，绕世界 x 轴是低头/抬头。
     模型自带的 idle 每帧都会把 head 写回去，因此这里必须排在 mixer.update
     之后；松手时 blend 收到 0，角度交回 idle，不会留一个歪着的头。 */
  const HEAD_YAW = 0.42;    /* ±24°，比机身那档放开三倍多 */
  const HEAD_PITCH = 0.16;  /* ±9°，再大就成低头看地了 */
  const _headQ = new THREE.Quaternion();
  const _qA = new THREE.Quaternion();
  const _qB = new THREE.Quaternion();

  function bindHead() {
    headBone = findModelBone('head');
    if (!headBone) return;
    headRest = headBone.quaternion.clone();
    headBone.getWorldQuaternion(_qA).invert();
    headYawAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(_qA).normalize();
    headPitchAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(_qA).normalize();
  }

  function stepHeadAim(dt) {
    if (!headBone || !headYawAxis) return;
    const want = cardDrag && !ritual ? 1 : 0;
    headBlend += (want - headBlend) * (1 - Math.pow(0.0004, dt));
    if (!want && headBlend < 0.004) {
      headBlend = 0;
      headYaw = 0;
      headPitch = 0;
      return;
    }
    const k = 1 - Math.pow(0.0009, dt);
    headYaw += (nx * HEAD_YAW * headBlend - headYaw) * k;
    headPitch += (ny * HEAD_PITCH * headBlend - headPitch) * k;

    _headQ.copy(headRest)
      .multiply(_qA.setFromAxisAngle(headYawAxis, headYaw))
      .multiply(_qB.setFromAxisAngle(headPitchAxis, headPitch));
    headBone.quaternion.copy(_headQ);
  }

  /* 卡片那头在拖起与松手时各调一次：屏上换下载图标、头开始跟指针 */
  function beginCardDrag() {
    clearIdleOffsets();
    if (cardDrag) return;
    cardDrag = true;
    markActive();
    flashDownload();
    screen.drawNow();
    faceTex.needsUpdate = true;
  }

  function endCardDrag() {
    if (!cardDrag) return;
    cardDrag = false;
    clearFlash();
    /* 立刻退回用户选的表情，不等 50ms 的重绘节拍，否则会闪一下下载图标 */
    screen.drawNow();
    faceTex.needsUpdate = true;
  }

  /* ——— 卡片仪式 ———
     把动作卡拖到身上后走这一套：抬手接住 → 思考 2s → 转向用户打一个勾
     → 卡片消失 → 才开始播卡上的动作。时间线按绝对秒数排，tick 里推进；
     关键节点往外派 robot-card 事件，卡片那一侧据此跟手与淡出。

     姿态直接写骨骼四元数：mixer 每帧先把 idle 的姿势写回去，这里在其后用
     copy 覆盖，抬手因此一步到位，也不会把呼吸顶掉 */
  const RITUAL = {pick: 0.7, think: 2.7, mark: 3.4, act: 4.0};
  const HAND_BONE = 'Bone.012';
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _aim = new THREE.Quaternion();

  function cardEvent(phase) {
    window.dispatchEvent(new CustomEvent('robot-card', {detail: {phase}}));
  }

  /* mixer 每帧先把 idle 的姿势写回去，所以这里必须整份盖掉、不能靠 slerp 累积：
     一帧只走一部分的话，下一帧又被 idle 拉回来，手臂永远抬不到位。
     平滑交给时间线自己（lift / think 都是缓动过的 0→1） */
  function setJoint(joint, absolute) {
    const j = joints && joints[joint];
    if (!j) return;
    const angle = absolute - Q1_REST_POSE[joint];
    _aim.copy(j.rest).multiply(_q.setFromAxisAngle(j.axis, angle));
    j.bone.quaternion.copy(_aim);
  }

  /* 时间线用的两条曲线提到外面：仪式每帧都要算三次缓动，
     当场建闭包等于每秒多出上百个短命函数 */
  function ease01(x) {
    const v = x < 0 ? 0 : x > 1 ? 1 : x;
    return v * v * (3 - 2 * v);
  }

  function stepRitual(now) {
    const sec = (now - ritual.t0) / 1000;
    const ease = ease01;

    const lift = ease(sec / RITUAL.pick);
    const think = ease((sec - RITUAL.pick) / 0.5);
    /* 卡片消失那一段把手放回去，动作开始时姿势与 idle 接得上，不会跳 */
    const settle = sec >= RITUAL.mark ? ease((sec - RITUAL.mark) / (RITUAL.act - RITUAL.mark)) : 0;
    const arm = lift * (1 - settle);
    const hold = think * (1 - settle);

    /* 思考时头略低、向一侧歪一点；勾出来之后回正，正对用户。
       不点头 —— 认下这张卡只用屏上那一个勾 */
    ritual.pitch = 0.05 * hold;
    ritual.roll = -0.04 * hold;

    /* 大臂自然下垂、小臂前伸、掌心朝上：肩只带一点内旋（0.20），
       肘从站姿的 1.45 折到 0.20 —— 实测小臂几乎水平指向前方
       (0.33, -0.11, 0.94)，掌面法线 (0.23, 0.97, -0.02) 朝上，
       手掌摊在身前偏右、齐腰到齐胸之间，卡片就浮在掌心上方。
       肩的 roll 不再覆盖：让 idle 那点呼吸留在上臂上，读起来是「垂着」而不是「焊住」。
       肘从站姿值起算，抬起那一段是「折上来」，不是先弹一下再回正 */
    const ELBOW0 = Q1_REST_POSE.right_elbow_joint;
    setJoint('right_shoulder_pitch_joint', 0);
    setJoint('right_shoulder_yaw_joint', 0.20 * arm);
    setJoint('right_elbow_joint', ELBOW0 + (0.20 - ELBOW0) * arm);
    setJoint('left_shoulder_pitch_joint', -0.30 * hold);
    setJoint('left_elbow_joint', Q1_REST_POSE.left_elbow_joint + (1.20 - Q1_REST_POSE.left_elbow_joint) * hold);

    if (!ritual.fired.pick && sec >= 0.05) { ritual.fired.pick = true; cardEvent('pick'); }
    if (!ritual.fired.think && sec >= RITUAL.pick) { ritual.fired.think = true; cardEvent('think'); }
    if (!ritual.fired.mark && sec >= RITUAL.think) {
      ritual.fired.mark = true;
      /* 0.82s 的勾，正好盖住卡片淡出到消失的这一段；勾退场后回到用户原来的表情 */
      flashCheck(820);
      setMood(ritual.mood0);
      cardEvent('mark');
    }
    if (!ritual.fired.release && sec >= RITUAL.mark) {
      ritual.fired.release = true;
      /* 手里那块板跟着淡出、缩小，正好在动作开始前收干净 */
      releaseCard();
      cardEvent('release');
    }
    if (sec >= RITUAL.act) finishRitual();
  }

  function finishRitual() {
    const done = ritual;
    ritual = null;
    aimPaused = false;
    hideCardNow();
    setMood(done.mood0 === 'think' ? 'calm' : done.mood0);
    if (done.motionId && motionController) {
      if (activeAction && activeAction !== idleAction) activeAction.stop();
      poseMode = false;
      activeAction = idleAction;
      motionController.play(done.motionId);
    } else if (idleAction) {
      idleAction.reset().fadeIn(0.2).play();
      activeAction = idleAction;
    }
    cardEvent('act');
    if (REDUCED) renderer.render(scene, camera);
  }

  /* 拖拽落点只认脑袋：卡片得丢到头上才算递给它，落到胸口、手边、脚旁都不算。
     判定做成一个圆：圆心取头骨的世界坐标再往上抬一档（头骨原点落在脖子根，
     抬半颗头才到脑袋正中），半径按归一化身高（1）折算，
     再投到屏幕上量成像素 —— 视口缩放、取景档位都不用另配，
     也不会因为模型歪一下头就把判定区拉成长条。
     这里不再 setFromObject 求包围盒：那要遍历全部 63 个网格、把每个分离
     几何的包围盒都过一遍，松手那一下正好撞在动画的起手帧上。
     模型已归一化到身高 1，头骨到「脑袋正中」的距离是个固定值（实测 0.044），
     用常量就够，也不受姿态影响 */
  const HEAD_HIT_R = 0.08;        /* 命中半径，按身高 1 折算：约一颗头的半高 */
  const HEAD_CENTER_LIFT = 0.044; /* 头骨原点 → 脑袋正中，同样按身高 1 折算 */
  const HEAD_HIT_PAD = 6;         /* 指尖容差，避免边缘差一两个像素就判空 */
  let modelHeight = 1;            /* 归一化后在加载时量一次，给命中半径用 */

  function hitTest(clientX, clientY) {
    if (!ready || !model) return false;
    const head = headBone || findModelBone('head');
    if (!head) return false;

    const rect = renderer.domElement.getBoundingClientRect();
    head.getWorldPosition(_v);
    _v.y += HEAD_CENTER_LIFT * modelHeight;
    _v2.copy(_v).project(camera);
    const cx = rect.left + (_v2.x * 0.5 + 0.5) * rect.width;
    const cy = rect.top + (-_v2.y * 0.5 + 0.5) * rect.height;

    /* 半径也走一次投影：镜头右向量上取一个世界半径外的点，
       两点在屏幕上的距离就是这块区域此刻的像素半径 */
    _v2.setFromMatrixColumn(camera.matrixWorld, 0)
      .multiplyScalar(modelHeight * HEAD_HIT_R)
      .add(_v)
      .project(camera);
    const ex = rect.left + (_v2.x * 0.5 + 0.5) * rect.width;
    const ey = rect.top + (-_v2.y * 0.5 + 0.5) * rect.height;
    const r = Math.hypot(ex - cx, ey - cy) + HEAD_HIT_PAD;

    return Math.hypot(clientX - cx, clientY - cy) <= r;
  }

  /* 右手在世界里的位置投影回屏幕，卡片要贴在这上面。
     骨骼名里的点会被 GLTFLoader 换成下划线，两种写法都试一次 */
  function findModelBone(name) {
    if (!model) return null;
    return model.getObjectByName(name)
      || model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name));
  }

  /* 掌心的位置。手骨（Bone012）的原点在肘上，直接用它会偏到肘部，
     所以取手掌网格 hand_right017 的包围盒中心：几何中心在加载时算一次，
     每帧只做一次矩阵变换。网格找不到时退回手骨原点，不至于没有锚点 */
  const PALM_MESH = 'hand_right017';
  let palmHost = null;
  let palmLocal = null;

  function bindPalm() {
    palmHost = model ? model.getObjectByName(PALM_MESH) : null;
    if (!palmHost || !palmHost.geometry) { palmHost = null; return; }
    palmHost.geometry.computeBoundingBox();
    palmLocal = palmHost.geometry.boundingBox.getCenter(new THREE.Vector3());
  }

  function palmWorld(out) {
    if (!palmHost) {
      const bone = findModelBone(HAND_BONE) || findModelBone('Bone.008');
      return bone ? bone.getWorldPosition(out) : null;
    }
    palmHost.updateWorldMatrix(true, false);
    return out.copy(palmLocal).applyMatrix4(palmHost.matrixWorld);
  }

  function handScreen() {
    if (!ready || !model) return null;
    if (!palmWorld(_v)) return null;
    _v.project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + (_v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-_v.y * 0.5 + 0.5) * rect.height,
    };
  }

  /* ——— 手里那张卡的真身 ———
     接住之后，屏幕上跟手的那张 DOM 影子交棒给这里：一张没有厚度的圆角平面，
     挂在 rig 下、每帧贴到掌心上方，机器人抬手、转身、晃身体时它一起走；
     尺寸按机器人身高（模型归一化到 1）定，不跟视口或像素走，也不受磁吸缩放影响。
     朝向不写死：卡面法线对着「头部 → 卡心」这条线，平面与这条线垂直，
     机器人换个姿势、手挪了位置，卡自己重新摆正，不会歪着看人。
     卡面照栏里那张卡现画：底色、墨色、圆钮配色都由卡片那一侧从 DOM 的
     computed 值里带过来，浅深两套主题的 hover 配色都能对上。
     drawCard 的坐标按栏里那张 240 × 150 的卡换算，画布高一档采样，凑近看字也不糊 */
  const CARD_ASPECT = 1.6;
  const CARD_W = 0.28;              /* 世界宽：约三成身高。托在胸前，太宽会把整块胸腹盖住 */
  const CARD_H = CARD_W / CARD_ASPECT;
  const CARD_LIFT = 0.10;           /* 卡心离掌心的高度：浮在摊开的手上，不贴住手心 */
  const CARD_CANVAS = { w: 512, h: 320 };
  /* 栏里那张卡右下角的双箭头，原样搬过来描；坐标是它自带的 32 × 32 视框 */
  const CARD_ARROW = new Path2D('M23.78,16.54c.3-.3.3-.79,0-1.09l-4.35-4.35c-.3-.3-.79-.79-1.09-1.09l-4.35-4.35c-.3-.3-.89-.54-1.31-.54h-3.9c-.42,0-.77.35-.77.77v3.9c0,.42.24,1.01.54,1.31l4.35,4.35c.3.3.3.79,0,1.09l-4.35,4.35c-.3.3-.54.89-.54,1.31v3.9c0,.42.35.77.77.77h3.9c.42,0,1.01-.24,1.31-.54l4.35-4.35c.3-.3.79-.79,1.09-1.09l4.35-4.35Z');

  let cardMesh = null;
  let cardAnim = null;

  function ensureCard() {
    if (cardMesh) return cardMesh;

    const canvas = document.createElement('canvas');
    canvas.width = CARD_CANVAS.w;
    canvas.height = CARD_CANVAS.h;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());

    const hw = CARD_W / 2;
    const hh = CARD_H / 2;
    const r = CARD_W * 0.1;         /* 24 / 240，与栏里那张卡的圆角同一个比例 */
    const shape = new THREE.Shape();
    shape.moveTo(-hw + r, -hh);
    shape.lineTo(hw - r, -hh);
    shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
    shape.lineTo(hw, hh - r);
    shape.quadraticCurveTo(hw, hh, hw - r, hh);
    shape.lineTo(-hw + r, hh);
    shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
    shape.lineTo(-hw, -hh + r);
    shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);

    /* 平的一张，不走 Extrude —— 卡本身没有厚度，也就没有侧边那道深色描边。
       圆角靠 Shape 的轮廓切出来，ShapeGeometry 的 UV 同样是顶点坐标，
       按形状的包围盒归一化到 0..1，贴图才铺得正 */
    const geo = new THREE.ShapeGeometry(shape, 10);
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i += 1) {
      uv.setXY(i, (pos.getX(i) + hw) / CARD_W, (pos.getY(i) + hh) / CARD_H);
    }
    uv.needsUpdate = true;

    /* 环境光只有三盏方向光，纯 PBR 会把卡压得比栏里那张暗，
       给一份同图的自发光垫着，颜色才和屏上的卡对得上。
       双面渲染：平的东西没有背面，转到后面看也是这张脸，不会凭空消失 */
    const mat = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.78, metalness: 0,
      emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.3,
      transparent: true, opacity: 0, side: THREE.DoubleSide,
    });

    const group = new THREE.Group();
    group.add(new THREE.Mesh(geo, mat));
    group.visible = false;
    rig.add(group);

    cardMesh = { group, mat, tex, canvas, ctx: canvas.getContext('2d') };
    return cardMesh;
  }

  /* 把卡面画到贴图上：字号、留白按栏里那张 150 高的卡等比放大 */
  function drawCard(look) {
    const c = ensureCard();
    const { ctx, canvas } = c;
    const W = canvas.width;
    const H = canvas.height;
    const s = H / 150;              /* 与 240 × 150 那张卡的比例 */
    /* 深浅两套主题的 hover 配色不一样（浅色是系列色底反白字、深色是暗底
       淡系列色字、圆钮也对调），所以四支颜色都由调用方从 DOM 的 computed
       值里带过来，这里只负责画，不自己配 */
    const base = look.color || '#6e9182';
    const ink = look.ink || '#fafafa';
    const timeInk = look.timeInk || ink;
    const btnBg = look.btnBg || ink;
    const btnInk = look.btnInk || base;
    const family = look.font || 'system-ui, sans-serif';
    const weight = look.weight || 400;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const left = 12 * s;            /* 卡片内边距 8 + 文字再右移 4 */
    let y = 10 * s;                 /* 内边距 8 + 编号上边距 2 */
    ctx.font = `${weight} ${32 * s}px ${family}`;
    ctx.fillText(look.id || '', left, y);
    y += 32 * s + 8 * s;
    ctx.font = `${weight} ${24 * s}px ${family}`;
    ctx.fillText(look.brief || '', left, y);
    y += 24 * s + 4 * s;
    /* 简介 18、时长 14，与栏里那张卡的三行字号一一对应；
       两行的墨色也各取各的（简介偏实、时长更淡） */
    ctx.fillStyle = look.introInk || timeInk;
    ctx.font = `${weight} ${18 * s}px ${family}`;
    ctx.fillText(look.intro || '', left, y);
    y += 18 * s + 4 * s;
    ctx.fillStyle = timeInk;
    ctx.font = `${weight} ${14 * s}px ${family}`;
    ctx.fillText(look.time || '', left, y);

    /* 右下角那枚圆钮：配色与卡上那张一致，箭头是组里那套颜色 */
    const rr = 16 * s;
    const cx = W - 8 * s - rr;
    const cy = H - 8 * s - rr;
    ctx.fillStyle = btnBg;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(cx - 10 * s + 1 * s, cy - 10 * s);
    ctx.scale((20 * s) / 32, (20 * s) / 32);
    ctx.fillStyle = btnInk;
    ctx.fill(CARD_ARROW);
    ctx.restore();
  }

  /* 接住那一刻上卡：delay 让屏幕上那张影子先滑到掌心，两边别同时亮 */
  function holdCard(look, delay) {
    const c = ensureCard();
    if (look) {
      drawCard(look);
      c.tex.needsUpdate = true;
    }
    c.group.visible = true;
    c.group.scale.setScalar(0.86);
    c.mat.opacity = 0;
    cardAnim = {mode: 'in', t0: performance.now() + (delay || 0), dur: 260};
  }

  function releaseCard() {
    if (!cardMesh || !cardMesh.group.visible) return;
    cardAnim = {mode: 'out', t0: performance.now(), dur: 560};
  }

  function hideCardNow() {
    if (!cardMesh) return;
    cardMesh.group.visible = false;
    cardMesh.mat.opacity = 0;
    cardAnim = null;
  }

  /* 每帧把卡摆到掌心上方，再按「头部 → 卡心」这条线定朝向：
     卡面法线就沿这条线，平面与它垂直，所以卡既不歪着、也不会斜着挡脸。
     位置与朝向都在 rig 局部算，rig 自己的俯仰、侧倾会一起带上，
     卡片跟身体是一体的，不是贴在屏幕上的 */
  const _cardHead = new THREE.Vector3();
  const _cardN = new THREE.Vector3();
  const _cardX = new THREE.Vector3();
  const _cardY = new THREE.Vector3();
  const _cardM = new THREE.Matrix4();

  function stepCard(now) {
    if (!cardMesh || !cardMesh.group.visible) return;
    const g = cardMesh.group;
    if (palmWorld(_v)) {
      rig.worldToLocal(_v);
      const bob = Math.sin(now / 520) * 0.006;   /* 托着时的轻微起伏，和影子那版的 2.6px 一个意思 */
      /* 卡心压在掌心上方，横向往身体中线收一半 —— 手长在肩线外侧，完全跟着手走，
         这么宽一张卡会整块偏到身体一侧，法线也跟着斜。
         再往前推一点，卡片与胸口之间留出空隙，读起来是「托在身前」而不是贴在身上 */
      g.position.set(_v.x * 0.7, _v.y + CARD_LIFT + bob, _v.z + 0.05);
    }

    /* 头的参考点取头骨世界坐标再抬一点（骨骼原点在脖子根），
       连同卡心一起转回 rig 局部，后面的方向运算都在同一套坐标里 */
    const head = headBone || findModelBone('head');
    if (head) {
      head.getWorldPosition(_cardHead);
      _cardHead.y += 0.04;
      rig.worldToLocal(_cardHead);

      _cardN.subVectors(g.position, _cardHead);       /* 从头部指向卡心 */
      if (_cardN.lengthSq() < 1e-6) _cardN.set(0, -0.25, 1);
      _cardN.normalize();

      /* 先定平面里的「上」：世界竖直方向投到平面上，字的朝向就不会跟着卡面乱转。
         法线快贴到竖直时这个参考退化，改用前向来定 */
      _cardY.set(0, 1, 0);
      if (Math.abs(_cardN.dot(_cardY)) > 0.98) _cardY.set(0, 0, 1);
      _cardX.crossVectors(_cardY, _cardN).normalize();
      _cardY.crossVectors(_cardN, _cardX).normalize();
      _cardM.makeBasis(_cardX, _cardY, _cardN);
      g.quaternion.setFromRotationMatrix(_cardM);
    }

    if (cardAnim) {
      const p = THREE.MathUtils.clamp((now - cardAnim.t0) / cardAnim.dur, 0, 1);
      const e = p * p * (3 - 2 * p);
      if (cardAnim.mode === 'in') {
        cardMesh.mat.opacity = e;
        g.scale.setScalar(0.86 + 0.14 * e);
        if (p >= 1) cardAnim = null;
      } else {
        cardMesh.mat.opacity = 1 - e;
        g.scale.setScalar(1 - 0.4 * e);
        if (p >= 1) hideCardNow();
      }
    }
  }

  function pickUpCard(motionId, look) {
    clearIdleOffsets();
    if (!ready || !model || ritual) return false;
    const mood0 = moodId();
    ritual = {
      t0: performance.now(),
      motionId: motionId || null,
      mood0,
      fired: {},
      pitch: 0,
      roll: 0,
    };
    aimPaused = true;
    tYaw = 0;
    tPitch = 0;
    if (motionController?.activeId) motionController.stop();
    setMood('think');
    /* 卡面内容由卡片那一侧从 DOM 带过来；晚 120ms 起亮，
       让屏幕上那张跟手的影子先滑进掌心，两版不会同时出现在一个位置 */
    holdCard(look, look ? 120 : 0);
    if (REDUCED) renderer.setAnimationLoop(tick);
    return true;
  }

  const T0 = performance.now();
  let last = T0;
  let lastDraw = T0;
  /* 外部（弹窗）可以让它停一会儿：这段时间内 tick 直接空转，
     不推进 mixer 也不画。last 照样更新，恢复时 dt 不会攒成一大步 */
  let suspendUntil = 0;

  /* ——— 什么时候值得跑满帧 ———
     机器人一直在呼吸，画面没有一刻是完全静止的，但「呼吸」这种幅度
     30fps 也看不出间断。真正需要满帧的只有：指针在动、拖着卡、
     正走仪式、播动作、屏上有一次性的表情动画。其余时间降到 30fps，
     显卡留出余量，指针一进来立刻回到满帧，交互那几下才不会被
     常态渲染挤掉帧 */
  const IDLE_AFTER = 1200;      /* 最后一次交互之后多久转入低帧率 */
  let activeAt = T0;

  function markActive() { activeAt = performance.now(); }

  function wantsFullRate(now) {
    /* 减弱动态效果下循环本来就是「按需点火」的，每帧都是有事要画 */
    if (REDUCED) return true;
    /* 弹窗开着时面板压在正中，机器人只剩两侧一点，30fps 足够；
       省下来的这一半帧预算留给弹窗那边的缩放与重栅格。
       登录页盖住整片舞台，背后还要每帧重新模糊一次，同样降到低帧率 */
    if (document.body.classList.contains('is-modal') ||
        document.body.classList.contains('is-auth')) return false;
    if (ritual || cardDrag) return true;
    if (motionController && motionController.activeId) return true;
    if (now - activeAt < IDLE_AFTER) return true;
    return false;
  }

  /* ——— 分辨率降级 ———
     一秒统计一次丢帧比例（只统计满帧段，低帧率那段的 33ms 是故意的）。
     降档是最后手段：画质掉下来一眼就看得出来，所以要求连着两秒都掉得
     厉害才动一档，稍一平稳就立刻还回去 */
  let winStart = T0, winFrames = 0, winDrops = 0, badWins = 0, calmWins = 0, cooldownUntil = 0;

  function govern(now, frameMs, full) {
    if (!full) return;
    winFrames += 1;
    /* 21ms 约等于 60Hz 下漏掉一次垂直同步 */
    if (frameMs > 21) winDrops += 1;
    /* 样本太少不下结论：刚动一下鼠标就攒了三帧、里面掉一帧，
       按比例算是 33%，会平白降一档画质 */
    if (winFrames < 24 || now - winStart < 1000) return;

    const ratio = winDrops / Math.max(winFrames, 1);
    winStart = now;
    winFrames = 0;
    winDrops = 0;

    if (now < cooldownUntil) return;

    if (ratio > 0.3 && dprStep < DPR_STEPS.length - 1) {
      badWins += 1;
      calmWins = 0;
      /* 一两秒的抖动（切标签页回来、后台什么在抢核）不值得牺牲清晰度 */
      if (badWins >= 2) {
        badWins = 0;
        dprStep += 1;
        /* setPixelRatio 内部会带着新倍率再调一次 setSize，这里不用自己补 */
        renderer.setPixelRatio(DPR_STEPS[dprStep]);
        cooldownUntil = now + 2400;
      }
      return;
    }
    badWins = 0;

    /* 只要求连续三秒顺畅就还一档：宁可偶尔来回一次，也不让画面长期偏糊 */
    if (ratio < 0.05 && dprStep > 0) {
      calmWins += 1;
      if (calmWins >= 3) {
        calmWins = 0;
        dprStep -= 1;
        renderer.setPixelRatio(DPR_STEPS[dprStep]);
        cooldownUntil = now + 1800;
      }
    } else {
      calmWins = 0;
    }
  }

  const idleApplied = [];
  const idleDelta = new THREE.Quaternion();
  function clearIdleOffsets() {
    for (let index = idleApplied.length - 1; index >= 0; index--) {
      const [bone, delta] = idleApplied[index];
      bone.quaternion.multiply(delta.invert());
    }
    idleApplied.length = 0;
  }
  function tick() {
    const now = performance.now();
    const frameMs = now - last;
    const full = wantsFullRate(now);

    /* 让路窗口：整帧直接跳过，连 mixer 都不推。恢复时接着上一帧的姿态走 */
    if (now < suspendUntil) {
      last = now;
      lastDraw = now;
      return;
    }

    /* 低帧率段：整段逻辑一起隔帧跑。dt 不减，mixer 照样按真实时间推进，
       呼吸、眨眼的速度都不变，只是每两帧看一次 */
    if (!full && now - lastDraw < 31) return;
    lastDraw = now;

    const dt = Math.min(0.05, frameMs / 1000);
    last = now;
    govern(now, frameMs, full);

    clearIdleOffsets();
    if (mixer) mixer.update(dt);
    if (motionController) motionController.update(dt);
    if (ritual) stepRitual(now);
    const t = (now - T0) / 1000;
    const f = FRAMES[frame];

    /* 插值按 60fps 折算：软渲染掉到十几帧时每帧走的比例自动放大，
       到位时间仍是同一条曲线，推镜不会变成慢动作 */
    const kC = 1 - Math.pow(1 - CAM_EASE, dt * 60);
    const kR = 1 - Math.pow(1 - EASE, dt * 60);

    /* 推镜：高度与距离各自逼近目标，切档读起来是镜头往前送，不是硬切 */
    camY += (tgtY - camY) * kC;
    camD += (tgtD - camD) * kC;
    applyCam();

    yaw += (tYaw - yaw) * kR;
    pitch += (tPitch - pitch) * kR;
    rig.rotation.y = f.baseYaw + yaw + (aimPaused ? 0 : Math.sin(t * 0.28) * f.breathe);
    rig.rotation.x = pitch + (ritual ? ritual.pitch : 0);
    rig.rotation.z = ritual ? ritual.roll : 0;
    /* 要排在 mixer.update 之后：idle 每帧都会重写 head 骨骼 */
    stepHeadAim(dt);
    const idle = sampleIdle(now, poseMode || !!ritual || !!cardDrag ||
      !!motionController?.activeId || (!!activeAction && activeAction !== idleAction) ||
      document.body.classList.contains('is-modal'));
    if (joints && idle.active) {
      for (const [name, angle] of Object.entries(idle.offsets)) {
        const binding = joints[name];
        if (!binding) continue;
        idleDelta.setFromAxisAngle(binding.axis, angle);
        binding.bone.quaternion.multiply(idleDelta);
        idleApplied.push([binding.bone, idleDelta.clone()]);
      }
    }
    /* 也排在骨架姿态定下来之后：手里那张卡要读右手此刻的世界坐标 */
    stepCard(now);

    /* 表情约 15 帧重画一次：眨眼、点阵推进这类动作够顺，
       又不至于每帧都往显存重传一张 512 × 584 的图 */
    if (faceMats.length && now - faceStamp > 66) {
      faceStamp = now;
      screen.draw(t);
      faceTex.needsUpdate = true;
    }

    renderer.render(scene, camera);
  }

  /* 材质统一刷白：共享材质先克隆再改，避免同一份材质被改多次 */
  function paint(root) {
    const seen = new Map();
    root.traverse((o) => {
      if (!o.isMesh) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      const next = list.map((m) => {
        if (!m) return m;
        if (seen.has(m.uuid)) return seen.get(m.uuid);
        const c = m.clone();
        const n = m.name || '';
        /* 面罩与关节是模型自带的深色分区，刷白会把头盔和躯干抹成一片，
           所以这三档保留：face = 面罩、black = 关节、emissive = 胸前指示灯 */
        const visor = !DARK_AS_WHITE && n === 'face';
        const joint = !DARK_AS_WHITE && /black/i.test(n);
        const led = n === 'emissive';
        c.color.setHex(visor ? VISOR : joint ? DARK : WHITE);
        if (c.metalness !== undefined) c.metalness = visor ? 0.5 : joint ? 0.35 : 0.02;
        if (c.roughness !== undefined) c.roughness = visor ? 0.18 : joint ? 0.45 : 0.52;
        if (c.emissive) {
          c.emissive.setHex(led ? 0xffffff : 0x000000);
          c.emissiveIntensity = led ? 1 : 0;
        }
        if (c.map) c.map = null;
        if ('envMapIntensity' in c) c.envMapIntensity = 1.1;
        /* 模型只有一张 AO 烘焙图，没有颜色贴图：板缝、凹槽全靠它，
           按 1 走几乎看不出来，压到 2 倍才读得出分件 */
        if (c.aoMap) c.aoMapIntensity = 2.2;
        c.needsUpdate = true;
        seen.set(m.uuid, c);
        return c;
      });
      o.material = Array.isArray(o.material) ? next : next[0];
      o.frustumCulled = false;
    });
  }

  /* 把面罩改成一块屏：重投 UV，再把 canvas 贴图挂到 emissiveMap 上。
     原 UV 只够一张看不见的 AO 用，直接画上去会挤在角落，所以按几何
     自身的包围盒重算平面坐标 —— 面罩本地坐标里 x 是厚度（法线方向）、
     y 竖直、z 横向，而节点绕 y 转了约 -91°，本地 +z 落在世界 -x（屏幕
     左侧），所以 u 要反过来取，否则图案左右镜像 */
  function attachFace(root) {
    let mesh = null;
    root.traverse((o) => {
      if (mesh || !o.isMesh) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      if (list.some((m) => m && m.name === 'face')) mesh = o;
    });
    if (!mesh) return;

    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    if (!pos || !uv) return;
    geo.computeBoundingBox();
    const b = geo.boundingBox;
    if (!b) return;
    const spanY = b.max.y - b.min.y || 1;
    const spanZ = b.max.z - b.min.z || 1;
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, (b.max.z - pos.getZ(i)) / spanZ, (pos.getY(i) - b.min.y) / spanY);
    }
    uv.needsUpdate = true;

    faceMats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
      .filter((m) => m && m.name === 'face');
    faceMats.forEach((m) => {
      m.emissive.setHex(0xffffff);
      m.emissiveIntensity = 1.2;
      m.emissiveMap = faceTex;
      m.needsUpdate = true;
    });
  }

  /* 表情切换：立刻画一帧，不等下一个重绘节拍 */
  onMood(() => {
    markActive();
    screen.drawNow();
    faceTex.needsUpdate = true;
  });

  new GLTFLoader().load(MODEL_URL, (gltf) => {
    model = gltf.scene;
    paint(model);
    attachFace(model);

    /* 归一化：脚底 y=0、头顶 y=1、x/z 居中。包围盒按绑定姿势取，idle 只是
       原地呼吸，不会把头顶抬出这个范围 */
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    model.scale.setScalar(1 / size.y);
    model.updateMatrixWorld(true);
    box.setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box.min.y;
    motionRoot.add(model);
    /* 归一化之后身高就是 1，命中判定用它折算半径与圆心，之后不再量 */
    modelHeight = Math.max(box.max.y - box.min.y, 0.001);
    basePose = capturePose();

    if (gltf.animations && gltf.animations.length) {
      clips = gltf.animations;
      mixer = new THREE.AnimationMixer(model);
      mixer.addEventListener('finished', (event) => {
        if (event.action !== activeAction) return;
        playback = {clip: event.action.getClip().name, state: 'completed'};
        window.dispatchEvent(new CustomEvent('robot-playback', {detail: {...playback}}));
      });
      const clip = THREE.AnimationClip.findByName(gltf.animations, CLIP) || gltf.animations[0];
      idleAction = mixer.clipAction(clip);
      idleAction.setLoop(THREE.LoopRepeat, Infinity);
      idleAction.play();
      activeAction = idleAction;
      mixer.update(0.5);
      basePose = capturePose();
    }

    /* 头骨的绑定与基准姿势：idle 已经跑过一帧，这里拿到的就是循环里的姿态 */
    bindHead();
    bindPalm();

    motionController = createHomeMotionController(
      model,
      mixer,
      idleAction,
      setActiveMotion,
      () => { if (REDUCED) renderer.setAnimationLoop(tick); },
      {motionRoot},
    );
    /* 仪式要直接掰关节，这里拿一份「关节 → 骨骼 / 局部轴 / 绑定四元数」的映射；
       缺骨骼时退化成只动身体与表情，不影响拖卡片 */
    try { joints = createJointBindings(model); } catch (err) { joints = null; }

    fit(true);
    ready = true;
    playback = {clip: 'idle', state: 'playing'};
    // Paint a complete fitted frame before revealing the canvas or allowing
    // ready listeners to perform offscreen thumbnail rendering.
    rig.rotation.y = FRAMES[frame].baseYaw;
    screen.drawNow();
    faceTex.needsUpdate = true;
    renderer.render(scene, camera);
    window.dispatchEvent(new Event('robot-ready'));
    wrap.classList.add('is-ready');

    if (REDUCED) {
      rig.rotation.y = FRAMES[frame].baseYaw;
      renderer.render(scene, camera);
    } else {
      renderer.setAnimationLoop(tick);
    }
  }, undefined, (err) => {
    console.warn('[robot3d] 模型加载失败：', MODEL_URL, err);
  });

  if ('ResizeObserver' in window) {
    new ResizeObserver(() => { if (ready) fit(true); }).observe(wrap);
  } else {
    window.addEventListener('resize', () => { if (ready) fit(true); });
  }
  window.addEventListener('resize', () => { if (ready) fit(true); });

  document.addEventListener('visibilitychange', () => {
    if (!ready || REDUCED) return;
    renderer.setAnimationLoop(document.hidden ? null : tick);
  });

  function playGesture(id) {
    if (!motionController || !motionController.getInfo(id)) return false;
    window.dispatchEvent(new Event('robot-manual-motion'));
    return startGesture(id);
  }
  function startGesture(id) {
    clearIdleOffsets();
    if (!motionController) return;
    if (activeAction && activeAction !== idleAction) activeAction.stop();
    poseMode = false;
    activeAction = idleAction;
    return motionController.play(id);
  }
  const paintMotionControls = mountHomeMotionControls(playGesture);
  setActiveMotion = (id) => {
    paintMotionControls(id);
    setPointerAimPaused(POINTER_PAUSE_MOTIONS.has(id), 'dance');
  };

  /* —— 右栏手势卡的缩略图 ——
     机器人只有一个，卡却要好几张小图。拿主渲染器渲到一张离屏 target 上，
     每张拍一次、读回像素转 PNG，之后直接吃缓存；姿势用动作库里同一份采样
     （sampleMotionFrame，时间轴动作用它自己的轨道和站姿），拍完把骨骼与朝向
     原样放回，主画面不会留下一个歪着的定格。 */
  const THUMB = 128;
  let thumbTarget = null;
  const thumbCache = Object.create(null);
  /* 定格在动作的第几成处。默认 0.42：起手与收招都夹着一截静止，
     中间偏前一点才看得出在做哪个动作；个别动作的看点不在这儿 ——
     捧腹大笑在 0.29（第三秒上下，双手正捧着肚子），再往后就抬手抱头了 */
  const THUMB_AT = {belly_laugh: 0.29};
  const THUMB_DEFAULT_AT = 0.42;
  /* 正交取景：正交相机的 top/bottom 是相对镜头中心的高度偏移，不是世界坐标，
     所以先定中心 y，再给 ±0.65 —— 世界 y 落在 -0.10 ~ 1.20。
     上沿多留一点是给「加油 / 伸懒腰」这类举手过顶的动作，别把手裁在边上 */
  const THUMB_HALF = 0.65;
  const thumbCam = new THREE.OrthographicCamera(-THUMB_HALF, THUMB_HALF, THUMB_HALF, -THUMB_HALF, 0.05, 12);
  thumbCam.position.set(0, 0.55, 3);
  thumbCam.lookAt(0, 0.55, 0);

  /* 按关节角摆姿势：先把同一根骨骼上的关节归到一起，再在绑定四元数上
     依次乘上各自的轴角（与 buildClip 里生成关键帧的算法一致），
     否则同一根骨骼的第二个关节会把第一个覆盖掉。
     base 是该动作的自然站姿：十个打散姿态的动作共用 Q1_REST_POSE，
     时间轴那两支自带一份（腿上的关节基线与前者相同），由调用方一起传进来 */
  function setJointPose(pose, base = Q1_REST_POSE) {
    if (!joints) return;
    const groups = new Map();
    Object.keys(joints).forEach((joint) => {
      const j = joints[joint];
      if (!groups.has(j.bone)) groups.set(j.bone, {bone: j.bone, rest: j.rest, items: []});
      groups.get(j.bone).items.push({joint, axis: j.axis});
    });
    const q = new THREE.Quaternion();
    groups.forEach(({bone, rest, items}) => {
      bone.quaternion.copy(rest);
      items.forEach(({joint, axis}) => {
        const at = base[joint] ?? 0;
        bone.quaternion.multiply(q.setFromAxisAngle(axis, (pose[joint] ?? at) - at));
      });
    });
    if (model) model.updateMatrixWorld(true);
  }

  function motionThumb(id) {
    if (!ready || !model || !joints) return '';
    if (thumbCache[id]) return thumbCache[id];
    const frame = sampleMotionFrame(id, THUMB_AT[id] ?? THUMB_DEFAULT_AT);
    if (!frame) return '';

    if (!thumbTarget) {
      thumbTarget = new THREE.WebGLRenderTarget(THUMB, THUMB, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      thumbTarget.texture.colorSpace = THREE.SRGBColorSpace;
    }

    const savedPose = capturePose();
    const savedRot = rig.rotation.clone();
    const savedTarget = renderer.getRenderTarget();
    /* 手里那张卡挂在 rig 下，别让它闯进缩略图里 */
    const cardWas = cardMesh ? cardMesh.group.visible : false;
    if (cardWas) cardMesh.group.visible = false;

    /* 稍微侧一点：纯正面时前后摆臂会被压成一条竖线，看不出在做哪个动作 */
    rig.rotation.set(0, 0.34, 0);
    setJointPose(frame.pose, frame.rest);

    const pixels = new Uint8Array(THUMB * THUMB * 4);
    renderer.setRenderTarget(thumbTarget);
    renderer.clear();
    renderer.render(scene, thumbCam);
    renderer.readRenderTargetPixels(thumbTarget, 0, 0, THUMB, THUMB, pixels);
    renderer.setRenderTarget(savedTarget);

    rig.rotation.copy(savedRot);
    if (cardWas) cardMesh.group.visible = true;
    applyPose(savedPose);
    if (REDUCED) renderer.render(scene, camera);

    /* 读回来的像素是自下而上排的，翻一次再写进 canvas */
    const out = document.createElement('canvas');
    out.width = out.height = THUMB;
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(THUMB, THUMB);
    for (let y = 0; y < THUMB; y++) {
      const src = (THUMB - 1 - y) * THUMB * 4;
      img.data.set(pixels.subarray(src, src + THUMB * 4), y * THUMB * 4);
    }
    ctx.putImageData(img, 0, 0);
    thumbCache[id] = out.toDataURL('image/png');
    return thumbCache[id];
  }

  window.robot3d = {
    scene, camera, renderer, rig,
    get model() { return model; },
    get ready() { return ready; },
    get clips() { return clips.map(c => c.name); },
    get playback() { return {...playback}; },
    playClip,
    get mixer() { return mixer; },
    get action() { return activeAction; },
    get poseMode() { return poseMode; },
    get idleState() { return idleState(); },
    get viewHeading() { return FRAMES[frame].baseYaw; },
    freezePose,
    resetPose,
    setPointerAimPaused,
    get framing() { return frame; },
    get mood() { return moodId(); },
    /* 外部（比如接上聊天状态）直接调这个换表情，底栏那排缩略图会跟着点亮 */
    setMood,
    playGesture(id, options = {}) { return options.source === 'chat' ? startGesture(id) : playGesture(id); },
    getGestureInfo(id) { return motionController ? motionController.getInfo(id) : null; },
    getMotionCatalog() { return motionController ? motionController.getCatalog() : []; },
    stopGesture() { if (motionController) motionController.stop(); },
    /* 右栏手势卡要的那张小图：第一次调用现拍一张 PNG，之后走缓存 */
    motionThumb,
    /* 拖卡片那一套：命中判定、右手屏幕坐标、接住后走完仪式再播动作 */
    hitTest,
    handScreen,
    pickUpCard,
    beginCardDrag,
    endCardDrag,
    get cardDrag() { return cardDrag; },
    get cardRitual() { return ritual ? {motionId: ritual.motionId} : null; },
    /* 弹窗那一侧叫的：让路 ms 毫秒（不画、不推进动画），用来给弹出动画腾帧 */
    suspend(ms) {
      suspendUntil = Math.max(suspendUntil, performance.now() + (ms || 0));
    },
    /* Settings 那组按钮调这里：切档 → 重算相机目标 → 交给 tick 推过去 */
    setFraming(key) {
      const next = key === 'head' ? 'head' : 'body';
      if (next === frame) return;
      frame = next;
      aim();
      fit(REDUCED);
      /* 推镜这一段要看得出是「镜头往前送」，低帧率下会一顿一顿 */
      markActive();
      if (REDUCED) renderer.render(scene, camera);
    },
  };
}
