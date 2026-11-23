/* 主页皮肤。
   「原模型」是 q1_ff.glb，自己播片段。
   导入的 Mixamo / glTF 跟右侧 Motions（含街舞）的同一套关节角走。
   导入的文件存在这台浏览器的 IndexedDB 里，刷新后还在列表中。 */
import * as THREE from 'three';
import { buildClockwork } from './clockwork.js?v=2';
import { buildPixelBuddy } from './pixel_buddy.js?v=2';
import {idleState} from './idle_motion.js?v=3';
import { HOME_MOTIONS, Q1_MOTIONS, Q1_REST_POSE } from './q1_motion_data.js?v=3';
import { STREET_DANCE, STREET_DANCE_REST_POSE } from './street_dance_data.js?v=3';
import { BELLY_LAUGH, BELLY_LAUGH_REST_POSE } from './belly_laugh_data.js?v=3';
import { MECHANICAL_DANCE, MECHANICAL_DANCE_REST_POSE } from './mechanical_dance_data.js?v=3';
import { DISCO_DANCE, DISCO_DANCE_REST_POSE } from './disco_dance_data.js?v=3';
import { bindRetarget, loadCharacter, mountImported } from './skinpose.js?v=6';

import {COMPANION_MOTIONS, COMPANION_REST} from './companion_motion_data.js?v=2';

const TIMELINE_MOTIONS = new Map([
  ...COMPANION_MOTIONS.map(motion => [motion.id, motion]),
  [STREET_DANCE.id, STREET_DANCE],
  [BELLY_LAUGH.id, BELLY_LAUGH],
  [MECHANICAL_DANCE.id, MECHANICAL_DANCE],
  [DISCO_DANCE.id, DISCO_DANCE],
]);
const TIMELINE_REST_POSES = new Map([
  ...COMPANION_MOTIONS.map(motion => [motion.id, COMPANION_REST]),
  [STREET_DANCE.id, STREET_DANCE_REST_POSE],
  [BELLY_LAUGH.id, BELLY_LAUGH_REST_POSE],
  [MECHANICAL_DANCE.id, MECHANICAL_DANCE_REST_POSE],
  [DISCO_DANCE.id, DISCO_DANCE_REST_POSE],
]);

const skinStyle = document.createElement('style');
/* 换皮与导入那块（外观卡 + 导入卡 + 删除）挂在 Preference 弹窗里，
   样式跟着落到 css/modal.css 的 .pref 一组里；
   这里只剩导入模型的画布叠层，它挂在主页机器人上，与弹窗无关 */
skinStyle.textContent = [
  '.robofx.is-skinned{visibility:hidden}',
  '.skinfx{position:absolute;inset:0;z-index:2;pointer-events:none}',
  '.skinfx:not([hidden]) canvas{display:block;width:100%;height:100%;pointer-events:auto;touch-action:none;cursor:grab}',
  '.skinfx.is-joint canvas{cursor:crosshair}',
  '.skinfx.is-cam canvas,.skinfx.is-drag canvas{cursor:grabbing}',
].join('');
document.head.appendChild(skinStyle);

const SKIN_KEY = 'primebotx.skin';
const HIP_Z = 0.50;
const Q1_BODY_TARGET_Z = 0.70;
const TPOSE = {
  left_shoulder_roll_joint: 1.45,
  right_shoulder_roll_joint: -1.45,
};

const HINGES = [
  ['left_hip_pitch_joint', 'lHipPitch', 'y'],
  ['left_hip_roll_joint', 'lHipRoll', 'x'],
  ['left_hip_yaw_joint', 'lHipYaw', 'z'],
  ['left_knee_joint', 'lKnee', 'y'],
  ['left_ankle_pitch_joint', 'lAnklePitch', 'y'],
  ['left_ankle_roll_joint', 'lAnkleRoll', 'x'],
  ['right_hip_pitch_joint', 'rHipPitch', 'y'],
  ['right_hip_roll_joint', 'rHipRoll', 'x'],
  ['right_hip_yaw_joint', 'rHipYaw', 'z'],
  ['right_knee_joint', 'rKnee', 'y'],
  ['right_ankle_pitch_joint', 'rAnklePitch', 'y'],
  ['right_ankle_roll_joint', 'rAnkleRoll', 'x'],
  ['waist_pitch_joint', 'waistPitch', 'y'],
  ['waist_roll_joint', 'waistRoll', 'x'],
  ['waist_yaw_joint', 'waistYaw', 'z'],
  ['left_shoulder_pitch_joint', 'lShPitch', 'y'],
  ['left_shoulder_roll_joint', 'lShRoll', 'x'],
  ['left_shoulder_yaw_joint', 'lShYaw', 'z'],
  ['left_elbow_joint', 'lElbow', 'y'],
  ['right_shoulder_pitch_joint', 'rShPitch', 'y'],
  ['right_shoulder_roll_joint', 'rShRoll', 'x'],
  ['right_shoulder_yaw_joint', 'rShYaw', 'z'],
  ['right_elbow_joint', 'rElbow', 'y'],
];

const stage = document.querySelector('.stage');
if (stage) init();

function init() {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const wrap = document.createElement('div');
  wrap.className = 'skinfx';
  wrap.hidden = true;
  wrap.appendChild(renderer.domElement);
  stage.appendChild(wrap);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const key = new THREE.DirectionalLight(0xffffff, 1.25);
  key.position.set(1.6, -2.2, 2.6);
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.35);
  fill.position.set(-2, 1.2, 1.4);
  scene.add(key, fill);

  const camera = new THREE.PerspectiveCamera(24, 1, 0.05, 40);
  camera.up.set(0, 0, 1);

  const mats = {
    skin: new THREE.MeshLambertMaterial({ color: 0xe4b08e }),
    shirt: new THREE.MeshLambertMaterial({ color: 0x3d6f8c }),
    pants: new THREE.MeshLambertMaterial({ color: 0x2c3344 }),
    sole: new THREE.MeshLambertMaterial({ color: 0x2a211c }),
    hair: new THREE.MeshLambertMaterial({ color: 0x2a2420 }),
  };
  const { root, bones } = buildFigure(mats);
  const motion = new THREE.Group();
  scene.add(motion);
  motion.add(root);
  const proc = captureReference(root, bones);
  const pixelBuddy = buildPixelBuddy(root, bones);
  const clockwork = buildClockwork(root, bones);

  /* 脚底原来有一块半径 0.22 的深色圆盘当接触阴影。它的尺寸和落点是按 Q1 的脚距
     量死的，而这套舞台画的是 xbot / clockwork / pixel 与用户导入的模型，
     它们各有自己的体量与站位 —— 固定半径、固定在原点的圆盘压下去落不到脚下，
     只会变成脚底一块黑斑，透视一拉开还会浮在空中。阴影已整体去掉，不再绘制 */

  const panel = document.querySelector('[data-skin-panel]');
  if (!panel) return;
  const pick = panel.querySelector('[data-skin-pick]');
  const note = panel.querySelector('[data-skin-note]');
  const removeBtn = panel.querySelector('[data-skin-delete]');
  /* 导入卡排在模型网格最后。文件输入和入口按整页取；取不到就整段跳过，
     换版式时不会连带 Q1 一起挂掉 */
  const fileInput = document.querySelector('[data-skin-file]');
  const importCard = document.querySelector('[data-skin-import]');
  const loaded = new Map();
  let current = 'builtin:q1';
  let shown = false;
  let active = null;
  let themeWanted = null;
  let waitingForOriginal = false;
  const originalMaterialColors = new Map();

  /* 原模型换色。身体、腹部、胸甲、关节、脚底、面罩各一块，胸灯单独发光。 */
  const BODY_MATERIALS = ['head', 'upperarm', 'lowerarm', 'upperleg', 'lowerleg', 'hip', 'white.001'];
  const JOINT_MATERIALS = ['white', 'black', 'black.001'];
  function palette(body, fabric, chest, joint, rubber, face, faceGlow, led) {
    const map = new Map();
    BODY_MATERIALS.forEach((name) => map.set(name, body));
    map.set('fabric', fabric);
    map.set('chest', chest);
    JOINT_MATERIALS.forEach((name) => map.set(name, joint));
    map.set('rubber', rubber);
    map.set('face', face);
    return { map, faceGlow, led };
  }
  const MATERIAL_THEMES = {
    'builtin:naiwa': palette(0xf5b400, 0xffd66b, 0xf8e8c8, 0x5b3a20, 0x76502d, 0x1d1711, 0xb8ff8f, 0x78dc5a),
    'builtin:glacier': palette(0x7ec8e3, 0xd7f3ff, 0xf4fbff, 0x1e3a4c, 0x3d6278, 0x0e1a22, 0x9ad7ff, 0x7ee0ff),
    'builtin:dusk': palette(0x7a5cff, 0xcbb6ff, 0xf3eefe, 0x2a2144, 0x4a3d6b, 0x161226, 0xe2b6ff, 0xc084fc),
    'builtin:coral': palette(0xff7a6e, 0xffd0c8, 0xfff1ec, 0x5c2e2a, 0x8a534c, 0x2a1412, 0xffc1a8, 0xff8a5b),
    'builtin:ink': palette(0x1f8a78, 0x8fd9c8, 0xe7f6f2, 0x14332e, 0x2f5e54, 0x0d1c19, 0x9dffd8, 0x3ddc97),
  };

  const LIVERIES = {
    'builtin:livery': {
      color: 'model/livery_orange.png',
      glow: null,
      led: 0xff7a1a,
      metal: 0.04,
      rough: 0.58,
      glowStrength: 0,
    },
    'builtin:ion': {
      color: 'model/livery_ion.png',
      glow: 'model/livery_ion_glow.png',
      led: 0x5ef6ff,
      metal: 0.62,
      rough: 0.28,
      glowStrength: 2.4,
    },
    'builtin:medal': {
      color: 'model/livery_medal.png?v=3',
      glow: null,
      led: 0xe8b040,
      metal: 0.22,
      rough: 0.46,
      glowStrength: 0,
    },
  };
  const liveryTextures = new Map();
  function loadMap(url) {
    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false;
        tex.anisotropy = 8;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        resolve(tex);
      }, undefined, reject);
    });
  }
  function ensureLivery(id) {
    if (liveryTextures.has(id)) return Promise.resolve(liveryTextures.get(id));
    const spec = LIVERIES[id];
    const pending = Promise.all([
      loadMap(spec.color),
      spec.glow ? loadMap(spec.glow) : Promise.resolve(null),
    ]).then(([color, glow]) => {
      const pack = { ...spec, colorMap: color, glowMap: glow };
      liveryTextures.set(id, pack);
      return pack;
    });
    liveryTextures.set(id, pending);
    return pending;
  }
  function applyLiveryMaterial(material, pack) {
    const name = material.name || '';
    /* face 是表情屏：emissiveMap 上挂着 faces.js 的画布，贴图不能盖住它。 */
    if (name === 'face') return;
    if (name === 'emissive') {
      if (material.color) material.color.setHex(0xffffff);
      material.map = null;
      material.emissiveMap = null;
      if (material.emissive) material.emissive.setHex(pack.led);
      material.emissiveIntensity = 1.4;
    } else {
      if (material.color) material.color.setHex(0xffffff);
      material.map = pack.colorMap;
      material.emissiveMap = pack.glowMap;
      if (material.emissive) material.emissive.setHex(pack.glowMap ? 0xffffff : 0x000000);
      material.emissiveIntensity = pack.glowStrength;
      if (Number.isFinite(material.metalness)) material.metalness = pack.metal;
      if (Number.isFinite(material.roughness)) material.roughness = pack.rough;
      if (pack.glowMap && Number.isFinite(material.aoMapIntensity)) material.aoMapIntensity = 1;
    }
    material.needsUpdate = true;
  }

  function setOriginalMaterialTheme(themeId) {
    themeWanted = themeId || null;
    const robot = window.robot3d;
    const model = robot && robot.model;
    if (!robot || !robot.ready || !model) {
      if (themeWanted && !waitingForOriginal) {
        waitingForOriginal = true;
        window.addEventListener('robot-ready', () => {
          waitingForOriginal = false;
          setOriginalMaterialTheme(themeWanted);
        }, { once: true });
      }
      return;
    }

    if (!themeWanted) {
      originalMaterialColors.forEach((state, material) => {
        if (state.color && material.color) material.color.copy(state.color);
        if (state.emissive && material.emissive) material.emissive.copy(state.emissive);
        if (Number.isFinite(state.emissiveIntensity)) {
          material.emissiveIntensity = state.emissiveIntensity;
        }
        if ('map' in state) material.map = state.map;
        if ('emissiveMap' in state) material.emissiveMap = state.emissiveMap;
        if (Number.isFinite(state.metalness)) material.metalness = state.metalness;
        if (Number.isFinite(state.roughness)) material.roughness = state.roughness;
        if (Number.isFinite(state.aoMapIntensity)) material.aoMapIntensity = state.aoMapIntensity;
        material.needsUpdate = true;
      });
      originalMaterialColors.clear();
      return;
    }

    const liveryId = LIVERIES[themeWanted] ? themeWanted : null;
    const liveryPack = liveryId ? liveryTextures.get(liveryId) : null;
    if (liveryId && (!liveryPack || typeof liveryPack.then === 'function')) {
      ensureLivery(liveryId).then(() => {
        if (themeWanted === liveryId) setOriginalMaterialTheme(liveryId);
      });
      return;
    }

    const theme = MATERIAL_THEMES[themeWanted];
    if (!theme && !liveryPack) return;
    const seen = new Set();
    model.traverse((node) => {
      if (!node.isMesh) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material) => {
        if (!material || seen.has(material.uuid)) return;
        seen.add(material.uuid);
        if (!originalMaterialColors.has(material)) {
          originalMaterialColors.set(material, {
            color: material.color ? material.color.clone() : null,
            emissive: material.emissive ? material.emissive.clone() : null,
            emissiveIntensity: material.emissiveIntensity,
            map: material.map || null,
            emissiveMap: material.emissiveMap || null,
            metalness: material.metalness,
            roughness: material.roughness,
            aoMapIntensity: material.aoMapIntensity,
          });
        }
        if (liveryPack) {
          applyLiveryMaterial(material, liveryPack);
          return;
        }
        const saved = originalMaterialColors.get(material);
        if (saved && material.map !== saved.map) material.map = saved.map;
        if (saved && material.emissiveMap !== saved.emissiveMap) material.emissiveMap = saved.emissiveMap;
        if (saved && Number.isFinite(saved.metalness)) material.metalness = saved.metalness;
        if (saved && Number.isFinite(saved.roughness)) material.roughness = saved.roughness;
        if (saved && Number.isFinite(saved.aoMapIntensity)) material.aoMapIntensity = saved.aoMapIntensity;
        const color = theme.map.get(material.name);
        if (color !== undefined && material.color) material.color.setHex(color);
        if (material.name === 'face' && material.emissive) {
          material.emissive.setHex(theme.faceGlow);
          material.emissiveIntensity = 1.05;
        } else if (material.name === 'emissive' && material.emissive) {
          material.emissive.setHex(theme.led);
        }
        material.needsUpdate = true;
      });
    });
  }

  function setNote(text) {
    if (!note) return;
    note.hidden = !text;
    note.textContent = text || '';
  }

  /* 与 homepage_motions.js 里的 samplePose 同一套计算，关节角来自动作库，这里不再改扭转。 */
  function sampleHomePose(id, progress) {
    const motion = Q1_MOTIONS[id];
    if (!motion) return Q1_REST_POSE;
    const time = progress * motion.duration;
    const blendIn = Math.min(progress / 0.16, 1);
    const blendOut = Math.min((1 - progress) / 0.18, 1);
    const sIn = blendIn * blendIn * (3 - 2 * blendIn);
    const sOut = blendOut * blendOut * (3 - 2 * blendOut);
    const blend = Math.min(sIn, sOut);
    const pose = {};
    Object.entries(Q1_REST_POSE).forEach(([joint, rest]) => {
      let target = motion.pose[joint] ?? rest;
      const [amplitude = 0, omega = 0, phase = 0] = motion.oscillation?.[joint] ?? [];
      target += amplitude * Math.sin(omega * time + phase);
      pose[joint] = rest + (target - rest) * blend;
    });
    return pose;
  }

  function sampleTrack(points, beat, easing = 'smooth') {
    if (!points || !points.length) return 0;
    if (beat <= points[0][0]) return points[0][1];
    const last = points[points.length - 1];
    if (beat >= last[0]) return last[1];
    for (let index = 1; index < points.length; index += 1) {
      const [endBeat, endValue] = points[index];
      if (beat > endBeat) continue;
      const [startBeat, startValue] = points[index - 1];
      const t = (beat - startBeat) / (endBeat - startBeat || 1);
      const shaped = easing === 'snap' ? Math.min(1, t / 0.18) : t;
      const s = shaped * shaped * (3 - 2 * shaped);
      return startValue + (endValue - startValue) * s;
    }
    return last[1];
  }

  function sampleTimelinePose(time, motion) {
    const beat = time * motion.bpm / 60;
    const pose = { ...TIMELINE_REST_POSES.get(motion.id) };
    Object.entries(motion.tracks).forEach(([joint, points]) => {
      pose[joint] = sampleTrack(points, beat, motion.easing);
    });
    const rootEasing = (motion.root && motion.root.easing) || motion.easing || 'smooth';
    danceRoot = motion.root ? {
      side: sampleTrack(motion.root.side, beat, rootEasing),
      yaw: sampleTrack(motion.root.yaw, beat, rootEasing),
    } : null;
    return pose;
  }

  function poseNow() {
    const gesture = window.__homeGesture;
    danceRoot = null;
    if (!gesture || !gesture.id) return Q1_REST_POSE;
    const progress = (performance.now() - gesture.startedAt) / (gesture.duration * 1000);
    if (progress >= 1) return Q1_REST_POSE;
    const timeline = TIMELINE_MOTIONS.get(gesture.id);
    if (timeline) return sampleTimelinePose(progress * timeline.duration, timeline);
    return sampleHomePose(gesture.id, progress);
  }

  function watchMotions() {
    const grid = document.querySelector('[data-rail-grid="gestures"]');
    if (!grid) {
      requestAnimationFrame(watchMotions);
      return;
    }
    const actionGroup = document.querySelector('.sc-group--action');
    const sync = () => {
      const card = grid.querySelector('.is-on[data-motion]') ||
        (actionGroup && actionGroup.querySelector('.is-on[data-action-motion]'));
      const id = card && (card.dataset.motion || card.dataset.actionMotion);
      if (!id) {
        window.__homeGesture = null;
        return;
      }
      if (window.__homeGesture && window.__homeGesture.id === id) return;
      poseHold = null;
      const timeline = TIMELINE_MOTIONS.get(id);
      if (timeline) {
        window.__homeGesture = { id, startedAt: performance.now(), duration: timeline.duration };
        return;
      }
      const motion = HOME_MOTIONS.find((item) => item.id === id);
      window.__homeGesture = motion
        ? { id, startedAt: performance.now(), duration: motion.duration }
        : null;
    };
    new MutationObserver(sync).observe(grid, { attributes: true, subtree: true, attributeFilter: ['class'] });
    if (actionGroup) {
      new MutationObserver(sync).observe(actionGroup, {
        attributes: true,
        subtree: true,
        attributeFilter: ['class'],
      });
    }
    sync();
  }
  watchMotions();

  /* 和原模型同一套取景，再叠上同一套环绕、缩放。正面朝 +X。 */
  const view = { azimuth: 0, elevation: 0, distance: 1 };
  let baseDist = 2.4;
  let baseEye = 0.5;
  let poseHold = null;
  let danceRoot = null;
  let footRestZ = null;
  let pointerDrag = null;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _hit = new THREE.Vector3();
  const _axis = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({
      color: 0x91d2c3, transparent: true, opacity: 0.78, depthTest: false, depthWrite: false,
    })
  );
  marker.visible = false;
  marker.renderOrder = 999;
  scene.add(marker);

  function resize() {
    const host = document.querySelector('.robofx') || stage;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const style = getComputedStyle(host);
    const topInset = parseFloat(style.getPropertyValue('--robofx-top')) || 88;
    const bottomInset = parseFloat(style.getPropertyValue('--robofx-bottom')) || 208;
    const avail = Math.max(240, h - topInset - bottomInset);
    const tanV = Math.tan((camera.fov * Math.PI) / 180 / 2);
    const distV = h / (avail * 2 * tanV);
    const distH = 0.5 / (2 * tanV * camera.aspect);
    baseDist = Math.max(distV, distH) / 0.9;
    const contentCenter = (topInset + h - bottomInset) / 2;
    /* q1 的 body 取景会额外把注视点抬高 0.2；导入皮肤沿用同一个落点，
       否则模型会整体悬在原模型上方。 */
    baseEye = Q1_BODY_TARGET_Z
      + (contentCenter - h / 2) * (2 * baseDist * tanV) / h;
    applyView();
  }

  function applyView() {
    const azimuth = view.azimuth * Math.PI / 180;
    const elevation = view.elevation * Math.PI / 180;
    const dist = baseDist * view.distance;
    const horizontal = Math.cos(elevation) * dist;
    camera.position.set(
      Math.cos(azimuth) * horizontal,
      Math.sin(azimuth) * horizontal,
      baseEye + Math.sin(elevation) * dist
    );
    if (view.elevation >= 89.99) camera.up.set(-Math.cos(azimuth), -Math.sin(azimuth), 0);
    else if (view.elevation <= -89.99) camera.up.set(Math.cos(azimuth), Math.sin(azimuth), 0);
    else camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, baseEye);
  }

  function applyViewState(next) {
    if (!next) return false;
    const azimuth = Number(next.azimuth);
    const elevation = Number(next.elevation);
    const distance = Number(next.distance);
    if (!Number.isFinite(azimuth) || !Number.isFinite(elevation) || !Number.isFinite(distance)) {
      return false;
    }
    view.azimuth = ((azimuth + 180) % 360 + 360) % 360 - 180;
    view.elevation = Math.min(89, Math.max(-89, elevation));
    view.distance = Math.min(3.2, Math.max(0.5, distance));
    applyView();
    return true;
  }

  function syncViewFromController() {
    const controller = window.viewControl;
    return !!(controller && controller.view && applyViewState(controller.view));
  }

  function publishView() {
    const controller = window.viewControl;
    if (!controller || typeof controller.setView !== 'function'
        || !controller.setView({...view}, {source: 'q1skin', pauseFollow: false})) {
      applyView();
    }
  }

  resize();
  window.addEventListener('resize', resize);

  if (window.viewControl && typeof window.viewControl.registerViewAdapter === 'function') {
    window.viewControl.registerViewAdapter({
      isActive: () => shown,
      setView(next) {
        if (shown) applyViewState(next);
      },
    });
  }

  function originalNode() {
    return document.querySelector('.robofx');
  }

  function setFigureVisible(on) {
    pixelBuddy.setVisible(current === 'builtin:pixel');
    clockwork.setVisible(current === 'builtin:clockwork');
    root.traverse((node) => {
      if (node.isMesh && !node.userData.pixelBuddy && !node.userData.clockwork) node.visible = on;
    });
  }

  function showStage(on) {
    shown = on;
    wrap.hidden = !on;
    const rob = originalNode();
    if (rob) rob.classList.toggle('is-skinned', on);
    if (on) {
      resize();
      syncViewFromController();
      applyPose(poseNow());
      renderer.setAnimationLoop(draw);
    } else {
      renderer.setAnimationLoop(null);
    }
  }

  function footLevel() {
    const nodes = [];
    if (active && active.object.visible && active.bones) {
      if (active.bones.leftFoot) nodes.push(active.bones.leftFoot);
      if (active.bones.rightFoot) nodes.push(active.bones.rightFoot);
    } else {
      nodes.push(bones.lToe, bones.rToe);
    }
    let lowest = Infinity;
    nodes.forEach((node) => {
      node.getWorldPosition(_a);
      if (_a.z < lowest) lowest = _a.z;
    });
    return lowest;
  }

  /* 街舞的 side 是角色左侧位移，yaw 是转身。脚保持在起舞前的高度。 */
  function applyDanceRoot() {
    const side = danceRoot ? danceRoot.side : 0;
    const yaw = danceRoot ? danceRoot.yaw * Math.PI / 180 : 0;
    motion.rotation.z = yaw;
    motion.position.set(0, side, 0);
    motion.updateMatrixWorld(true);
    const level = footLevel();
    if (!danceRoot && Number.isFinite(level)) footRestZ = level;
    if (danceRoot && Number.isFinite(level) && footRestZ !== null) {
      motion.position.z = footRestZ - level;
    }
  }

  function draw() {
    const live = poseNow();
    const idle = idleState();
    let displayed = poseHold || live;
    if (!poseHold && !pointerDrag && !window.__homeGesture && idle.active) {
      displayed = {...live};
      for (const [joint, offset] of Object.entries(idle.offsets)) {
        displayed[joint] = (displayed[joint] || 0) + offset;
      }
    }
    applyPose(displayed);
    if (current === 'builtin:pixel') pixelBuddy.update();
    if (current === 'builtin:clockwork') clockwork.update();
    applyDanceRoot();
    if (marker.visible && marker.userData.anchor) {
      marker.userData.anchor.getWorldPosition(marker.position);
      marker.scale.setScalar(0.024);
    }
    renderer.render(scene, camera);
  }

  function shownRoot() {
    return active && active.object.visible ? active.object : root;
  }

  function anchorOf(id, role) {
    if (active && active.object.visible && role) {
      const link = active.links.find((item) => item.role === role);
      if (link) return link.bone;
    }
    return bones[id];
  }

  function segmentDistance(point, start, end) {
    _hit.subVectors(end, start);
    const len2 = _hit.lengthSq();
    if (len2 < 1e-8) return point.distanceTo(start);
    const t = Math.min(1, Math.max(0, point.clone().sub(start).dot(_hit) / len2));
    return point.distanceTo(_a.copy(start).addScaledVector(_hit, t));
  }

  function consider(best, dist, limit, spec, bone) {
    if (!bone || dist > limit) return best;
    if (!best || dist < best.dist) return { dist, spec, bone };
    return best;
  }

  function pickJoint(point) {
    let best = null;
    const arms = [
      ['lShPitch', 'leftArm', 'lElbow', 'leftForeArm',
        ['left_shoulder_pitch_joint', -3.142, 1.571],
        ['left_shoulder_roll_joint', -0.087, 2.792, 'vertical', -1],
        ['left_shoulder_yaw_joint', -1.571, 1.571, 'horizontal', 1],
        ['left_elbow_joint', -0.873, 1.658]],
      ['rShPitch', 'rightArm', 'rElbow', 'rightForeArm',
        ['right_shoulder_pitch_joint', -3.142, 1.571],
        ['right_shoulder_roll_joint', -2.792, 0.087, 'vertical', 1],
        ['right_shoulder_yaw_joint', -1.571, 1.571, 'horizontal', -1],
        ['right_elbow_joint', -0.873, 1.658]],
    ];
    for (const [shId, shRole, elId, elRole, pitch, roll, yaw, elbow] of arms) {
      const shoulder = anchorOf(shId, shRole);
      const elbowBone = anchorOf(elId, elRole);
      if (!shoulder || !elbowBone) continue;
      shoulder.getWorldPosition(_a);
      elbowBone.getWorldPosition(_b);
      const nearShoulder = point.distanceTo(_a);
      const nearElbow = point.distanceTo(_b);
      const along = segmentDistance(point, _a.clone(), _b.clone());
      best = consider(best, nearShoulder, 0.06, pitch, shoulder);
      best = consider(best, nearElbow, 0.06, elbow, elbowBone);
      if (along <= 0.09 && nearShoulder > 0.06 && nearElbow > 0.06) {
        best = consider(best, along, 0.09, nearShoulder < nearElbow ? roll : yaw, nearShoulder < nearElbow ? shoulder : elbowBone);
      }
    }
    const legs = [
      ['lHipPitch', 'leftUpLeg', 'lKnee', 'leftLeg', 'lAnkleRoll', 'leftFoot',
        ['left_hip_pitch_joint', -3.054, 1.571],
        ['left_hip_roll_joint', -0.698, 1.571],
        ['left_hip_yaw_joint', -1.571, 1.571],
        ['left_knee_joint', 0, 2.443],
        ['left_ankle_pitch_joint', -0.785, 0.436],
        ['left_ankle_roll_joint', -0.349, 0.349]],
      ['rHipPitch', 'rightUpLeg', 'rKnee', 'rightLeg', 'rAnkleRoll', 'rightFoot',
        ['right_hip_pitch_joint', -3.054, 1.571],
        ['right_hip_roll_joint', -1.571, 0.698],
        ['right_hip_yaw_joint', -1.571, 1.571],
        ['right_knee_joint', 0, 2.443],
        ['right_ankle_pitch_joint', -0.785, 0.436],
        ['right_ankle_roll_joint', -0.349, 0.349]],
    ];
    for (const [hipId, hipRole, kneeId, shinRole, ankleId, footRole, pitch, roll, yaw, knee, anklePitch, ankleRoll] of legs) {
      const hip = anchorOf(hipId, hipRole);
      const kneeBone = anchorOf(kneeId, shinRole);
      const ankle = anchorOf(ankleId, footRole);
      if (!hip || !kneeBone || !ankle) continue;
      hip.getWorldPosition(_a);
      kneeBone.getWorldPosition(_b);
      const hipP = _a.clone();
      const kneeP = _b.clone();
      ankle.getWorldPosition(_a);
      const ankleP = _a.clone();
      const nearHip = point.distanceTo(hipP);
      const nearKnee = point.distanceTo(kneeP);
      const nearAnkle = point.distanceTo(ankleP);
      const thigh = segmentDistance(point, hipP, kneeP);
      const shin = segmentDistance(point, kneeP, ankleP);
      best = consider(best, nearHip, 0.06, pitch, hip);
      best = consider(best, nearKnee, 0.06, knee, kneeBone);
      best = consider(best, nearAnkle, 0.05, anklePitch, ankle);
      if (thigh <= 0.09 && nearHip > 0.06 && nearKnee > 0.06) best = consider(best, thigh, 0.09, roll, hip);
      if (shin <= 0.09 && nearKnee > 0.06 && nearAnkle > 0.05) best = consider(best, shin, 0.09, yaw, kneeBone);
      if (nearAnkle > 0.05 && nearAnkle < 0.16 && shin > nearAnkle) best = consider(best, nearAnkle, 0.16, ankleRoll, ankle);
    }
    const waist = anchorOf('waistYaw', 'chest') || anchorOf('waistRoll', 'hips');
    if (waist) {
      waist.getWorldPosition(_a);
      const dist = point.distanceTo(_a);
      const above = point.z >= _a.z;
      best = consider(best, dist, 0.12, above
        ? ['waist_yaw_joint', -1.571, 1.571, 'horizontal', 1]
        : ['waist_roll_joint', -0.35, 0.35, 'vertical', -1], waist);
    }
    if (!best) return null;
    const [name, min, max, input, sign] = best.spec;
    return { name, min, max, input, sign: sign || 1, bone: best.bone };
  }

  function jointAt(clientX, clientY) {
    const rect = wrap.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(shownRoot(), true);
    const hit = hits.find((entry) => entry.object.isMesh && entry.object !== marker);
    if (!hit) return null;
    const joint = pickJoint(hit.point);
    if (!joint) return null;
    joint.point = hit.point.clone();
    return joint;
  }

  function showMarker(bone) {
    if (!bone) {
      marker.visible = false;
      marker.userData.anchor = null;
      wrap.classList.remove('is-joint');
      return;
    }
    marker.userData.anchor = bone;
    marker.visible = true;
    wrap.classList.add('is-joint');
  }

  function project(point) {
    const projected = point.clone().project(camera);
    const rect = wrap.getBoundingClientRect();
    return {
      x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
    };
  }

  function dragTangent(joint) {
    if (joint.input === 'vertical') return { x: 0, y: joint.sign };
    if (joint.input === 'horizontal') return { x: joint.sign, y: 0 };
    const hinge = HINGES.find((item) => item[0] === joint.name);
    const node = hinge ? bones[hinge[1]] : null;
    const axisName = hinge ? hinge[2] : 'y';
    _axis.set(axisName === 'x' ? 1 : 0, axisName === 'y' ? 1 : 0, axisName === 'z' ? 1 : 0);
    if (node && node.parent) {
      node.parent.updateWorldMatrix(true, false);
      node.parent.getWorldQuaternion(_q);
      _axis.applyQuaternion(_q).normalize();
      node.getWorldPosition(_a);
    }
    const pivot = _a.clone();
    const hit = joint.point || pivot;
    const start = project(pivot);
    const end = project(pivot.clone().addScaledVector(_axis, 0.08));
    const axisX = end.x - start.x;
    const axisY = end.y - start.y;
    const axisLength = Math.hypot(axisX, axisY);
    const tangent = new THREE.Vector3().crossVectors(_axis, hit.clone().sub(pivot));
    let tx = 0;
    let ty = 0;
    if (tangent.lengthSq() > 1e-10) {
      tangent.normalize();
      const tangentEnd = project(hit.clone().addScaledVector(tangent, 0.08));
      const hitScreen = project(hit);
      tx = tangentEnd.x - hitScreen.x;
      ty = tangentEnd.y - hitScreen.y;
    }
    const tangentLength = Math.hypot(tx, ty);
    if (tangentLength > 1.5) return { x: tx / tangentLength, y: ty / tangentLength };
    if (axisLength > 0.5) {
      let x = -axisY / axisLength;
      let y = axisX / axisLength;
      if (x * tx + y * ty < 0) { x = -x; y = -y; }
      return { x, y };
    }
    return { x: 1, y: 0 };
  }

  function holdPose() {
    if (poseHold) return;
    const src = poseNow();
    poseHold = {};
    for (const [name] of HINGES) poseHold[name] = typeof src[name] === 'number' ? src[name] : 0;
  }

  function onPointerDown(event) {
    /* 左键才拖：中键留给浏览器的滚动轮盘，不参与环绕角度 */
    if (!shown || event.button !== 0) return;
    const joint = jointAt(event.clientX, event.clientY);
    if (joint) {
      pointerDrag = {
        kind: 'joint-pending',
        pointerId: event.pointerId,
        joint,
        hit: null,
        startX: event.clientX,
        startY: event.clientY,
      };
      showMarker(joint.bone);
      wrap.setPointerCapture(event.pointerId);
      return;
    }
    pointerDrag = { kind: 'camera', pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    showMarker(null);
    wrap.classList.add('is-cam');
    wrap.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (!shown) return;
    if (!pointerDrag) {
      const joint = jointAt(event.clientX, event.clientY);
      showMarker(joint && joint.bone);
      return;
    }
    if (pointerDrag.pointerId !== event.pointerId) return;
    if (pointerDrag.kind === 'joint-pending') {
      if (Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY) < 3) return;
      holdPose();
      const joint = pointerDrag.joint;
      pointerDrag = {
        kind: 'joint',
        pointerId: event.pointerId,
        joint,
        angle: poseHold[joint.name] || 0,
        tangent: dragTangent(joint),
        x: event.clientX,
        y: event.clientY,
      };
      wrap.classList.remove('is-joint');
      wrap.classList.add('is-drag');
    }
    const dx = event.clientX - pointerDrag.x;
    const dy = event.clientY - pointerDrag.y;
    if (pointerDrag.kind === 'camera') {
      view.azimuth = ((view.azimuth - dx * 0.35 + 180) % 360 + 360) % 360 - 180;
      view.elevation = Math.min(89, Math.max(-89, view.elevation - dy * 0.3));
      pointerDrag.x = event.clientX;
      pointerDrag.y = event.clientY;
      publishView();
      return;
    }
    if (pointerDrag.kind === 'joint') {
      const delta = (dx * pointerDrag.tangent.x + dy * pointerDrag.tangent.y) * 0.009;
      const { min, max, name } = pointerDrag.joint;
      pointerDrag.angle = Math.min(max, Math.max(min, pointerDrag.angle + delta));
      poseHold[name] = pointerDrag.angle;
      pointerDrag.x = event.clientX;
      pointerDrag.y = event.clientY;
    }
  }

  function onPointerUp(event) {
    if (!pointerDrag || (event && pointerDrag.pointerId !== event.pointerId)) return;
    if (wrap.hasPointerCapture(pointerDrag.pointerId)) wrap.releasePointerCapture(pointerDrag.pointerId);
    pointerDrag = null;
    wrap.classList.remove('is-cam', 'is-drag');
  }

  wrap.addEventListener('pointerdown', onPointerDown);
  wrap.addEventListener('pointermove', onPointerMove);
  wrap.addEventListener('pointerup', onPointerUp);
  wrap.addEventListener('pointercancel', onPointerUp);
  wrap.addEventListener('pointerleave', () => { if (!pointerDrag) showMarker(null); });
  wrap.addEventListener('wheel', (event) => {
    if (!shown) return;
    event.preventDefault();
    view.distance = Math.min(3.2, Math.max(0.5, view.distance * Math.exp(event.deltaY * 0.0012)));
    publishView();
  }, { passive: false });
  const poseReset = document.querySelector('.pose-reset-trigger');
  if (poseReset) {
    poseReset.addEventListener('click', () => {
      poseHold = null;
      view.azimuth = 0;
      view.elevation = 0;
      view.distance = 1;
      publishView();
      showMarker(null);
    });
  }

  /* 右栏姿态卡对原模型直接播放 GLB 片段；换成导入模型后，
     用同一套关节角保持姿态，避免姿态按钮只对原模型生效。 */
  function applyPosePreset(clip) {
    if (clip === 'standby') poseHold = { ...Q1_REST_POSE };
    else if (clip === 'raisehand') poseHold = { ...Q1_REST_POSE, ...Q1_MOTIONS.wave.pose };
    else if (clip === 'apose') poseHold = { ...Q1_REST_POSE, ...TPOSE };
    else poseHold = null;
  }
  window.addEventListener('robot-pose-change', (event) => {
    applyPosePreset(event.detail && event.detail.clip);
  });
  const selectedPose = document.querySelector('[data-pose-clip].is-on');
  if (selectedPose) applyPosePreset(selectedPose.dataset.poseClip);

  function applyJoints(angles) {
    for (const [name, id, axis] of HINGES) {
      const node = bones[id];
      const value = angles && typeof angles[name] === 'number' ? angles[name] : 0;
      node.rotation.set(0, 0, 0);
      node.rotation[axis] = value;
    }
  }

  function applyPose(angles) {
    applyJoints(angles);
    root.updateMatrixWorld(true);
    if (active && active.apply) active.apply();
  }

  function optionCard(id) {
    return Array.from(pick.querySelectorAll('[data-skin-id]'))
      .find((card) => card.dataset.skinId === id) || null;
  }

  function paintPick(id) {
    pick.querySelectorAll('[data-skin-id]').forEach((card) => {
      const active = card.dataset.skinId === id;
      card.classList.toggle('is-on', active);
      card.setAttribute('aria-pressed', String(active));
    });
  }

  function addOption(id, label) {
    if (optionCard(id)) return;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'skin-card';
    card.dataset.skinId = id;
    card.setAttribute('aria-pressed', 'false');
    card.innerHTML = [
      '<span class="skin-card__icon" aria-hidden="true">',
      '<svg viewBox="0 0 32 32"><path d="M16 5.5 9.5 9v5l2.5 1.5V25h8V15.5L22.5 14V9L16 5.5Z"/></svg>',
      '</span>',
      '<span class="skin-card__name"></span>',
    ].join('');
    card.querySelector('.skin-card__name').textContent = label;
    /* 导入钮已从网格里搬到 Costume 标题行，不再是 pick 的子节点：
       只有在它仍留在网格里时才插到它前面，否则直接追加到末尾 */
    if (importCard && importCard.parentElement === pick) pick.insertBefore(card, importCard);
    else pick.appendChild(card);
  }

  async function useBundled(id, url, name) {
    if (!loaded.has(id)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error('找不到 ' + name);
      const model = await loadCharacter(await response.arrayBuffer(), name);
      const mounted = mountImported(model);
      const bound = bindRetarget(mounted, proc);
      bound.name = name;
      loaded.set(id, bound);
      motion.add(bound.object);
      bound.object.visible = false;
    }
    return loaded.get(id);
  }

  async function useImport(id) {
    if (!loaded.has(id)) {
      const row = await dbGet(id);
      if (!row) throw new Error('找不到已导入的文件');
      const model = await loadCharacter(row.data, row.name);
      const mounted = mountImported(model);
      const bound = bindRetarget(mounted, proc);
      bound.name = row.name;
      loaded.set(id, bound);
      motion.add(bound.object);
      bound.object.visible = false;
    }
    return loaded.get(id);
  }

  async function selectSkin(id) {
    current = id;
    footRestZ = null;
    paintPick(id);
    try { localStorage.setItem(SKIN_KEY, id); } catch (err) { /* 隐私模式可能拒绝写入 */ }
    if (active) active.object.visible = false;
    active = null;
    removeBtn.hidden = !id.startsWith('file:');
    if (id === 'builtin:q1' || MATERIAL_THEMES[id] || LIVERIES[id]) {
      setFigureVisible(false);
      showStage(false);
      setOriginalMaterialTheme(id === 'builtin:q1' ? null : id);
      setNote('');
      return;
    }
    setOriginalMaterialTheme(null);
    showStage(true);
    if (id === 'builtin:xbot') {
      setFigureVisible(false);
      setNote('正在处理…');
      try {
        active = await useBundled(id, 'model/xbot.fbx', 'X Bot.fbx');
        active.object.visible = true;
        const n = active.links.length;
        setNote(n >= 8 ? '' : '没认出完整人体骨架，模型保持导入姿势');
      } catch (err) {
        setFigureVisible(true);
        setNote(err.message);
      }
      return;
    }
    if (id === 'builtin:clockwork') {
      setFigureVisible(false);
      setNote('');
      return;
    }
    if (id === 'builtin:pixel') {
      setFigureVisible(false);
      setNote('');
      return;
    }
    if (id === 'builtin:figure') {
      await selectSkin('builtin:q1');
      return;
    }
    setFigureVisible(false);
    setNote('正在处理…');
    try {
      active = await useImport(id);
      active.object.visible = true;
      const n = active.links.length;
      setNote(n >= 8 ? '' : '没认出完整人体骨架，模型保持导入姿势');
    } catch (err) {
      setFigureVisible(true);
      setNote(err.message);
    }
  }

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    setNote('正在处理 ' + file.name);
    try {
      const data = await file.arrayBuffer();
      const model = await loadCharacter(data.slice(0), file.name);
      const mounted = mountImported(model);
      const bound = bindRetarget(mounted, proc);
      if (!mounted.bones.hips && !mounted.bones.leftArm && !mounted.bones.leftUpLeg) {
        throw new Error('文件里没有 Hips / Arm / UpLeg 这类骨头');
      }
      const id = await dbPut({ name: file.name, data });
      bound.name = file.name;
      loaded.set(id, bound);
      motion.add(bound.object);
      bound.object.visible = false;
      addOption(id, file.name.replace(/\.[^.]+$/, ''));
      await selectSkin(id);
    } catch (err) {
      setNote(err.message);
    }
  });
  importCard?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    fileInput.click();
  });

  pick.addEventListener('click', (event) => {
    const card = event.target.closest('[data-skin-id]');
    if (card) selectSkin(card.dataset.skinId);
  });
  removeBtn.addEventListener('click', async () => {
    if (!current.startsWith('file:')) return;
    const option = optionCard(current);
    const label = option ? option.querySelector('.skin-card__name').textContent : '这个皮肤';
    if (!confirm('从列表里去掉「' + label + '」？')) return;
    const id = current;
    await dbDelete(id);
    const entry = loaded.get(id);
    if (entry) {
      motion.remove(entry.object);
      loaded.delete(id);
    }
    if (option) option.remove();
    await selectSkin('builtin:q1');
  });

  dbList().then(async (rows) => {
    rows.forEach((row) => addOption(row.id, row.name.replace(/\.[^.]+$/, '')));
    let saved = 'builtin:q1';
    try { saved = localStorage.getItem(SKIN_KEY) || saved; } catch (err) { /* 沿用原模型 */ }
    if (!optionCard(saved)) saved = 'builtin:q1';
    await selectSkin(saved);
  }).catch((err) => {
    setNote(err.message);
    selectSkin('builtin:q1');
  });
}

function captureReference(root, bones) {
  const nodes = {
    hips: root,
    chest: bones.waistYaw,
    leftArm: bones.lShYaw,
    leftForeArm: bones.lElbow,
    rightArm: bones.rShYaw,
    rightForeArm: bones.rElbow,
    leftUpLeg: bones.lHipYaw,
    leftLeg: bones.lKnee,
    leftFoot: bones.lAnkleRoll,
    rightUpLeg: bones.rHipYaw,
    rightLeg: bones.rKnee,
    rightFoot: bones.rAnkleRoll,
  };
  for (const [name, id, axis] of HINGES) {
    const node = bones[id];
    node.rotation.set(0, 0, 0);
    if (name in TPOSE) node.rotation[axis] = TPOSE[name];
  }
  root.updateMatrixWorld(true);
  const rest = new Map();
  for (const [role, node] of Object.entries(nodes)) {
    rest.set(role, node.getWorldQuaternion(new THREE.Quaternion()));
  }
  for (const [, id] of HINGES) bones[id].rotation.set(0, 0, 0);
  const segments = {
    leftArm: [bones.lShRoll, bones.lElbow],
    leftForeArm: [bones.lElbow, bones.lHand],
    rightArm: [bones.rShRoll, bones.rElbow],
    rightForeArm: [bones.rElbow, bones.rHand],
    leftUpLeg: [bones.lHipRoll, bones.lKnee],
    leftLeg: [bones.lKnee, bones.lAnkleRoll],
    leftFoot: [bones.lAnkleRoll, bones.lToe],
    rightUpLeg: [bones.rHipRoll, bones.rKnee],
    rightLeg: [bones.rKnee, bones.rAnkleRoll],
    rightFoot: [bones.rAnkleRoll, bones.rToe],
  };
  const hinges = {
    leftForeArm: bones.lElbow,
    rightForeArm: bones.rElbow,
    leftLeg: bones.lKnee,
    rightLeg: bones.rKnee,
  };
  return { nodes, rest, segments, hinges };
}

function pivot(parent, axis) {
  const node = new THREE.Group();
  node.userData.axis = axis;
  parent.add(node);
  return node;
}

function rod(length, radius, material, dir) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 0.9, length, 12),
    material
  );
  if (dir === '-z') {
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.z = -length / 2;
  } else if (dir === '+x') {
    mesh.rotation.z = -Math.PI / 2;
    mesh.position.x = length / 2;
  } else {
    mesh.rotation.x = Math.PI / 2;
    mesh.position.z = length / 2;
  }
  return mesh;
}

function ball(parent, radius, material) {
  parent.add(new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), material));
}

function limb(side, bones, material, sole) {
  const sign = side === 'left' ? 1 : -1;
  const prefix = side === 'left' ? 'l' : 'r';
  const hip = new THREE.Group();
  hip.position.set(0, sign * 0.08, 0);
  const hipPitch = pivot(hip, 'y');
  const hipRoll = pivot(hipPitch, 'x');
  const hipYaw = pivot(hipRoll, 'z');
  hipYaw.add(rod(0.24, 0.045, material, '-z'));
  const knee = pivot(hipYaw, 'y');
  knee.position.z = -0.24;
  ball(knee, 0.05, material);
  knee.add(rod(0.24, 0.038, material, '-z'));
  const anklePitch = pivot(knee, 'y');
  anklePitch.position.z = -0.24;
  const ankleRoll = pivot(anklePitch, 'x');
  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.07, 0.04), sole);
  foot.position.set(0.04, 0, -0.02);
  ankleRoll.add(foot);
  bones[prefix + 'Toe'] = foot;
  bones[prefix + 'HipPitch'] = hipPitch;
  bones[prefix + 'HipRoll'] = hipRoll;
  bones[prefix + 'HipYaw'] = hipYaw;
  bones[prefix + 'Knee'] = knee;
  bones[prefix + 'AnklePitch'] = anklePitch;
  bones[prefix + 'AnkleRoll'] = ankleRoll;
  return hip;
}

function arm(side, bones, skinMat) {
  const sign = side === 'left' ? 1 : -1;
  const prefix = side === 'left' ? 'l' : 'r';
  const shoulder = new THREE.Group();
  shoulder.position.set(0, sign * 0.18, 0.30);
  const pitch = pivot(shoulder, 'y');
  const roll = pivot(pitch, 'x');
  const yaw = pivot(roll, 'z');
  ball(yaw, 0.048, skinMat);
  yaw.add(rod(0.18, 0.034, skinMat, '-z'));
  const elbow = pivot(yaw, 'y');
  elbow.position.z = -0.18;
  ball(elbow, 0.04, skinMat);
  elbow.add(rod(0.16, 0.028, skinMat, '+x'));
  const hand = new THREE.Group();
  hand.position.x = 0.16;
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.015), skinMat);
  hand.add(palm);
  for (let i = -1; i <= 1; i++) {
    const finger = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.012, 0.012), skinMat);
    finger.position.set(0.032, i * 0.016, 0);
    hand.add(finger);
  }
  elbow.add(hand);
  bones[prefix + 'Hand'] = hand;
  bones[prefix + 'ShPitch'] = pitch;
  bones[prefix + 'ShRoll'] = roll;
  bones[prefix + 'ShYaw'] = yaw;
  bones[prefix + 'Elbow'] = elbow;
  return shoulder;
}

function buildFigure(mat) {
  const bones = {};
  const root = new THREE.Group();
  root.position.z = HIP_Z;
  root.add(rod(0.1, 0.07, mat.pants, '+z'));
  root.add(limb('left', bones, mat.pants, mat.sole));
  root.add(limb('right', bones, mat.pants, mat.sole));
  const waistRoll = pivot(root, 'x');
  waistRoll.position.z = 0.08;
  const waistPitch = pivot(waistRoll, 'y');
  bones.waistPitch = waistPitch;
  const waistYaw = pivot(waistPitch, 'z');
  waistYaw.add(rod(0.28, 0.09, mat.shirt, '+z'));
  bones.waistRoll = waistRoll;
  bones.waistYaw = waistYaw;
  const head = new THREE.Group();
  head.position.z = 0.40;
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 16), mat.skin));
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.092, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
    mat.hair
  );
  cap.rotation.x = Math.PI / 2;
  cap.position.z = 0.012;
  head.add(cap);
  const eye = new THREE.MeshLambertMaterial({ color: 0x1c1e22 });
  for (const y of [0.03, -0.03]) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), eye);
    mesh.position.set(0.078, y, 0.02);
    head.add(mesh);
  }
  waistYaw.add(head);
  waistYaw.add(arm('left', bones, mat.skin));
  waistYaw.add(arm('right', bones, mat.skin));
  return { root, bones };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('primebotx-skins', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('files', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbList() {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const request = db.transaction('files').objectStore('files').getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  }));
}

function dbGet(id) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const request = db.transaction('files').objectStore('files').get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

function dbPut(row) {
  const id = 'file:' + crypto.randomUUID();
  return openDb().then((db) => new Promise((resolve, reject) => {
    const request = db.transaction('files', 'readwrite').objectStore('files').put({ ...row, id });
    request.onsuccess = () => resolve(id);
    request.onerror = () => reject(request.error);
  }));
}

function dbDelete(id) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const request = db.transaction('files', 'readwrite').objectStore('files').delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }));
}
