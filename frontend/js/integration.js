/* Q1 management API adapter: local mock mode, never a real robot connection. */
(function () {
  'use strict';
  var ready = false, busy = false, polling = false, robots = [];
  var panel = document.createElement('details');
  panel.className = 'integration'; panel.open = true;
  panel.innerHTML = '<summary>Q1 管理联调 · MOCK 模拟模式</summary>' +
    '<p role="status" data-api-message>正在读取后端状态…</p>' +
    '<button type="button" data-api-connect>连接模拟设备</button>' +
    '<button type="button" data-api-disconnect>断开</button>' +
    '<label>模拟 TTS（不会真实发声）<input data-api-tts maxlength="300" placeholder="输入播报文本"><button type="button" data-api-speak>提交</button></label>' +
    '<label>音量 <input data-api-volume type="number" min="0" max="100" value="50"><button type="button" data-api-audio>设置</button></label>' +
    '<label><input type="checkbox" data-api-mute>静音（点击设置后生效）</label>' +
    '<p>移动、Play/Pause、摄像头和 AI 聊天尚未实现。下方记录来自后端内存日志。</p>' +
    '<pre data-api-logs aria-label="后端日志"></pre>';
  document.body.appendChild(panel);
  var $ = function (s) { return document.querySelector(s); };
  var message = panel.querySelector('[data-api-message]');
  function say(text) { message.textContent = text; }
  async function api(path, method, body) {
    var options = {method: method || 'GET', headers: {}};
    if (options.method !== 'GET') {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Idempotency-Key'] = crypto.randomUUID();
    }
    if (body !== undefined) options.body = JSON.stringify(body);
    options.signal = AbortSignal.timeout(5000);
    var response = await fetch('/api/v1' + path, options);
    var result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error ? result.error.message : 'HTTP ' + response.status);
    return result.data;
  }
  function controls() {
    panel.querySelector('[data-api-connect]').disabled = busy || ready || !robots.length;
    panel.querySelector('[data-api-disconnect]').disabled = busy || !ready;
    panel.querySelectorAll('[data-api-speak],[data-api-audio]').forEach(function (b) { b.disabled = busy || !ready; });
    document.querySelectorAll('[data-api-action]').forEach(function (b) { b.disabled = busy || !ready; });
  }
  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      var results = await Promise.all([api('/status'), api('/logs?limit=100')]);
      var status = results[0]; var previouslyReady = ready;
      ready = status.connection_state === 'ready';
      if (ready && !previouslyReady) {
        var audio = await api('/audio');
        panel.querySelector('[data-api-volume]').value = audio.volume;
        panel.querySelector('[data-api-mute]').checked = audio.muted;
      }
      var hud = $('.hud__state--ready, [data-api-state]');
      if (hud) { hud.dataset.apiState = ''; hud.textContent = ready ? '模拟已连接' : '未连接'; }
      var name = ready ? 'Q1 模拟设备' : '未连接设备';
      if (window.hudName) window.hudName(name);
      var text = $('.hud__batt-num'), level = $('[data-hud-batt-level]');
      if (text) text.textContent = status.battery ? status.battery.percent : '--';
      if (level) level.setAttribute('width', status.battery ? 30 * status.battery.percent / 100 : 0);
      var sig = $('.hud__sig--ok, .hud__sig--low');
      if (sig) { sig.style.opacity = '.25'; sig.parentElement.title = '信号未知，后端未提供'; }
      panel.querySelector('[data-api-logs]').textContent = results[1].items.map(function (x) { return JSON.stringify(x); }).join('\n') || '暂无操作日志';
      document.querySelectorAll('[data-api-log-view]').forEach(function (el) { el.textContent = panel.querySelector('[data-api-logs]').textContent; });
    } catch (e) {
      ready = false; say('后端不可用：' + e.message);
      var hud = $('[data-api-state], .hud__state--ready');
      if (hud) { hud.dataset.apiState = ''; hud.textContent = '后端不可用'; }
      var text = $('.hud__batt-num'), level = $('[data-hud-batt-level]');
      if (text) text.textContent = '--';
      if (level) level.setAttribute('width', 0);
    } finally { polling = false; controls(); }
  }
  async function run(path, method, body) {
    if (busy) return;
    busy = true; controls();
    try {
      var op = await api(path, method, body);
      say('模拟已受理：' + op.operation_id + '；robot_executed=false（未执行真机操作）');
      await refresh();
    } catch (e) { say('请求失败：' + e.message); }
    finally { busy = false; controls(); }
  }
  function connect() { if (robots.length) return run('/connections', 'POST', {robot_id:robots[0].robot_id, mode:'mock'}); }
  panel.querySelector('[data-api-connect]').onclick = connect;
  panel.querySelector('[data-api-disconnect]').onclick = function () { run('/connection', 'DELETE'); };
  panel.querySelector('[data-api-speak]').onclick = function () { run('/tts', 'POST', {text:panel.querySelector('[data-api-tts]').value, interrupt:false}); };
  panel.querySelector('[data-api-audio]').onclick = function () { run('/audio', 'PUT', {volume:Number(panel.querySelector('[data-api-volume]').value), muted:panel.querySelector('[data-api-mute]').checked}); };
  var modal = $('#modal');
  if (modal) modal.addEventListener('modal:confirm', function (e) { if (e.detail.name === 'Connect') connect(); });
  document.querySelectorAll('[data-dir], .dock__btn--play, .chat__btn--history').forEach(function (b) { b.disabled = true; b.title = '尚未实现'; });
  var chat = $('[data-chat-input]');
  if (chat) { chat.disabled = true; chat.placeholder = 'AI 聊天未实现；TTS 请使用联调面板'; }
  ['dialog','tendance'].forEach(function (kind) {
    var group = $('.sc-group--' + kind);
    if (group) {
      group.querySelectorAll(':scope > :not(.sc-group__title)').forEach(function (el) { el.remove(); });
      group.querySelector('.sc-group__title').textContent = kind + ' · 尚未实现';
    }
  });
  var logBody = $('#rail-tools [data-panel-body]');
  if (logBody) {
    var logView = document.createElement('pre'); logView.dataset.apiLogView = '';
    logView.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px'; logBody.appendChild(logView);
    function logVisibility() { logView.hidden = logBody.dataset.view !== 'log'; }
    new MutationObserver(logVisibility).observe(logBody, {attributes:true, attributeFilter:['data-view']}); logVisibility();
  }
  async function init() {
    controls();
    try {
      var results = await Promise.all([api('/robots'), api('/capabilities')]); robots = results[0];
      var list = $('[data-model-list]');
      if (list) {
        list.replaceChildren();
        robots.forEach(function (robot, i) {
          var row = document.createElement('div'); row.className = 'mrow' + (i ? '' : ' is-sel'); row.dataset.model = robot.name;
          var b = document.createElement('button'); b.className = 'mrow__pill'; b.type = 'button'; b.textContent = robot.name + '（模拟）';
          row.appendChild(b); list.appendChild(row);
        });
      }
      var group = $('.sc-group--action');
      if (group) {
        group.querySelectorAll(':scope > :not(.sc-group__title)').forEach(function (el) { el.remove(); });
        group.querySelector('.sc-group__title').textContent = 'Action · 模拟动作';
        var names = {'q1.wave':'挥手', 'q1.heart':'比心', 'q1.cheer':'加油'};
        results[1].actions.forEach(function (action) {
          var b = document.createElement('button'); b.className = 'sc'; b.type = 'button'; b.dataset.apiAction = action.id;
          b.textContent = (names[action.id] || action.id) + ' · 模拟';
          b.onclick = function () { run('/actions', 'POST', {action_id:action.id}); }; group.appendChild(b);
        });
      }
      say('后端已就绪；请选择“连接模拟设备”。所有功能仅模拟。');
      await refresh();
    } catch (e) { say('初始化失败，请刷新重试：' + e.message); controls(); }
  }
  init(); setInterval(refresh, 2000);
})();
