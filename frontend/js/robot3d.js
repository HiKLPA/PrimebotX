/* 主页中央的机器人本体，模型是 model/q1_ff.glb（Q1 基础形态，取自 PrimeFLOW
   的 /res/models/q1_ff.glb，6.4MB / 17 万面 / 带骨骼与 8 段动画）。
   只做展示、不接仿真：播 idle 呼吸，指针移动时身体与头部跟着转向。

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
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createScreen, onMood, moodId, setMood } from './faces.js?v=3';

const MODEL_URL = 'model/q1_ff.glb';
const CLIP = 'idle';        /* 循环动画名；模型自带 apose/idle/standby/raisehand 等 8 段 */
const FRAME_KEY = 'px.bot'; /* 与 Settings 里那组按钮共用同一个键 */

/* 每一档：可见段上下沿（归一化身高）、留白、基础朝向、转幅、俯仰、呼吸。
   body 的 yaw 是「指针贴到屏幕边」时多转的角度，0.08 约 4.6°；
   head 直接用 Math.PI/6，就是左右各 30° */
const FRAMES = {
  body: { top: 1,     bottom: 0.48,  fill: 0.95, baseYaw: 0.22, yaw: 0.08,       pitch: 0.025, breathe: 0.02 },
  head: { top: 1.03,  bottom: 0.81,  fill: 0.92, baseYaw: 0,    yaw: Math.PI / 6, pitch: 0,     breathe: 0.006 },
};
const ARM_SPAN = 0.5;       /* 含边距的臂展（归一化到身高），窄屏时用它挡横向溢出 */

const WHITE = 0xf7f7f7;     /* 壳体白 */
const DARK = 0x2f3134;      /* 关节、护甲缝隙的深色 */
const VISOR = 0x1b1d20;     /* 面罩：比关节再深一档，压成镜面 */
const DARK_AS_WHITE = false;/* true = 连面罩一起刷白，整台纯白（会丢掉五官） */

const EASE = 0.07;          /* 转身、俯仰的跟随速度 */
const CAM_EASE = 0.09;      /* 推镜速度：切档时相机沿这条曲线走过去 */

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const stage = document.querySelector('.stage');
if (stage) init();

function init() {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    return;   /* 没有 WebGL 就只留点阵背景，不影响页面 */
  }

  const wrap = document.createElement('div');
  wrap.className = 'robofx';
  wrap.appendChild(renderer.domElement);
  stage.appendChild(wrap);

  /* 满屏画布 + 17 万面：4K 上按 2 倍采样白烧填充率，封到 1.75 看不出差别 */
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
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
  scene.add(rig);

  let mixer = null, model = null, ready = false;
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

  /* 画面是满屏的（CSS inset:0），两档各自算一套相机参数：body 让腰线压在
     画布下边缘，head 把整颗头放在画面正中。这里只写目标值，相机由 tick 插值过去 */
  function fit(instant) {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
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
      const topInset = parseFloat(getComputedStyle(wrap).getPropertyValue('--robofx-top')) || 88;
      const avail = Math.max(160, h - topInset);   /* 机器人可见段要占的高度 */
      /* 纵向：可见段占 avail 像素。画布比 avail 高，所以同一段在世界里
         要摊到 h 那么高，距离按 h / avail 放大 */
      const distV = (span * h) / (avail * 2 * tanV);
      /* 横向：窄窗时先撑满的是横向。0.5 是含边距的臂展（实测约 0.45 身高），
         窄屏纵向撑满后宽度会顶到九成，收一档让它离边远一点 */
      const distH = ARM_SPAN / (2 * tanV * camera.aspect);
      tgtD = Math.max(distV, distH) / f.fill;
      /* 让下沿那个高度正好落在画布下边缘：目标点抬到 bottom + dist*tanV，
         底边就贴着腰线。再往上挪画面就回来了 */
      tgtY = f.bottom + tgtD * tanV;
    }

    if (instant || REDUCED || !camPlaced) {
      camY = tgtY;
      camD = tgtD;
      camPlaced = true;
      applyCam();
    }
  }

  function applyCam() {
    camera.position.set(0, camY, camD);
    camera.lookAt(0, camY, 0);
  }

  if (!REDUCED) {
    window.addEventListener('pointermove', (e) => {
      nx = (e.clientX / window.innerWidth - 0.5) * 2;
      ny = (e.clientY / window.innerHeight - 0.5) * 2;
      aim();
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

  const T0 = performance.now();
  let last = T0;
  function tick() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (mixer) mixer.update(dt);
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
    rig.rotation.y = f.baseYaw + yaw + Math.sin(t * 0.28) * f.breathe;
    rig.rotation.x = pitch;

    /* 表情约 20 帧重画一次：眨眼、点阵推进这类动作够顺，
       又不至于每帧都往显存重传一张 512 × 584 的图 */
    if (faceMats.length && now - faceStamp > 50) {
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
    rig.add(model);

    if (gltf.animations && gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      const clip = THREE.AnimationClip.findByName(gltf.animations, CLIP) || gltf.animations[0];
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      if (REDUCED) mixer.update(0.5);
    }

    fit(true);
    ready = true;
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

  window.robot3d = {
    scene, camera, renderer, rig,
    get model() { return model; },
    get framing() { return frame; },
    get mood() { return moodId(); },
    /* 外部（比如接上聊天状态）直接调这个换表情，底栏那排缩略图会跟着点亮 */
    setMood,
    /* Settings 那组按钮调这里：切档 → 重算相机目标 → 交给 tick 推过去 */
    setFraming(key) {
      const next = key === 'head' ? 'head' : 'body';
      if (next === frame) return;
      frame = next;
      aim();
      fit(REDUCED);
      if (REDUCED) renderer.render(scene, camera);
    },
  };
}
