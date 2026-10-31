/* PrimebotX 国际化引擎：纯原生 JS，无依赖。
 * 用法：HTML 元素加 data-i18n="key"，JS 里调用 t('key')。
 * 新增语言只需在 I18N 里加一组字典，页面文字自动跟随。 */

const I18N = {
  en: {
    "nav.camera": "Camera",
    "nav.modal": "Modal",
    "nav.connect": "Connect",
    "nav.preference": "Preference",
    "nav.advance": "Advance",
    "nav.settings": "Settings",
    "nav.privacy": "Privacy",
    "nav.contact": "Contact",

    "rail.left.pinned": "Pinned",
    "rail.left.action": "Action",
    "rail.left.dialog": "Dialog",
    "rail.left.tendance": "Tendance",
    "rail.left.edit": "Edit",
    "rail.left.empty": "No saved cards",
    "rail.left.empty.hint": "Click the pin button on action / dialogue / care cards to add",
    "rail.left.type": "Type",
    "rail.left.name": "Name",
    "rail.left.intro": "Intro",
    "rail.left.reset": "Reset",
    "rail.left.add": "Add",
    "rail.left.group.action": "Action",
    "rail.left.group.dialog": "Dialog",
    "rail.left.group.tendance": "Tendance",
    "rail.left.brief": "Brief Intro",
    "rail.left.duration": "Expected Duration(s)",

    "rail.right.chat": "Chat",
    "rail.right.log": "Log",
    "rail.right.message": "Message",

    "dock.gestures": "Gestures",
    "dock.emotions": "Emotions",

    "hud.ready": "Ready",

    "modal.connect.title": "Connect",
    "modal.connect.available": "2 available",
    "modal.connect.current": "current",
    "modal.cancel": "CANCEL",
    "modal.confirm": "CONFIRM",
    "modal.preference.title": "Preference",
    "modal.preference.available": "3 available",
    "modal.advance.title": "Advance",
    "modal.advance.sub": "MuJoCo simulation",
    "modal.privacy.title": "Privacy",
    "modal.privacy.sub": "Privacy Policy",
    "modal.contact.title": "Contact",
    "modal.contact.sub": "Contact & Feedback",

    "sim.connect_btn": "Connect Sim",
    "sim.connected": "Connected",
    "sim.disconnect": "Disconnect",
    "sim.empty": "Please connect to simulation first",
    "sim.speed": "Speed",
    "sim.tab.arm": "Arm",
    "sim.tab.waist": "Waist",
    "sim.tab.leg": "Leg",
    "sim.tab.link": "Link",
    "sim.row.posture": "Posture",
    "sim.row.gesture": "Gesture",
    "sim.row.gait": "Gait",
    "sim.mode.dynamic": "Dynamic Mode",
    "sim.mode.kinematic": "Kinematic Mode",
    "sim.reset_pose": "Reset Pose",
    "sim.reset_cam": "Reset View",
    "sim.turn_left": "Turn Left",
    "sim.turn_right": "Turn Right",
    "sim.stop": "Stop",
    "sim.save_frame": "Save Frame",
    "sim.hint": "Start sim/mujoco_bridge.py first, then click Connect Sim.",

    "sim.stat.t": "Time",
    "sim.stat.mode": "Mode",
    "sim.stat.step": "Steps",
    "sim.stat.contacts": "Contacts",
    "sim.stat.speed": "Speed",
    "sim.stat.gesture": "Gesture",
    "sim.stat.gait": "Gait",
    "sim.stat.body": "Height",
    "sim.stat.cam": "Camera",
    "sim.stat.latency": "Latency",

    "settings.title": "Settings",
    "settings.appearance": "Appearance",
    "settings.mode": "Mode",
    "settings.mode.day": "Day",
    "settings.mode.night": "Night",
    "settings.background": "Background",
    "settings.bg.plain": "Plain",
    "settings.bg.magnet": "Magnet",
    "settings.bg.wave": "Wave",
    "settings.language": "Language",
    "settings.lang.en": "English",
    "settings.lang.zh": "简体中文",
  },

  zh: {
    "nav.camera": "相机",
    "nav.modal": "模态",
    "nav.connect": "连接",
    "nav.preference": "偏好",
    "nav.advance": "高级",
    "nav.settings": "设置",
    "nav.privacy": "隐私",
    "nav.contact": "联系",

    "rail.left.pinned": "已标记",
    "rail.left.action": "动作",
    "rail.left.dialog": "对话",
    "rail.left.tendance": "趋势",
    "rail.left.edit": "编辑",
    "rail.left.empty": "暂无已标记卡片",
    "rail.left.empty.hint": "请点击 动作 / 对话 / 趋势类卡片左下角的标记按钮以添加",
    "rail.left.type": "类型",
    "rail.left.name": "名称",
    "rail.left.intro": "简介",
    "rail.left.reset": "重置",
    "rail.left.add": "添加",
    "rail.left.group.action": "动作",
    "rail.left.group.dialog": "对话",
    "rail.left.group.tendance": "趋势",
    "rail.left.brief": "简介",
    "rail.left.duration": "预计时长(秒)",

    "rail.right.chat": "聊天",
    "rail.right.log": "日志",
    "rail.right.message": "消息",

    "dock.gestures": "手势",
    "dock.emotions": "表情",

    "hud.ready": "就绪",

    "modal.connect.title": "连接",
    "modal.connect.available": "2 台可用",
    "modal.connect.current": "当前",
    "modal.cancel": "取消",
    "modal.confirm": "确认",
    "modal.preference.title": "偏好",
    "modal.preference.available": "3 台可用",
    "modal.advance.title": "高级",
    "modal.advance.sub": "MuJoCo 仿真",
    "modal.privacy.title": "隐私",
    "modal.privacy.sub": "隐私政策",
    "modal.contact.title": "联系",
    "modal.contact.sub": "联系与反馈",

    "sim.connect_btn": "连接仿真",
    "sim.connected": "已连接",
    "sim.disconnect": "断连",
    "sim.empty": "请先连接仿真",
    "sim.speed": "速度",
    "sim.tab.arm": "手臂",
    "sim.tab.waist": "腰",
    "sim.tab.leg": "腿",
    "sim.tab.link": "联动",
    "sim.row.posture": "姿态",
    "sim.row.gesture": "动作",
    "sim.row.gait": "步态",
    "sim.mode.dynamic": "动力学模式",
    "sim.mode.kinematic": "运动学模式",
    "sim.reset_pose": "重置姿态",
    "sim.reset_cam": "重置视角",
    "sim.turn_left": "左转",
    "sim.turn_right": "右转",
    "sim.stop": "停止",
    "sim.save_frame": "保存当前帧",
    "sim.hint": "先启动 sim/mujoco_bridge.py，再点连接仿真。",

    "sim.stat.t": "运行",
    "sim.stat.mode": "模式",
    "sim.stat.step": "步数",
    "sim.stat.contacts": "触点",
    "sim.stat.speed": "速度",
    "sim.stat.gesture": "动作",
    "sim.stat.gait": "步态",
    "sim.stat.body": "机身",
    "sim.stat.cam": "视角",
    "sim.stat.latency": "延迟",

    "settings.title": "设置",
    "settings.appearance": "外观",
    "settings.mode": "模式",
    "settings.mode.day": "浅色",
    "settings.mode.night": "深色",
    "settings.background": "背景",
    "settings.bg.plain": "纯色",
    "settings.bg.magnet": "磁吸",
    "settings.bg.wave": "波浪",
    "settings.language": "语言",
    "settings.lang.en": "English",
    "settings.lang.zh": "简体中文",
  },
};

const I18N_KEY = "px.lang";

function getLang() {
  try {
    const v = localStorage.getItem(I18N_KEY);
    if (v === "zh" || v === "en") return v;
  } catch (e) {}
  return "en";
}

function t(key) {
  const lang = getLang();
  if (I18N[lang] && I18N[lang][key] !== undefined) return I18N[lang][key];
  if (I18N.en && I18N.en[key] !== undefined) return I18N.en[key];
  return key;
}

function applyLang(lang) {
  try { localStorage.setItem(I18N_KEY, lang); } catch (e) {}
  document.documentElement.setAttribute("lang", lang === "zh" ? "zh-CN" : "en");
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    el.textContent = t(key);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    el.setAttribute("placeholder", t(key));
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const key = el.getAttribute("data-i18n-aria");
    el.setAttribute("aria-label", t(key));
  });
  document.querySelectorAll("[data-lang]").forEach((b) => {
    const on = b.getAttribute("data-lang") === lang;
    b.classList.toggle("is-sel", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
  document.dispatchEvent(new CustomEvent("langchange", { detail: { lang } }));
}

document.addEventListener("DOMContentLoaded", () => {
  applyLang(getLang());

  document.querySelectorAll("[data-lang]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lang = btn.getAttribute("data-lang");
      document.querySelectorAll("[data-lang]").forEach((b) => b.classList.remove("is-sel"));
      btn.classList.add("is-sel");
      applyLang(lang);
    });
  });
});
