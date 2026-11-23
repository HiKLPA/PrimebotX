// Shared idle rhythm. Reactions are sampled from the render loop so no extra
// timer or animation clip can compete with gesture playback.
const KEY = 'primebotx.idle.enabled';
const FIRST_REACTION_MS = 45000;
const REACTION_GAP_MS = [75000, 150000];
const REACTION_DURATION_MS = 5200;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let enabled = true;
try { enabled = localStorage.getItem(KEY) !== '0'; } catch (_) {}
let lastActivity = performance.now(), phase = 0, weight = 0, last = performance.now();
let nextReaction = lastActivity + FIRST_REACTION_MS;
let reaction = null, lastKind = 'settle';
let state = {enabled, active: false, kind: 'rest', offsets: {}};
const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const randomGap = () => REACTION_GAP_MS[0] + Math.random() * (REACTION_GAP_MS[1] - REACTION_GAP_MS[0]);
function activity(value) {
  const now = typeof value === 'number' ? value : performance.now();
  lastActivity = now;
  nextReaction = now + FIRST_REACTION_MS;
  reaction = null;
}
const interactiveSelector = [
  'button:not([disabled])', 'a[href]', 'input:not([disabled])',
  'textarea:not([disabled])', 'select:not([disabled])', 'summary',
  '[contenteditable="true"]', '[role="button"]:not([aria-disabled="true"])',
  '[role="tab"]:not([aria-disabled="true"])', '[role="slider"]:not([aria-disabled="true"])',
].join(',');
function pointerActivity(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(interactiveSelector)) activity();
}
document.addEventListener('pointerdown', pointerActivity, {passive: true, capture: true});
['keydown', 'wheel'].forEach(type =>
  document.addEventListener(type, activity, {passive: true, capture: true}));
window.addEventListener('robot-ready', activity, {once: true});
document.addEventListener('visibilitychange', () => { activity(); weight = 0; state = {...state, active: false, offsets: {}}; });
reduced.addEventListener('change', () => { activity(); weight = 0; state = {...state, active: false, offsets: {}}; });
export function setIdleEnabled(value) {
  enabled = !!value; activity();
  try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch (_) {}
  paint();
}
function paint() {
  document.querySelectorAll('[data-idle-enabled]').forEach(button => {
    const selected = (button.dataset.idleEnabled === 'true') === enabled;
    button.classList.toggle('is-sel', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}
export function sampleIdle(now, blocked = false) {
  const dt = Math.min(.08, Math.max(0, (now - last) / 1000)); last = now;
  if (blocked) activity(now);
  const allowed = enabled && !reduced.matches && !document.hidden && !blocked;
  const quiet = (now - lastActivity) / 1000;
  const target = allowed ? smooth((quiet - 2) / 2) : 0;
  // Control changes must never leave an additive offset on an edited pose.
  weight = blocked || !allowed ? 0 : weight + (target - weight) * Math.min(1, dt * 3);
  if (allowed) phase += dt;
  if (allowed && !reaction && now >= nextReaction) {
    /* 两种反应轮流来：随机抽签会连着冒出同一条自言自语 */
    const kind = lastKind === 'look' ? 'settle' : 'look';
    lastKind = kind;
    reaction = {
      kind,
      start: now,
      direction: Math.random() < .5 ? -1 : 1,
    };
    window.dispatchEvent(new CustomEvent('primebotx-idle-reaction', {
      detail: {kind: reaction.kind},
    }));
  }

  let envelope = 0;
  if (reaction) {
    const progress = (now - reaction.start) / REACTION_DURATION_MS;
    if (progress >= 1 || !allowed) {
      reaction = null;
      nextReaction = now + randomGap();
    } else {
      envelope = Math.sin(Math.PI * progress) ** 2;
    }
  }
  const look = reaction?.kind === 'look' ? envelope * reaction.direction : 0;
  const settle = reaction?.kind === 'settle' ? envelope : 0;
  const offsets = {
    waist_roll_joint: weight * (.009 * Math.sin(phase * .65) + .026 * settle),
    waist_yaw_joint: weight * .13 * look,
    left_shoulder_pitch_joint: weight * (.012 * Math.sin(phase * 1.35) - .025 * settle),
    right_shoulder_pitch_joint: weight * (.012 * Math.sin(phase * 1.35) - .025 * settle),
    left_shoulder_roll_joint: weight * .07 * settle,
    right_shoulder_roll_joint: -weight * .07 * settle,
  };
  state = {enabled, active: weight > .001, kind: reaction?.kind || 'breathe', offsets};
  return state;
}
export function idleState() { return state; }
document.querySelectorAll('[data-idle-enabled]').forEach(button =>
  button.addEventListener('click', () => setIdleEnabled(button.dataset.idleEnabled === 'true')));
paint();
window.primebotxIdle = {setEnabled: setIdleEnabled, get state() { return state; }};
