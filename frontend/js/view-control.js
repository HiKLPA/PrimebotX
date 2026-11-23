import * as THREE from 'three';

/* 两个循环轴。方位不写东南西北，按眼睛看到的位置直接报「正 / 左 / 右 / 后」；
   俯仰三档「上 / 平 / 下」。
   rotate 是方位图标里那支箭头的转角：基准图形箭头朝下（正对观众），
   左视把相机挪到左边，箭头就转过 270°；后视翻 180° 朝上。
   水平那枚按数组顺序走：正 → 左 → 右 → 后 → 正，想换顺序只动这个数组 */
const VIEW_CYCLE = [
  { key: 'front', label: '正', azimuth: 0,   rotate: 0 },
  { key: 'left',  label: '左', azimuth: -90, rotate: 270 },
  { key: 'right', label: '右', azimuth: 90,  rotate: 90 },
  { key: 'back',  label: '后', azimuth: 180, rotate: 180 },
];
const TILT_CYCLE = [
  { key: 'up',    label: '上', elevation: 89 },
  { key: 'level', label: '平', elevation: 0 },
  { key: 'down',  label: '下', elevation: -89 },
];
const TILT_UP = TILT_CYCLE[0];
const TILT_LEVEL = TILT_CYCLE[1];
const TILT_DOWN = TILT_CYCLE[2];
/* 俯仰超过这一档就归到上/下，其余算平 */
const TILT_SPLIT = 45;

const JOINT_CONFIGS = {
  'body1':    { axis: 'yaw', axes: ['yaw', 'pitch'], range: [-1.571, 1.571] },
  'head':     { axis: 'yaw',   range: [-1.2, 1.2] },
  'Bone.005': { axis: 'pitch', range: [-3.142, 1.571] },
  'Bone.006': { axis: 'roll', input: 'vertical', sign: -1, range: [-0.087, 2.792] },
  'Bone.007': { axis: 'yaw', input: 'horizontal', sign: 1, range: [-1.571, 1.571] },
  'Bone.008': { axis: 'pitch', range: [-0.873, 1.658] },
  'Bone.009': { axis: 'pitch', range: [-3.142, 1.571] },
  'Bone.010': { axis: 'roll', input: 'vertical', sign: 1, range: [-2.792, 0.087] },
  'Bone.011': { axis: 'yaw', input: 'horizontal', sign: -1, range: [-1.571, 1.571] },
  'Bone.012': { axis: 'pitch', range: [-0.873, 1.658] },
  'Bone.030': { axis: 'pitch', range: [-3.054, 1.571] },
  'Bone.032': { axis: 'roll',  range: [-0.698, 1.571] },
  'Bone.033': { axis: 'yaw',   range: [-1.571, 1.571] },
  'Bone.035': { axis: 'pitch', range: [0, 2.443] },
  'Bone.037': { axis: 'pitch', range: [-0.785, 0.436] },
  'Bone.038': { axis: 'roll',  range: [-0.349, 0.349] },
  'Bone.031': { axis: 'pitch', range: [-3.054, 1.571] },
  'Bone.034': { axis: 'roll',  range: [-1.571, 0.698] },
  'Bone.036': { axis: 'yaw',   range: [-1.571, 1.571] },
  'Bone.039': { axis: 'pitch', range: [0, 2.443] },
  'Bone.040': { axis: 'pitch', range: [-0.785, 0.436] },
  'Bone.041': { axis: 'roll',  range: [-0.349, 0.349] },
};

const WAIST_YAW_CONFIG = { axis: 'yaw', input: 'horizontal', sign: 1, range: [-1.571, 1.571] };
const WAIST_PITCH_CONFIG = { axis: 'pitch', input: 'vertical', sign: -1, range: [-0.35, 0.35] };

const JOINT_AXES = {
  pitch: new THREE.Vector3(1, 0, 0),
  roll: new THREE.Vector3(0, 0, 1),
  yaw: new THREE.Vector3(0, 1, 0),
};

const ROOT_JOINTS = new Set(['Bone.001', 'Bone.002']);
const SHOULDER_PITCH_ROOTS = {
  'Bone.006': 'Bone.005',
  'Bone.010': 'Bone.009',
};

const DRAG_START_PX = 3;
const JOINT_PIXEL_TO_RAD = 0.009;
const ORBIT_PIXEL_TO_DEG = 0.35;
const TILT_PIXEL_TO_DEG = 0.3;
const WHEEL_ZOOM_K = 0.0012;
/* 缩放系数：1 就是各档取景算出的那个距离。
   近端 0.5 是以头为锚点往里推，机身跟着上下张开；
   远端 1.25 只留四分之一圈的余量 —— 取景本来就把机身顶到上下沿，
   再往外退只会让脚下空出一片，观感上只是变小 */
const DISTANCE_MIN = 0.5;
const DISTANCE_MAX = 1.25;
const ELEVATION_LIMIT = 89;
const HOVER_DELAY_MS = 60;
const WAIST_TRIGGER_Y = 0.045;
const SHOULDER_PITCH_RADIUS = 0.045;
const DEFAULT_VIEW_KEY = 'primebotx.default-view';
const FRONT_VIEW = Object.freeze({ azimuth: 0, elevation: 0, distance: 1, mode: 'front' });

let robo = null;
let wrap = null;
let camera = null;
let dock = null;
let panel = null;
let viewButton = null;
let azimuthButton = null;
let tiltButton = null;
let marker = null;
let markerBone = null;
let limbBone = null;
let limbMeshes = [];
let ready = false;
const viewAdapters = new Set();

const raycaster = new THREE.Raycaster();
const ndcPoint = new THREE.Vector2();
const jointAxisParents = new Map();
let defaultView = loadDefaultView();
const view = {
  azimuth: defaultView.azimuth,
  elevation: defaultView.elevation,
  distance: defaultView.distance,
};
const pointer = { x: 0, y: 0 };
let drag = null;
let lastCamY = 0;
let lastCamD = 1;
/* 缩放基准点：滚轮缩放以头部为准，头在画面里的位置保持不变。
   zoomAnchorS 是头部在视锥里的纵向归一化偏移（屏幕上那个位置与它成正比，
   定义见 zoom()），缩放时用它反解新的注视点高度，偏移就不变。
   null 表示还没缩放过，镜头仍按取景算出的注视点走 */
let zoomAnchorS = null;
let zoomBaseCamY = 0;   /* 上一次取景给出的注视高度，用来识别切档 / resize */
let lastLookY = 0;      /* 上一帧实际使用的注视点高度 */
let hoverTimer = 0;
let hoverPoint = null;
let hoverCanPose = false;

const tempVec = new THREE.Vector3();
const tempScale = new THREE.Vector3();
/* 机器人整体的屏幕外接矩形：整块 .robofx 铺满视口，指针压在任何地方都会
   走到悬浮判定上，而真正需要射线求交的只有机器人身上那一小块。先投一次
   包围盒（8 个角），落在外面就直接返回，省掉一次遍历全模型的三角形求交 */
let modelBox = null;
let screenRect = null;
let screenRectAt = 0;
const rectBox = new THREE.Box3();
const rectCorner = new THREE.Vector3();

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/* 指数逼近：每秒走掉 (1 - e^(-dt/τ)) 的剩余距离，帧率高低都是同一条曲线。
   比 gsap 轻，也不需要一次动画注册一个补间 —— 关节高亮是逐帧状态，
   不是一次性的入场，目标随时可能被下一次悬浮改掉 */
function approach(current, target, dt, tau) {
  if (current === target) return target;
  const next = current + (target - current) * (1 - Math.exp(-dt / tau));
  return Math.abs(target - next) < 0.002 ? target : next;
}

/* 固定时长的两档过渡，给关节标记和高亮颜色用。
   上面那条指数曲线走的「距离」取决于起点：刚碰到关节就移开，
   褪色只剩很短的一截，看着像动画被掐掉。这里每次目标一变就从当前值
   重新计时、走满整段时长，进场短、退场长，离开后一定能看到完整的一趟。
   曲线用 easeOutCubic：起手快、落定缓，与页面里那一档手感一致 */
function makeGlide(value) {
  return { value: value, from: value, to: value, k: 1 };
}

function glide(state, target, dur, dt) {
  if (state.to !== target) {
    state.from = state.value;
    state.to = target;
    state.k = 0;
  }
  if (state.k < 1) {
    state.k = Math.min(1, state.k + dt / dur);
    const e = 1 - Math.pow(1 - state.k, 3);
    state.value = state.from + (state.to - state.from) * e;
  }
  return state.value;
}

/* 直接落到某个值、把过渡状态一起归位（新关节出现、材质已还原时用） */
function resetGlide(state, value) {
  state.value = value;
  state.from = value;
  state.to = value;
  state.k = 1;
}

function normalizeAngle(value) {
  return THREE.MathUtils.euclideanModulo(value + 180, 360) - 180;
}

function loadDefaultView() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEFAULT_VIEW_KEY) || 'null');
    if (!saved || !Number.isFinite(saved.azimuth) || !Number.isFinite(saved.elevation)) {
      return {...FRONT_VIEW};
    }
    return {
      azimuth: normalizeAngle(saved.azimuth),
      elevation: clamp(saved.elevation, -ELEVATION_LIMIT, ELEVATION_LIMIT),
      distance: Number.isFinite(saved.distance)
        ? clamp(saved.distance, DISTANCE_MIN, DISTANCE_MAX)
        : 1,
      mode: saved.mode === 'custom' ? 'custom' : 'front',
    };
  } catch (error) {
    return {...FRONT_VIEW};
  }
}

function saveDefaultView(next) {
  defaultView = {...next};
  try {
    localStorage.setItem(DEFAULT_VIEW_KEY, JSON.stringify(defaultView));
  } catch (error) {
    /* Private browsing may reject storage; the default still works this session. */
  }
  refreshDefaultViewButtons();
}

function canonicalJointName(name) {
  return /^Bone\d+$/.test(name) ? name.replace(/^Bone(\d+)$/, 'Bone.$1') : name;
}

function jointConfigForName(name) {
  return JOINT_CONFIGS[name] || JOINT_CONFIGS[canonicalJointName(name)] || null;
}

function cacheJointAxes() {
  const parentQuaternion = new THREE.Quaternion();
  robo.model.traverse((bone) => {
    const config = jointConfigForName(bone.name);
    if (!bone.isBone || !config || !bone.parent) return;
    bone.parent.getWorldQuaternion(parentQuaternion);
    parentQuaternion.invert();
    const axisNames = config.axes || [config.axis];
    axisNames.forEach((axisName) => {
      const axis = JOINT_AXES[axisName].clone().applyQuaternion(parentQuaternion).normalize();
      jointAxisParents.set(bone.uuid + ':' + axisName, axis);
    });
  });
}

function cachedJointAxis(bone, axisName) {
  return (jointAxisParents.get(bone.uuid + ':' + axisName) || JOINT_AXES[axisName]).clone();
}

function boot() {
  robo = window.robot3d;
  if (!robo || !robo.ready || !robo.model) return;
  wrap = document.querySelector('.robofx');
  if (!wrap) return;

  camera = robo.camera;
  ready = true;
  robo.model.updateMatrixWorld(true);
  /* 绑定姿势下的整体包围盒量一次：判「指针在不在机器人身上」用它，
     比每次去遍历 63 个网格划算得多 */
  modelBox = new THREE.Box3().setFromObject(robo.model);
  cacheJointAxes();

  createMarker();
  bindInteractions();
  buildPanel();
  bindResetAndDefaultControls();
  wrap.classList.add('vc-enabled');
  window.__robotView = { step };
  // Preserve the fitted camera on handoff. A zero-height, unit-distance
  // camera points at the legs until the next animation frame repairs it.
  step(camera.position.y, camera.position.z);
}

function step(camY, camD) {
  if (!ready) return;
  /* 取景基础高度变了（切 body / head、窗口尺寸变化）：旧的缩放锚点作废，
     否则镜头会硬钉着上一套取景里的头，和新的构图互相拽 */
  if (Math.abs(camY - zoomBaseCamY) > 0.004) {
    zoomBaseCamY = camY;
    zoomAnchorS = null;
  }
  lastCamY = camY;
  lastCamD = camD;
  const heading = robo.viewHeading || 0;
  const azimuth = heading + THREE.MathUtils.degToRad(view.azimuth);
  const elevation = THREE.MathUtils.degToRad(view.elevation);
  /* head 档整帧按纯取景走：倍数与缩放锚点都不参与，一颗头正好占满画面。
     view.distance 本身不动 —— body 档存下的远近留着，切回去原样接上 */
  const headLock = zoomLocked();
  const distance = camD * (headLock ? 1 : view.distance);
  const horizontal = Math.cos(elevation) * distance;

  /* 缩放中：注视点由「头部在画面里的固定偏移」反推，相机绕它转，
     头就钉在原处，身体随远近张开或收拢；没缩放时仍是取景给出的高度。
     分母里那项 x·sinE 是俯仰带来的深度变化，扣掉之后抬头、低头时也能钉住 */
  const sinE = Math.sin(elevation);
  const denom = zoomAnchorS === null ? 0 : 1 - zoomAnchorS * sinE;
  const lookY = headLock || zoomAnchorS === null || Math.abs(denom) < 0.2
    ? camY
    : headAnchorY() - (zoomAnchorS * distance) / denom;
  lastLookY = lookY;

  camera.position.set(
    Math.sin(azimuth) * horizontal,
    lookY + Math.sin(elevation) * distance,
    Math.cos(azimuth) * horizontal
  );

  if (view.elevation >= 89.99) {
    camera.up.set(-Math.sin(heading), 0, -Math.cos(heading));
  } else if (view.elevation <= -89.99) {
    camera.up.set(Math.sin(heading), 0, Math.cos(heading));
  } else {
    camera.up.set(0, 1, 0);
  }
  camera.lookAt(0, lookY, 0);
  /* 只要相机自己的矩阵：它没有父级，force 传 true 反而会把整棵场景树重建一遍 */
  camera.updateMatrixWorld();
  /* 关节标记的尺寸按屏幕像素算，必须等相机这一帧的位姿定下来再写；
     缓动也挂在这里，robot3d 每帧调一次 step，正好当刷新节拍 */
  updateJointFx();

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    robo.renderer.render(robo.scene, camera);
  }
  publishView();
}

function currentViewState() {
  return {
    azimuth: view.azimuth,
    elevation: view.elevation,
    distance: view.distance,
    azimuthPreset: nearestAzimuth(view.azimuth).key,
    tiltPreset: nearestTilt(view.elevation).key,
  };
}

/* 皮肤可以拥有自己的场景与相机。它们注册一个适配器后，
   顶栏方向、缩放和复位按钮都作用于当前显示的皮肤。 */
function publishView(source = 'view-control') {
  refreshViewButtons();
  const snapshot = currentViewState();
  viewAdapters.forEach((adapter) => {
    if (typeof adapter.isActive === 'function' && !adapter.isActive()) return;
    try {
      adapter.setView({...snapshot}, {source});
    } catch (error) {
      console.error('[view-control] view adapter failed:', error);
    }
  });
}

function registerViewAdapter(adapter) {
  if (!adapter || typeof adapter.setView !== 'function') return () => {};
  viewAdapters.add(adapter);
  if (typeof adapter.isActive !== 'function' || adapter.isActive()) {
    try {
      adapter.setView(currentViewState(), {source: 'register'});
    } catch (error) {
      console.error('[view-control] view adapter failed:', error);
    }
  }
  return () => viewAdapters.delete(adapter);
}

/* 关节标记与肢体高亮都取 --hint：模型颜色虽然写在 three 里，
   色值仍以 design token 为准，主题换了下次悬浮就会拿到新值。
   缓存一份 Color，raw 没变就不再新建 */
let hintColor = null;
let hintRaw = '';

function hintTint() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--hint').trim() || '#5f9b73';
  if (!hintColor || raw !== hintRaw) {
    hintRaw = raw;
    hintColor = new THREE.Color(raw);
  }
  return hintColor;
}

/* ---- 关节标记 ----
   球体按屏幕像素定大小：半径固定 12px，相机推近拉远、换机型都不变。
   换算见 updateMarker 里那几行 —— fov 24 的透视相机，距离 d 处一屏高
   相当于 2·d·tan(fov/2) 个世界单位，除以画布高度就是每像素多少世界单位；
   再除掉骨骼自己的世界缩放，得到的局部 scale 才落在 12px。
   出现不是「啪」地亮一下：位移上没有变化，尺寸从 15% 涨到 100%、
   透明度从 0 涨到悬停档，两条共用同一段固定时长，读起来是颜色从关节
   中心填出来。按下拖动时透明度再缓缓升到选中档，松手缓缓退回 ——
   两个档位之间不再是直接赋值那种跳。 */
const MARKER_RADIUS_PX = 12;
const MARKER_OPACITY_IDLE = 0.50;
const MARKER_OPACITY_ACTIVE = 0.75;
/* 时长（秒）：出现 110ms、退场 220ms，比原来那条指数曲线更快到位，
   退场仍比进场长一倍，收得从容但不拖尾 */
const MARKER_IN = 0.11;
const MARKER_OUT = 0.22;
/* 拖动加深那一档还是指数逼近：它不是「出现/离开」，是两个状态之间的深浅，
   跟着指针走，不需要一段固定时长 */
const MARKER_SELECT_TAU = 0.12;
/* 涨开的起点：15% 半径配 0 透明度，肉眼看是从一个点铺开成圆 */
const MARKER_GROW_FROM = 0.15;

const markerFx = { ap: makeGlide(0), select: 0, want: false, active: false };

function createMarker() {
  const geometry = new THREE.SphereGeometry(1, 16, 12);
  const material = new THREE.MeshBasicMaterial({
    color: 0x5f9b73,
    transparent: true,
    opacity: MARKER_OPACITY_IDLE,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  material.color.copy(hintTint());
  marker = new THREE.Mesh(geometry, material);
  marker.name = '__robot_joint_marker';
  marker.userData.viewMarker = true;
  marker.renderOrder = 999;
  marker.visible = false;
}

/* ---- 肢体高亮 ----
   关节一转，跟着动的就是它下面那整根骨骼链（模型里每个零件都挂在骨节点下，
   没有蒙皮权重），所以「会动的肢体」= 该骨骼的全部后代节点里的 mesh。
   做法是给这些 mesh 换一份自己独占的材质副本（原材质可能被身体别处共用，
   直接改会把别的部位一起染绿），离开时把原材质接回去、副本丢掉。
   只动基色一路，比例就是 --hint 压在原色上的等效不透明度：
   壳是近白的，0.25 约等于叠一层四分之一浓度的 hint，暗部保持原样。
   副本记着自己的底色，每帧按一个 0…1 的比例往 hint 上靠，
   所以离开时是缓缓褪回原色再还原材质，按下拖动时比例再推深一档 */
const TINT_MIX = 0.25;
/* 按下拖动时再推深一档：与标记的透明度同步加重，而不是整块肢体突然变色 */
const TINT_MIX_ACTIVE = 0.40;
const TINT_IN = 0.13;
/* 退场比进场长一倍：离开关节时颜色完整地褪一趟，而不是刚缩回一点就被还原 */
const TINT_OUT = 0.30;
const TINT_SELECT_TAU = 0.12;

const tintFx = { gl: makeGlide(0), select: 0, want: false, active: false };
/* 本轮高亮取到的 --hint：--hint 是计算样式，逐帧读会逼着浏览器重算样式，
   所以一条肢体只读一次，换关节或换主题时才重新取 */
let limbHint = null;

/* 复制一份材质，并把「没被染过」的底色记在副本自己的 userData 上。
   每帧的染色都是「底色 → hint」的插值，所以渐入渐出只需改一个 0…1 的
   比例，不必反复克隆材质，也不用在结束时猜原来是什么颜色 */
function tintRecord(material) {
  if (Array.isArray(material)) return material.map(tintRecord);
  if (!material) return material;
  /* 面罩的自发光承载表情贴图、胸前指示灯本身就是发光件，
     染成 hint 会把它们本来的颜色盖掉，这两类原样返回 */
  if (/^(face|emissive)$/i.test(material.name || '')) return material;
  const tinted = material.clone();
  tinted.userData.vcBase = tinted.color ? tinted.color.clone() : null;
  tinted.needsUpdate = true;
  return tinted;
}

/* 按当前比例把一份副本染到 hint 上：底色向 hint 插值，
   mix 就等于「hint 以这个不透明度叠在底色上」 */
function applyTint(material, mix, hint) {
  if (Array.isArray(material)) {
    material.forEach((item) => applyTint(item, mix, hint));
    return;
  }
  if (!material || !material.userData) return;
  const base = material.userData.vcBase;
  if (!base || !material.color) return;
  material.color.copy(base).lerp(hint, mix);
}

function highlightLimb(bone) {
  if (!bone) return;
  /* 同一根骨骼：只把目标重新点亮，正在淡出的那一段接着往上走，
     不重新建副本 —— 否则悬停在同一个关节上会看到两次涨开 */
  if (limbBone === bone) {
    tintFx.want = true;
    return;
  }
  /* 换到另一根骨骼：上一根直接接回原材质，不做交叉淡化。
     两根骨骼的子树会重叠（骨骼是嵌套的），留着一起淡会互相覆写副本 */
  restoreLimb();
  const hint = hintTint();
  limbHint = hint.clone();
  const meshes = [];
  bone.traverse((node) => {
    if (!node.isMesh || node.userData.viewMarker) return;
    meshes.push(node);
  });
  meshes.forEach((mesh) => {
    const original = mesh.material;
    const tinted = tintRecord(original);
    mesh.userData.vcTint = { original, tinted };
    mesh.material = tinted;
    applyTint(tinted, 0, limbHint);
  });
  limbBone = bone;
  limbMeshes = meshes;
  resetGlide(tintFx.gl, 0);
  tintFx.want = true;
}

/* 离开关节：只把目标关掉，真正的还原交给每帧 —— 等 level 收到 0 再
   接回原材质，这样褪色那条不会被从半途掐断 */
function clearLimbHighlight() {
  tintFx.want = false;
}

/* 立刻还原：换关节、重置姿态这类「不该再看到上一根」的场合用 */
function restoreLimb() {
  limbMeshes.forEach((mesh) => {
    const record = mesh.userData.vcTint;
    if (!record) return;
    mesh.material = record.original;
    disposeTinted(record.original, record.tinted);
    delete mesh.userData.vcTint;
  });
  limbMeshes = [];
  limbBone = null;
  limbHint = null;
  resetGlide(tintFx.gl, 0);
  tintFx.select = 0;
  tintFx.want = false;
}

/* 副本可能是材质数组：逐项比一下，跳过没被复制的那种（面罩、指示灯） */
function disposeTinted(original, tinted) {
  if (Array.isArray(tinted)) {
    tinted.forEach((item, index) => {
      const base = Array.isArray(original) ? original[index] : original;
      if (item && item !== base) item.dispose();
    });
    return;
  }
  if (tinted && tinted !== original) tinted.dispose();
}

function showMarker(bone, active) {
  if (!marker || !bone) return;
  if (markerBone !== bone) {
    if (marker.parent) marker.parent.remove(marker);
    bone.add(marker);
    marker.position.set(0, 0, 0);
    markerBone = bone;
    /* 换关节重新涨开一次：从上一个关节滑过来时，这枚点是「重新长出来」
       的，不该带着上一个的大小直接出现在新位置 */
    resetGlide(markerFx.ap, 0);
    markerFx.select = active ? 1 : 0;
  }
  marker.material.color.copy(hintTint());
  markerFx.want = true;
  markerFx.active = !!active;
  tintFx.active = !!active;
  marker.visible = true;
}

function hideMarker() {
  if (!marker) return;
  /* 只关目标，不立刻 visible=false：等透明度退到 0 再由每帧摘掉，
     否则涨开动画白做，收的时候也会「啪」地消失 */
  markerFx.want = false;
  markerFx.active = false;
  tintFx.active = false;
}

/* 逐帧推进：标记与肢体高亮共用一份时间差。标签页挂起再回来时
   dt 会被夹到 50ms 以内，避免一帧就把整段缓动走完 */
let lastFxTime = 0;

function updateJointFx() {
  const now = performance.now();
  const dt = lastFxTime ? clamp((now - lastFxTime) / 1000, 0.001, 0.05) : 0.016;
  lastFxTime = now;
  updateMarker(dt);
  updateTint(dt);
}

function updateMarker(dt) {
  if (!marker) return;
  /* 已经收干净、也没有新目标：不必每帧再算一遍过渡 */
  if (!marker.visible && !markerFx.want) return;
  const appear = glide(markerFx.ap, markerFx.want ? 1 : 0, markerFx.want ? MARKER_IN : MARKER_OUT, dt);
  markerFx.select = approach(markerFx.select, markerFx.active ? 1 : 0, dt, MARKER_SELECT_TAU);

  /* 退场走满整段才摘掉：k 到 1 表示这一趟已经播完，不是「透明度够低了」 */
  if (!markerFx.want && markerFx.ap.k >= 1) {
    marker.visible = false;
    if (marker.parent) marker.parent.remove(marker);
    markerBone = null;
    resetGlide(markerFx.ap, 0);
    return;
  }
  if (!marker.visible || !markerBone) return;

  /* 12px 屏幕半径 → 世界半径 → 除掉骨骼世界缩放得到局部 scale。
     骨骼若被非等比缩放，取最大的那一轴做除数，宁可略小也不撑出椭圆 */
  marker.getWorldPosition(tempVec);
  const distance = Math.max(camera.position.distanceTo(tempVec), 0.01);
  /* 画布高度按绘制缓冲反算（画布 CSS 尺寸与视口一致），别读 clientHeight ——
     那是布局值，每帧问一次排版会拖慢悬浮高亮的起手 */
  const cvs = robo.renderer.domElement;
  const height = cvs.height / (robo.renderer.getPixelRatio() || 1) || 1;
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
  const worldRadius = (MARKER_RADIUS_PX * 2 * tanV * distance) / height;
  markerBone.getWorldScale(tempScale);
  const parentScale = Math.max(
    Math.abs(tempScale.x), Math.abs(tempScale.y), Math.abs(tempScale.z), 0.0001
  );
  const grow = MARKER_GROW_FROM + (1 - MARKER_GROW_FROM) * appear;
  marker.scale.setScalar((worldRadius / parentScale) * grow);

  /* 透明度两段叠加：先按出现进度从 0 起，再按选中进度在悬停档与选中档之间走 */
  const level =
    MARKER_OPACITY_IDLE + (MARKER_OPACITY_ACTIVE - MARKER_OPACITY_IDLE) * markerFx.select;
  marker.material.opacity = level * appear;
}

function updateTint(dt) {
  if (!limbMeshes.length) return;
  const level = glide(tintFx.gl, tintFx.want ? 1 : 0, tintFx.want ? TINT_IN : TINT_OUT, dt);
  tintFx.select = approach(tintFx.select, tintFx.active ? 1 : 0, dt, TINT_SELECT_TAU);

  /* 同样等这一趟走完再还原材质：k 到 1 才是终点 */
  if (!tintFx.want && tintFx.gl.k >= 1) {
    restoreLimb();
    return;
  }
  if (!limbHint) return;
  const mix = (TINT_MIX + (TINT_MIX_ACTIVE - TINT_MIX) * tintFx.select) * level;
  limbMeshes.forEach((mesh) => applyTint(mesh.material, mix, limbHint));
}

function buildPanel() {
  dock = document.querySelector('.viewdock');
  if (!dock) return;
  viewButton = dock.querySelector('.view-adjust-trigger');
  panel = dock.querySelector('.viewdock__body');
  if (!panel) return;

  /* 一排三枚圆钮：水平四向、俯仰三向、复位视角。
     没有标题行 —— 右端那枚眼睛本身就是开合入口，再点一次、点面板外或
     按 Esc 都能收起；方位不写东南西北，直接报「正 / 左 / 右 / 后」。
     复位视角放在最右、紧贴眼睛：前两枚是「往哪走」，它是「回到原点」，
     挨着入口不参与逐档切换，误触的代价也最小。
     复位姿态不属于这里 —— 它是托盘右端一枚独立的圆钮，一直显示 */
  const row = document.createElement('div');
  row.className = 'vt-row';

  azimuthButton = roundButton('cycle-azimuth', '切换水平视角');
  azimuthButton.addEventListener('click', cycleAzimuth);
  row.appendChild(azimuthButton);

  tiltButton = roundButton('cycle-tilt', '切换俯仰视角');
  tiltButton.addEventListener('click', cycleTilt);
  row.appendChild(tiltButton);

  const resetButton = roundButton('reset-view', '复位视角');
  resetButton.innerHTML = RESET_GLYPH;
  resetButton.addEventListener('click', resetView);
  row.appendChild(resetButton);

  panel.appendChild(row);
  refreshViewButtons();

  if (viewButton) {
    viewButton.setAttribute('aria-controls', panel.id);
    viewButton.setAttribute('aria-expanded', 'false');
    viewButton.addEventListener('click', togglePanel);
  }
  const poseResetButton = document.querySelector('.pose-reset-trigger');
  if (poseResetButton) poseResetButton.addEventListener('click', resetPose);

  /* 面板从按钮那块长出来，点到它自己或内部都不算「点外面」。
     监听挂在 window 的捕获阶段 —— 比 document 上任何一层都早，
     别的脚本先注册、半路停掉传播都挡不住这一手；命中判定走
     composedPath 而不是 event.target，指针被别的元素捕获、
     或者事件从 SVG 子节点起冒时也能认出「这确实在条形里面」。
     pointerdown 收鼠标与触摸，click 再兜一层键盘与合成事件，
     同一个手势只落一次（关掉后 is-open 就没了，第二次直接返回）。 */
  const outside = (event) => {
    if (!dock.classList.contains('is-open')) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    if (path ? path.includes(dock) : dock.contains(event.target)) return;
    closePanel();
  };
  window.addEventListener('pointerdown', outside, true);
  window.addEventListener('click', (event) => {
    /* 代码里自己点的（关皮肤、复位等）不算用户想关面板 */
    if (!event.isTrusted) return;
    outside(event);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dock.classList.contains('is-open')) closePanel();
  });
}

/* 两枚胶囊里不放字，放图标。
   方位那枚画成罗盘：一圈淡环代表模型的水平面，指针指到相机站的那一侧，
   四档共用这一个图形，只把指针转过 90 的倍数 ——
   正 = 朝下（相机在近端）、左 = 朝左、右 = 朝右、后 = 朝上。
   指针是实心的、环是淡的，跟俯仰那枚的细线箭头在形状上分得很开。
   俯仰那枚三档各一张：向上箭头、一条水平的双向箭头、向下箭头，
   分别对应仰视、平视、俯视。全部跟 currentColor 走，悬停反白时一起变。
   四张图都与顶栏那两枚（眼睛、复位）用同一个 0 0 24 24 的框、同一档
   1.8 描边，图形本身也铺到 3…21 的同一格：盒子放大到「顶栏字号 + 4」之后，
   五枚图标并排读起来仍是同一个视觉大小，而不是有的 15、有的 20 */

const AZIMUTH_GLYPH =
  '<circle cx="12" cy="12" r="9" stroke-opacity=".45"/>' +
  '<path d="M12 21 16.8 12 12 13.8 7.2 12Z" fill="currentColor" stroke="none"/>';
const TILT_GLYPH = {
  up:    '<path d="M12 21V3"/><path d="M4.9 10.1 12 3l7.1 7.1"/>',
  level: '<path d="M3 12h18"/><path d="M6.9 8.6 3 12l3.9 3.4"/>' +
         '<path d="M17.1 8.6 21 12l-3.9 3.4"/>',
  down:  '<path d="M12 3v18"/><path d="M4.9 13.9 12 21l7.1-7.1"/>',
};

/* 复位视角：画面四角各留一段开口的框，中心一个点 —— 取景框归中。
   刻意不用回转箭头：托盘右边那枚 .pose-reset-trigger 已经是那个图形，
   两枚并排时同形不同义最难分。框的四角与中心点铺到 3…21，和其他几枚
   同样落在 24 的格子里 */
const RESET_GLYPH =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M3 8.6V3h5.6"/><path d="M15.4 3H21v5.6"/>' +
    '<path d="M21 15.4V21h-5.6"/><path d="M8.6 21H3v-5.6"/>' +
    '<circle cx="12" cy="12" r="2.4"/>' +
  '</svg>';

function azimuthSvg(rotate) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<g transform="rotate(' + rotate + ' 12 12)">' + AZIMUTH_GLYPH + '</g>' +
    '</svg>';
}

function tiltSvg(key) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    (TILT_GLYPH[key] || TILT_GLYPH.level) + '</svg>';
}

/* 条里的圆钮：样式在 css/viewtool.css 的 .vt-round 里，底色涨开与按下压弹
   沿用顶栏胶囊那一套，由 js/press.js 接管（它按 .vt-round 这个选择器抓） */
function roundButton(action, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'vt-round';
  button.dataset.action = action;
  /* 只留 aria-label：原生 title 会在悬停时弹一个黑底小框，和这块极简的
     胶囊不搭，提示信息都交给读屏 */
  button.setAttribute('aria-label', label);
  return button;
}

/* 开合只切一个类：宽高走 CSS 的 0.3s，形变与阴影由 js/panels.js 的
   MutationObserver 接住 is-open 的变化去补间，和账号胶囊同一套 */
function openPanel() {
  if (!dock) return;
  dock.classList.add('is-open');
  if (viewButton) {
    viewButton.classList.add('is-active');
    viewButton.setAttribute('aria-pressed', 'true');
    viewButton.setAttribute('aria-expanded', 'true');
  }
}

function closePanel() {
  if (!dock) return;
  dock.classList.remove('is-open');
  if (viewButton) {
    viewButton.classList.remove('is-active');
    viewButton.setAttribute('aria-pressed', 'false');
    viewButton.setAttribute('aria-expanded', 'false');
  }
}

function togglePanel() {
  if (!dock) return;
  if (dock.classList.contains('is-open')) closePanel();
  else openPanel();
}

/* 当前落在哪一档：方位取最近的一格（拖到一半时按最近的报），
   俯仰只看正负，过半才算上 / 下 */
function nearestAzimuth(azimuth) {
  let best = VIEW_CYCLE[0];
  let bestDiff = Infinity;
  VIEW_CYCLE.forEach((entry) => {
    const diff = Math.abs(normalizeAngle(azimuth - entry.azimuth));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = entry;
    }
  });
  return best;
}

function nearestTilt(elevation) {
  if (elevation > TILT_SPLIT) return TILT_UP;
  if (elevation < -TILT_SPLIT) return TILT_DOWN;
  return TILT_LEVEL;
}

/* 两枚循环钮上的图标就是当前状态：中键拖拽、点按钮之后都要跟着换。
   只有状态真的变了才写 DOM，拖拽时每帧调用也不会反复重建 SVG */
function refreshViewButtons() {
  if (azimuthButton) {
    const horizontal = nearestAzimuth(view.azimuth);
    if (azimuthButton.dataset.state !== horizontal.key) {
      azimuthButton.dataset.state = horizontal.key;
      azimuthButton.innerHTML = azimuthSvg(horizontal.rotate);
      azimuthButton.setAttribute('aria-label', '切换水平视角，当前' + horizontal.label + '视');
    }
  }
  if (tiltButton) {
    const vertical = nearestTilt(view.elevation);
    if (tiltButton.dataset.state !== vertical.key) {
      tiltButton.dataset.state = vertical.key;
      tiltButton.innerHTML = tiltSvg(vertical.key);
      tiltButton.setAttribute('aria-label', '切换俯仰视角，当前' + vertical.label + '视');
    }
  }
}

function applyAngles(azimuth, elevation) {
  view.azimuth = normalizeAngle(azimuth);
  view.elevation = clamp(elevation, -ELEVATION_LIMIT, ELEVATION_LIMIT);
  zoomAnchorS = null;      /* 换了方位或俯仰，旧的头部锚点不再成立 */
  robo.setPointerAimPaused(true);
  step(lastCamY, lastCamD);
}

/* 水平钮按数组顺序走一格，俯仰保持不动 */
function cycleAzimuth() {
  if (!ready) return;
  const current = nearestAzimuth(view.azimuth);
  const next = VIEW_CYCLE[(VIEW_CYCLE.indexOf(current) + 1) % VIEW_CYCLE.length];
  applyAngles(next.azimuth, view.elevation);
}

/* 俯仰钮按数组顺序走一格：上 → 平 → 下 → 上 */
function cycleTilt() {
  if (!ready) return;
  const current = nearestTilt(view.elevation);
  const next = TILT_CYCLE[(TILT_CYCLE.indexOf(current) + 1) % TILT_CYCLE.length];
  applyAngles(view.azimuth, next.elevation);
}

function bindResetAndDefaultControls() {
  document.querySelectorAll('[data-view-default]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.viewDefault === 'current') {
        saveDefaultView({
          azimuth: view.azimuth,
          elevation: view.elevation,
          distance: view.distance,
          mode: 'custom',
        });
        return;
      }
      saveDefaultView({...FRONT_VIEW});
      resetView();
    });
  });
  refreshDefaultViewButtons();
  window.addEventListener('langchange', refreshDefaultViewButtons);
}

function refreshDefaultViewButtons() {
  document.querySelectorAll('[data-view-default]').forEach((button) => {
    const mode = button.dataset.viewDefault === 'current' ? 'custom' : 'front';
    const active = mode === defaultView.mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

/* 缩放基准：头骨中心的世界高度。头顶往下折 8.9% 身高就是头的中心，
   与关节命中那套用的是同一个点，模型缩放或换机型都跟着走 */
function headAnchorY() {
  if (!modelBox) return lastCamY;
  return modelBox.max.y - 0.089 * (modelBox.max.y - modelBox.min.y);
}

/* 回到默认视角：方位、俯仰、远近一起归位，缩放锚点作废。
   设置里那两项 data-view-default 决定「默认」是正前方、还是上次存下的姿态 */
function resetView() {
  if (!ready) return;
  view.azimuth = defaultView.azimuth;
  view.elevation = defaultView.elevation;
  view.distance = defaultView.distance;
  zoomAnchorS = null;
  robo.setPointerAimPaused(false);
  step(lastCamY, lastCamD);
}

/* 姿态复位与视角复位合成一次「回到原样」：心情、动作、姿势、镜头全归位。
   托盘右端那枚回转箭头（.pose-reset-trigger）走这里 */
const resetPose = resetAll;

function resetAll() {
  if (!ready || !robo.resetPose) return;
  if (robo.stopGesture) robo.stopGesture();
  if (robo.setMood) robo.setMood('calm');
  robo.resetPose();
  if (robo.playClip) robo.playClip('idle', true);
  resetView();
  hideMarker();
  clearLimbHighlight();
}

/* head 档是定点构图：镜头距离由取景按「一颗头正好占满画面」解出来，
   再乘缩放倍数那颗头就会顶出画框。这一档把缩放整个锁掉，滚轮只当没发生。
   现问 3D 模块要档位，不另存一份状态 —— 在 Settings 里切完档立刻生效 */
function zoomLocked() {
  return !!(robo && robo.framing === 'head');
}

function zoom(factor) {
  if (!ready || zoomLocked()) return;
  const before = view.distance;
  const after = clamp(before * factor, DISTANCE_MIN, DISTANCE_MAX);
  if (after === before) return;
  /* 先把「当前画面里头在哪」量下来：头部与注视点的纵向差，除以「距离 +
     这段差在视线方向上的投影」，就是它在视锥里的归一化偏移（屏幕上那个
     位置与它成正比）。缩放完按新距离反解注视点，这个偏移不变，于是头停在
     原位、身体上下张开。距离回到 1 时反解出的注视点正好是取景给的那个高度 */
  const anchor = headAnchorY();
  const x0 = anchor - lastLookY;
  const d0 = lastCamD * before;
  const den = d0 + x0 * Math.sin(THREE.MathUtils.degToRad(view.elevation));
  if (Math.abs(den) > 1e-4) zoomAnchorS = x0 / den;
  view.distance = after;
  step(lastCamY, lastCamD);
}

function setView(next, options = {}) {
  if (!ready || !next) return false;
  const azimuth = Number(next.azimuth);
  const elevation = Number(next.elevation);
  const distance = Number(next.distance);
  if (!Number.isFinite(azimuth) || !Number.isFinite(elevation) || !Number.isFinite(distance)) {
    return false;
  }
  view.azimuth = normalizeAngle(azimuth);
  view.elevation = clamp(elevation, -ELEVATION_LIMIT, ELEVATION_LIMIT);
  view.distance = clamp(distance, DISTANCE_MIN, DISTANCE_MAX);
  zoomAnchorS = null;
  if (options.pauseFollow !== false) robo.setPointerAimPaused(true);
  step(lastCamY, lastCamD);
  return true;
}

function bindInteractions() {
  wrap.addEventListener('pointerdown', onPointerDown);
  wrap.addEventListener('pointermove', onPointerMove);
  wrap.addEventListener('pointerup', onPointerUp);
  wrap.addEventListener('pointercancel', onPointerUp);
  wrap.addEventListener('pointerleave', () => {
    if (!drag) {
      hideMarker();
      clearLimbHighlight();
    }
    hoverPoint = null;
    hoverCanPose = false;
    wrap.classList.remove('vc-can-pose', 'vc-hover-joint');
  });
  wrap.addEventListener('wheel', onWheel, { passive: false });
  wrap.addEventListener('contextmenu', (event) => event.preventDefault());
  /* 中键在部分浏览器会触发「自动滚动」圆盘与 auxclick，
     mousedown 这一层先按一次，pointerdown 与 auxclick 再各兜一层 */
  wrap.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });
  wrap.addEventListener('auxclick', (event) => {
    if (event.button === 1) event.preventDefault();
  });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Alt' && !drag) queueHover(pointer.x, pointer.y, true);
  });
  window.addEventListener('keyup', (event) => {
    if (event.key === 'Alt' && !drag) queueHover(pointer.x, pointer.y, false);
  });
}

/* 点在关节上就转动那一节；点在空白处拖动才环绕视角。 */
function onPointerDown(event) {
  if (!ready) return;

  /* 只认左键：中键在部分系统上是滚动轮盘/自动滚动的起手，
     按住拖动会把页面当成可拖的画布，和环绕视角抢同一手势 */
  if (event.button !== 0) return;
  event.preventDefault();
  pointer.x = event.clientX;
  pointer.y = event.clientY;

  const joint = findJointAt(event.clientX, event.clientY);
  if (joint) {
    drag = {
      kind: 'joint-pending',
      pointerId: event.pointerId,
      bone: joint.bone,
      config: joint.config,
      hit: joint.point.clone(),
      startX: event.clientX,
      startY: event.clientY,
    };
    showMarker(joint.bone, false);
    highlightLimb(joint.bone);
    wrap.classList.add('vc-joint');
    capturePointer(event.pointerId);
    return;
  }

  drag = {
    kind: 'camera',
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
  };
  robo.setPointerAimPaused(true);
  wrap.classList.remove('vc-hover-joint', 'vc-can-pose');
  wrap.classList.add('vc-camera');
  capturePointer(event.pointerId);
}

function onPointerMove(event) {
  if (!ready) return;
  pointer.x = event.clientX;
  pointer.y = event.clientY;

  if (drag) {
    const dx = event.clientX - (drag.x ?? drag.startX ?? event.clientX);
    const dy = event.clientY - (drag.y ?? drag.startY ?? event.clientY);

    if (drag.kind === 'joint-pending') {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_START_PX) return;
      startJointDrag(event);
    }

    if (drag.kind === 'camera') {
      view.azimuth = normalizeAngle(view.azimuth - dx * ORBIT_PIXEL_TO_DEG);
      view.elevation = clamp(view.elevation - dy * TILT_PIXEL_TO_DEG, -ELEVATION_LIMIT, ELEVATION_LIMIT);
      drag.x = event.clientX;
      drag.y = event.clientY;
      step(lastCamY, lastCamD);
      return;
    }

    if (drag.kind === 'joint') {
      drag.x = event.clientX;
      drag.y = event.clientY;
      updateJoint(dx, dy);
      return;
    }
  }

  queueHover(event.clientX, event.clientY, true);
}

function startJointDrag(event) {
  if (drag.kind !== 'joint-pending') return;
  robo.freezePose();
  robo.setPointerAimPaused(true);

  const bone = drag.bone;
  const parentQuaternion = new THREE.Quaternion();
  bone.parent.getWorldQuaternion(parentQuaternion);

  bone.getWorldPosition(tempVec);
  const axisParent = cachedJointAxis(bone, drag.config.axis);
  const axisWorld = axisParent.clone().applyQuaternion(parentQuaternion).normalize();
  let screenTangent;
  if (drag.config.input === 'vertical') {
    screenTangent = {x: 0, y: drag.config.sign || -1};
  } else if (drag.config.input === 'horizontal') {
    screenTangent = {x: drag.config.sign || 1, y: 0};
  } else {
    screenTangent = screenDragDirection(axisWorld, tempVec, drag.hit);
  }

  drag = {
    kind: 'joint',
    pointerId: drag.pointerId,
    bone,
    config: drag.config,
    axisParent,
    angle: 0,
    screenTangent,
    x: event.clientX,
    y: event.clientY,
  };
  wrap.classList.remove('vc-joint');
  wrap.classList.add('vc-dragging-joint');
  showMarker(bone, true);
}

function updateJoint(dx, dy) {
  const delta = (dx * drag.screenTangent.x + dy * drag.screenTangent.y) * JOINT_PIXEL_TO_RAD;
  const next = clamp(drag.angle + delta, drag.config.range[0], drag.config.range[1]);
  const movement = next - drag.angle;
  drag.angle = next;
  const rotation = new THREE.Quaternion().setFromAxisAngle(drag.axisParent, movement);
  drag.bone.quaternion.premultiply(rotation);
}

function onPointerUp(event) {
  if (!drag) return;
  if (event && drag.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
  const wasJoint = drag.kind === 'joint' || drag.kind === 'joint-pending';
  const wasCamera = drag.kind === 'camera';

  if (wrap && drag.pointerId !== undefined && wrap.hasPointerCapture(drag.pointerId)) {
    wrap.releasePointerCapture(drag.pointerId);
  }
  drag = null;
  wrap.classList.remove('vc-camera', 'vc-dragging-joint', 'vc-joint', 'vc-can-pose');

  if (wasJoint || wasCamera) robo.setPointerAimPaused(false);
  /* 松手后重新判定一次悬浮：拖完指针可能已经离开关节，也可能还压在别的关节上。
     高亮先留着，等这次判定给出结果（命中就换成新关节，落空就清掉），
     否则松手瞬间会闪一下原色 */
  queueHover(pointer.x, pointer.y, false);
}

function onWheel(event) {
  if (!ready) return;
  event.preventDefault();
  /* 滚轮上滚（deltaY < 0）推近、下滚拉远，保持统一的 3D 视角方向：
     view.distance 是相机距离，值越小画面上的机器人越大 */
  zoom(Math.exp(event.deltaY * WHEEL_ZOOM_K));
}

function capturePointer(pointerId) {
  try {
    wrap.setPointerCapture(pointerId);
  } catch (error) {
    /* The window-level pointerup still ends the gesture if capture is unavailable. */
  }
}

function queueHover(clientX, clientY, canPose = false) {
  hoverPoint = { x: clientX, y: clientY };
  hoverCanPose = canPose;
  if (hoverTimer) return;
  hoverTimer = window.setTimeout(() => {
    hoverTimer = 0;
    if (drag || !hoverPoint) return;
    const joint = hoverCanPose ? findJointAt(hoverPoint.x, hoverPoint.y) : null;
    if (joint) {
      showMarker(joint.bone, false);
      highlightLimb(joint.bone);
      wrap.classList.add('vc-hover-joint');
      wrap.classList.add('vc-can-pose');
    } else {
      hideMarker();
      clearLimbHighlight();
      wrap.classList.remove('vc-hover-joint', 'vc-can-pose');
    }
  }, HOVER_DELAY_MS);
}

function findJointAt(clientX, clientY) {
  if (!robo.model) return null;
  const rect = wrap.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  /* 先过一道屏幕矩形：机身跟着指针在转，矩形每 100ms 重投一次就够，
     期间只多留 12px 余量，边缘不会误判成「没压上」。
     判定在射线之前，指针压在大片空白上时连求交都不用做 */
  const bounds = modelScreenRect(rect);
  if (bounds) {
    const pad = 12;
    if (clientX < bounds.left - pad || clientX > bounds.right + pad
      || clientY < bounds.top - pad || clientY > bounds.bottom + pad) {
      return null;
    }
  }
  raycaster.setFromCamera(ndcPoint.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  ), camera);
  const hits = raycaster.intersectObjects(robo.model.children, true);
  const hit = hits.find((entry) => entry.object.isMesh && !entry.object.userData.viewMarker);
  if (!hit) return null;

  const owner = findJointOwner(hit.object);
  if (!owner) return null;
  const bone = resolveJointTrigger(owner, hit.point);
  if (!bone) return null;
  let config = jointConfigForName(bone.name);
  if (!config) return null;
  if (canonicalJointName(bone.name) === 'body1') {
    const waist = bone.getWorldPosition(tempVec);
    config = hit.point.y >= waist.y ? WAIST_YAW_CONFIG : WAIST_PITCH_CONFIG;
  }
  return {bone, config, point: hit.point.clone()};
}

/* 机器人整体的屏幕外接矩形，缓存 100ms。机身随指针慢慢转，100ms 内的
   偏差不过一两像素，外面还留着 12px 余量，够用 */
function modelScreenRect(rect) {
  if (!modelBox) return null;
  const now = performance.now();
  if (screenRect && now - screenRectAt < 100) return screenRect;
  rectBox.copy(modelBox).applyMatrix4(robo.model.matrixWorld);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i += 1) {
    rectCorner.set(
      i & 1 ? rectBox.max.x : rectBox.min.x,
      i & 2 ? rectBox.max.y : rectBox.min.y,
      i & 4 ? rectBox.max.z : rectBox.min.z
    ).project(camera);
    const x = rect.left + (rectCorner.x * 0.5 + 0.5) * rect.width;
    const y = rect.top + (-rectCorner.y * 0.5 + 0.5) * rect.height;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  screenRect = {left: x0, top: y0, right: x1, bottom: y1};
  screenRectAt = now;
  return screenRect;
}

function findJointOwner(object) {
  let node = object;
  while (node && node !== robo.model) {
    if (node.isBone && jointConfigForName(node.name) && !ROOT_JOINTS.has(canonicalJointName(node.name))) {
      return node;
    }
    node = node.parent;
  }
  return null;
}

function resolveJointTrigger(bone, hitPoint) {
  const name = canonicalJointName(bone.name);
  if (name === 'body1') {
    const waist = bone.getWorldPosition(new THREE.Vector3());
    return Math.abs(hitPoint.y - waist.y) <= WAIST_TRIGGER_Y ? bone : null;
  }

  const pitchRootName = SHOULDER_PITCH_ROOTS[name];
  if (!pitchRootName) return bone;
  let root = bone;
  while (root && root !== robo.model) {
    if (root.isBone && canonicalJointName(root.name) === pitchRootName) {
      const shoulder = root.getWorldPosition(new THREE.Vector3());
      return hitPoint.distanceTo(shoulder) <= SHOULDER_PITCH_RADIUS ? root : bone;
    }
    root = root.parent;
  }
  return bone;
}

function screenDragDirection(worldAxis, pivot, hit) {
  const axisStart = projectWorld(pivot);
  const axisEnd = projectWorld(pivot.clone().addScaledVector(worldAxis, 0.08));
  const axisX = axisEnd.x - axisStart.x;
  const axisY = axisEnd.y - axisStart.y;
  const axisLength = Math.hypot(axisX, axisY);

  const tangent = new THREE.Vector3().crossVectors(worldAxis, hit.clone().sub(pivot));
  let tangentX = 0;
  let tangentY = 0;
  if (tangent.lengthSq() > 1e-10) {
    tangent.normalize();
    const tangentEnd = projectWorld(hit.clone().addScaledVector(tangent, 0.08));
    const hitScreen = projectWorld(hit);
    tangentX = tangentEnd.x - hitScreen.x;
    tangentY = tangentEnd.y - hitScreen.y;
  }

  const tangentLength = Math.hypot(tangentX, tangentY);
  if (tangentLength > 1.5) return {x: tangentX / tangentLength, y: tangentY / tangentLength};
  if (axisLength > 0.5) {
    let x = -axisY / axisLength;
    let y = axisX / axisLength;
    if (x * tangentX + y * tangentY < 0) {
      x = -x;
      y = -y;
    }
    return {x, y};
  }
  return {x: 1, y: 0};
}

function projectWorld(point) {
  const projected = point.clone().project(camera);
  const rect = wrap.getBoundingClientRect();
  return {
    x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
    y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
  };
}

window.viewControl = {
  get view() {
    return {azimuth: view.azimuth, elevation: view.elevation, distance: view.distance};
  },
  get defaultView() { return {...defaultView}; },
  get azimuth() { return nearestAzimuth(view.azimuth).key; },
  get tilt() { return nearestTilt(view.elevation).key; },
  get dragging() { return drag ? drag.kind : null; },
  registerViewAdapter,
  setView,
  openPanel,
  closePanel,
  resetView,
  resetAll,
  resetPose,
  saveDefaultView,
  cycleAzimuth,
  cycleTilt,
};

if (robo && robo.ready) boot();
else window.addEventListener('robot-ready', boot, { once: true });
