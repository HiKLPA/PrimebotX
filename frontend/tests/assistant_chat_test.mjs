import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';


class ClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  toggle(value, force) {
    const on = force === undefined ? !this.values.has(value) : !!force;
    if (on) this.values.add(value); else this.values.delete(value);
    return on;
  }
}


class Node {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.classList = new ClassList();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.dataset = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.parent = null;
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    this.scrollHeight = this.children.length;
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
  }

  replaceChildren() { this.children = []; }

  addEventListener(name, callback) { this.listeners[name] = callback; }
  dispatchEvent(event) { if (this.listeners[event.type]) return this.listeners[event.type](event); }
  click() { this.dispatchEvent(new Event('click')); }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name] ?? null; }
  focus() {}
}


const composer = new Node();
const panel = new Node();
const log = new Node();
const input = new Node();
const sendButton = new Node();
const settingsButton = new Node();
const historyMenu = new Node();
const exportButton = new Node();
const clearButton = new Node();
const stopButton = new Node();
historyMenu.hidden = true;
panel.querySelector = selector => ({
  '[data-assistant-log]': log,
  '[data-chat-settings]': settingsButton,
  '[data-assistant-stop]': stopButton,
  '[data-chat-suggestions]': null,
})[selector];
composer.querySelector = selector => ({
  '[data-assistant-chat]': panel,
  '[data-assistant-log]': log,
  '[data-assistant-input]': input,
  '[data-assistant-send]': sendButton,
  '[data-chat-settings]': settingsButton,
  '[data-assistant-stop]': stopButton,
})[selector];

globalThis.document = {
  listeners: {},
  querySelector: selector => selector === '.composer' ? composer :
    (selector === '[data-assistant-chat]' ? panel :
      ({
        '[data-chat-settings]': settingsButton,
        '[data-chat-history-menu]': historyMenu,
        '[data-chat-export]': exportButton,
        '[data-chat-clear]': clearButton,
        '[data-assistant-stop]': stopButton,
      }[selector] || null)),
  addEventListener(name, callback) { this.listeners[name] = callback; },
  createElement: () => new Node(),
};
globalThis.location = {search: ''};
globalThis.sessionStorage = {getItem() { return null; }, setItem() {}, removeItem() {}};
globalThis.requestAnimationFrame = callback => callback();
globalThis.Event = class { constructor(type) { this.type = type; } };
globalThis.CustomEvent = class extends Event {
  constructor(type, options = {}) { super(type); this.detail = options.detail; }
};
const viewChanges = [];
globalThis.window = {
  addEventListener() {},
  dispatchEvent() {},
  matchMedia: () => ({matches: false}),
  primebotxPersona: {active: {prompt: '温柔知性的测试角色'}},
  robot3d: {
    ready: true,
    played: [],
    clipsPlayed: [],
    moods: [],
    stopped: 0,
    getGestureInfo(id) {
      return ['salute', 'wave', 'belly_laugh'].includes(id) ? {id, label: id, duration: 0} : null;
    },
    playGesture(id) {
      if (!['salute', 'wave', 'belly_laugh'].includes(id)) return false;
      this.played.push(id);
      return true;
    },
    playClip(id) { this.clipsPlayed.push(id); },
    resetPose() { this.clipsPlayed.push('reset'); },
    setMood(id) { this.moods.push(id); },
    stopGesture() { this.stopped += 1; },
  },
  viewControl: {
    get view() { return {azimuth: 0, elevation: 0, distance: 1}; },
    setView(value) { viewChanges.push(value); return true; },
    resetView() { viewChanges.push('reset'); },
  },
};

let fetchCalls = 0;
let releaseFetch;
let lastRequestBody = null;
globalThis.fetch = (_url, options) => {
  fetchCalls += 1;
  lastRequestBody = JSON.parse(options.body);
  return new Promise(resolve => {
    releaseFetch = () => resolve({
      ok: true,
      json: async () => ({
        data: {
          reply: '当然可以。',
          action_id: 'salute',
          actions: ['salute'],
          stop: false,
          model: 'deepseek-flash',
        },
        error: null,
      }),
    });
  });
};

const source = fs.readFileSync(new URL('../js/assistant_chat.js', import.meta.url), 'utf8');
vm.runInThisContext(source, {filename: 'assistant_chat.js'});

input.value = '换行';
input.listeners.keydown({key: 'Enter', shiftKey: true, isComposing: false, preventDefault() {}});
assert.equal(fetchCalls, 0, 'Shift+Enter should not submit');

input.value = '拼音输入中';
input.listeners.keydown({key: 'Enter', shiftKey: false, isComposing: true, preventDefault() {}});
assert.equal(fetchCalls, 0, 'IME composition should not submit');

input.value = '请敬礼';
const first = window.primebotxChat.submit();
input.value = '重复提交';
const duplicate = window.primebotxChat.submit();
assert.equal(fetchCalls, 1, 'pending requests should block duplicate submits');
assert.equal(lastRequestBody.persona, '温柔知性的测试角色');
releaseFetch();
await Promise.all([first, duplicate]);
assert.deepEqual(window.robot3d.played, ['salute']);
assert.equal(window.primebotxChat.history.length, 2);

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({data: {reply: '不执行未知动作。', action_id: 'backflip', model: 'deepseek-flash'}, error: null}),
});
input.value = '后空翻';
await window.primebotxChat.submit();
assert.deepEqual(window.robot3d.played, ['salute']);
assert.equal(log.children.at(-1).textContent, '命令未执行：动作 backflip');

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    data: {reply: '依次执行。', actions: ['wave', 'salute'], stop: false, model: 'deepseek-flash'},
    error: null,
  }),
});
input.value = '先挥手，再敬礼';
await window.primebotxChat.submit();
await new Promise(resolve => setTimeout(resolve, 350));
assert.deepEqual(window.robot3d.played, ['salute', 'wave', 'salute']);

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    data: {
      reply: '执行组合命令。',
      actions: ['belly_laugh'],
      commands: [
        {type: 'view', preset: 'left'},
        {type: 'motion', id: 'belly_laugh'},
        {type: 'emotion', id: 'happy'},
        {type: 'pose', id: 'apose'},
        {type: 'reset_pose'},
        {type: 'reset_view'},
      ],
      stop: false,
      model: 'custom-model',
    },
    error: null,
  }),
});
input.value = '执行组合命令';
await window.primebotxChat.submit();
await new Promise(resolve => setTimeout(resolve, 350));
assert.deepEqual(window.robot3d.played.slice(-1), ['belly_laugh']);
assert.deepEqual(window.robot3d.moods.slice(-2), ['happy', 'calm']);
assert.deepEqual(window.robot3d.clipsPlayed.slice(-3), ['apose', 'reset', 'idle']);
assert.equal(viewChanges.length, 2);

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({data: {reply: '已停止。', actions: [], stop: true, model: 'deepseek-flash'}, error: null}),
});
input.value = '停止动作';
await window.primebotxChat.submit();
assert.equal(stopButton.hidden, true, 'stop button should be hidden once the motion stops');
assert.ok(window.robot3d.stopped >= 1);

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({data: {reply: '收到。', action_id: null, model: 'deepseek-flash'}, error: null}),
});
for (let index = 0; index < 6; index += 1) {
  input.value = '消息 ' + index;
  await window.primebotxChat.submit();
}
assert.equal(window.primebotxChat.history.length, 10, 'history should retain at most ten messages');

settingsButton.dispatchEvent(new Event('click'));
assert.equal(historyMenu.hidden, false, 'settings should open the chat history menu');
assert.equal(settingsButton.getAttribute('aria-expanded'), 'true');
assert.equal(window.primebotxChat.history.length, 10, 'settings should not clear chat history');

clearButton.dispatchEvent(new Event('click'));
assert.equal(window.primebotxChat.history.length, 0);
assert.equal(log.children.length, 0);
assert.equal(historyMenu.hidden, true, 'clearing should close the history menu');

console.log('PASS: chat controls, action sequence, stop command, validation, history limit, history menu');
