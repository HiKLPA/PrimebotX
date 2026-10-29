/* MuJoCo 仿真联调，挂在 Advance 弹窗里（页面上不再有右下角浮层）。
   连上 q1-sim 后：滑块改关节、按钮触发姿态/手势/步态、左侧九宫格驱动底盘、
   画面上拖动可转视角、滚轮缩放，键盘 WASD 也能走。
   所有请求走同源 /api/v1，写操作带 Idempotency-Key；
   桥没起时只在面板里报错，不伪造成功。 */
(function () {
  'use strict';

  /* 默认同源 /api/v1。若页面不是从后端 8080 打开的（本地静态服务器、file://、
     内置预览），可以用 ?api=http://127.0.0.1:8080/api/v1 指定后端地址。 */
  var API = (function () {
    var q = new URLSearchParams(location.search).get('api');
    return q ? q.replace(/\/+$/, '') : '/api/v1';
  })();
  var GROUPS = { arm: /shoulder|elbow/, waist: /waist/, leg: /hip|knee|ankle/ };
  var SEND_DEBOUNCE = 120;
  var CAM_DEBOUNCE = 80;

  var pane = document.querySelector('.adv[data-advance-only]');
  if (!pane) return;
  /* 工具按钮挂在面板左外侧（不在 .adv 里），单独取一次作用域 */
  var rail = document.querySelector('.adv__rail');
  /* 提示文本挪到了面板外右侧参数栏的底部，不在 .adv 里 */
  var message = document.querySelector('[data-sim-message]');
  var frame = pane.querySelector('[data-sim-frame]');
  var viewport = pane.querySelector('[data-sim-viewport]');
  var jointsBox = pane.querySelector('[data-sim-joints]');
  /* 联动区与关节滑块互斥：同一个位置，切 tab 换内容 */
  var linkBox = pane.querySelector('[data-sim-link]');
  /* 参数列挂在面板外侧（不在 .adv 里），所以按文档查 */
  var readout = document.querySelector('[data-sim-state]');
  var modeBtn = rail.querySelector('[data-sim-mode]');
  var speedInput = pane.querySelector('[data-sim-speed]');
  var speedVal = pane.querySelector('[data-sim-speed-val]');
  var camResetBtn = rail.querySelector('[data-sim-cam-reset]');
  var shotBtn = rail.querySelector('[data-sim-shot]');
  var presetsBox = pane.querySelector('[data-sim-presets]');
  var gesturesBox = pane.querySelector('[data-sim-gestures]');
  var gaitsBox = pane.querySelector('[data-sim-gaits]');
  /* 连接仿真是弹窗标题区右上角那枚主动作，落在 pane 之外 */
  var connectBtn = document.querySelector('[data-sim-connect]');

  var connected = false, busy = false, showFrame = true;
  var sliders = {};                 // name -> input 元素
  var dragging = {};                // name -> 是否正在拖
  var pending = {};                 // 待发送的关节目标
  var timer = null, frameTimer = null, stateTimer = null, camTimer = null;
  var dynamic = false, group = 'arm';
  var joints = [];                  // 关节表原始行
  var lastState = null;
  var cam = null;                   // {azimuth, elevation, distance}，桥没相机时为 null
  var activeGesture = null, activeGait = null, activePreset = null;

  function say(text) { if (message) message.textContent = text; }
  /* 弹窗关着时不必每 120ms 去要一张图，省掉无谓的请求 */
  function visible() { return !pane.hidden; }

  /* 打开方式不对时，接口请求根本到不了后端，先在面板里说清楚，
     省得点下去只看到一句空响应 */
  if (location.protocol === 'file:') {
    say('页面是用 file:// 打开的，接口请求到不了后端。请改为访问 http://127.0.0.1:8080/ui/PrrimebotX.html');
  } else if (API === '/api/v1' && location.port !== '8080') {
    say('当前页面来自 ' + location.host + '，不是后端的 8080。' +
        '要么直接开 http://127.0.0.1:8080/ui/PrrimebotX.html，' +
        '要么在地址后加 ?api=http://127.0.0.1:8080/api/v1');
  }

  async function api(path, method, body) {
    var options = { method: method || 'GET', headers: {} };
    if (options.method !== 'GET') {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Idempotency-Key'] = crypto.randomUUID();
    }
    if (body !== undefined) options.body = JSON.stringify(body);
    options.signal = AbortSignal.timeout(5000);
    var response = await fetch(API + path, options);
    /* 先取文本再解析：空 body 或非 JSON（多为页面不是从后端端口打开，
       请求打到了静态服务器）时能报出地址和状态码，而不是一句 Unexpected end of JSON input */
    var text = await response.text();
    var result = null;
    if (text) {
      try { result = JSON.parse(text); }
      catch (e) { throw new Error(method + ' ' + API + path + ' 返回的不是 JSON（HTTP ' + response.status + '），实际内容：' + text.slice(0, 60)); }
    }
    if (!result) throw new Error(method + ' ' + API + path + ' 返回空响应（HTTP ' + response.status + '），确认页面是从后端 8080 打开的');
    if (!response.ok || result.error) throw new Error(result.error ? result.error.message : 'HTTP ' + response.status);
    return result.data;
  }

  function controls() {
    /* 未连接时右侧只留一句「请先连接仿真」：其余操作全部收起，
       靠 CSS 的 .adv.is-offline 规则隐藏，这里只管切类 */
    pane.classList.toggle('is-offline', !connected);
    /* 连接按钮在标题区右上角，不在 pane 里，所以从 document 抓 */
    if (connectBtn) connectBtn.disabled = busy || connected;
    ['reset', 'stop', 'mode', 'shot'].forEach(function (key) {
      rail.querySelector('[data-sim-' + key + ']').disabled = busy || !connected;
    });
    camResetBtn.disabled = busy || !connected || !cam;
    speedInput.disabled = !connected;
    pane.querySelectorAll('[data-joint-group]').forEach(function (b) { b.disabled = !connected; });
    Object.keys(sliders).forEach(function (name) { sliders[name].disabled = !connected || dynamic; });
    /* 手势与步态靠改 target 驱动，动力学模式下机器人会被重力带倒，先禁掉 */
    pane.querySelectorAll('[data-sim-preset]').forEach(function (b) { b.disabled = busy || !connected; });
    pane.querySelectorAll('[data-sim-gesture]').forEach(function (b) { b.disabled = busy || !connected || dynamic; });
    pane.querySelectorAll('[data-sim-gait]').forEach(function (b) { b.disabled = busy || !connected || dynamic; });
    rail.querySelectorAll('[data-sim-turn]').forEach(function (b) { b.disabled = busy || !connected || dynamic; });
  }

  /* ---------- 关节滑块 ---------- */

  function known(name) {
    if (lastState && lastState.joints && name in lastState.joints) return lastState.joints[name];
    var row = joints.filter(function (j) { return j.name === name; })[0];
    var range = (row && row.range) || [-3.14, 3.14];
    return (range[0] + range[1]) / 2;
  }

  /* 轨道填充：把当前值换算成百分比写到元素上，CSS 用两段渐变把它画成
     「左边主题色、右边 text-muted」，拖动或状态同步后都要刷一次 */
  function paintFill(input) {
    if (!input) return;
    var min = parseFloat(input.min);
    var max = parseFloat(input.max);
    var val = parseFloat(input.value);
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 100;
    if (!isFinite(val)) val = min;
    var pct = max > min ? (val - min) / (max - min) * 100 : 0;
    input.style.setProperty('--fill', Math.max(0, Math.min(100, pct)).toFixed(2) + '%');
  }

  function renderJoints() {
    /* 联动不是关节分组：内容区换成姿态 / 动作 / 步态那三行胶囊，
       胶囊由 buildActions 建好并常驻，这里只负责换显 */
    var isLink = group === 'link';
    jointsBox.hidden = isLink;
    if (linkBox) linkBox.hidden = !isLink;
    jointsBox.textContent = '';
    sliders = {};
    if (isLink) { controls(); return; }
    var re = GROUPS[group];
    var list = joints.filter(function (j) {
      return j.controllable && j.type === 'hinge' && re.test(j.name);
    });
    list.forEach(function (joint) {
      var range = joint.range || [-3.14, 3.14];
      var wrap = document.createElement('label');
      wrap.className = 'adv__joint';
      wrap.innerHTML = '<span>' + joint.name.replace(/_joint$/, '') + '</span>';
      var input = document.createElement('input');
      input.type = 'range';
      input.min = range[0].toFixed(3);
      input.max = range[1].toFixed(3);
      input.step = '0.02';
      input.value = known(joint.name).toFixed(2);
      input.dataset.joint = joint.name;
      paintFill(input);
      wrap.appendChild(input);
      jointsBox.appendChild(wrap);
      sliders[joint.name] = input;

      input.addEventListener('pointerdown', function () { dragging[joint.name] = true; });
      input.addEventListener('pointerup', function () { dragging[joint.name] = false; });
      input.addEventListener('input', function () {
        /* 手势和步态都在持续写 target，用户一动滑块就该让位，
           否则下一帧又被覆盖回去，看起来像滑块没生效 */
        if (activeGesture || activeGait) {
          activeGesture = null;
          activeGait = null;
          markOn(gesturesBox, 'simGesture', null);
          markOn(gaitsBox, 'simGait', null);
          api('/sim/gait', 'POST', { name: 'off' }).catch(function () {});
        }
        paintFill(input);
        pending[joint.name] = parseFloat(input.value);
        schedule();
      });
    });
    if (!list.length) {
      jointsBox.textContent = '模型里没有' + ({ arm: '手臂', waist: '腰', leg: '腿' }[group]) + '关节。';
    }
    controls();
  }

  function schedule() {
    if (timer) return;
    /* 拖动时高频触发，攒一小段再发，避免把 100Hz 的桥刷爆 */
    timer = setTimeout(function () {
      timer = null;
      var batch = pending;
      pending = {};
      if (!Object.keys(batch).length) return;
      api('/control/joints', 'POST', { joints: batch, duration_ms: SEND_DEBOUNCE })
        .catch(function (e) { say('关节指令失败：' + e.message); });
    }, SEND_DEBOUNCE);
  }

  pane.querySelectorAll('[data-joint-group]').forEach(function (button) {
    button.onclick = function () {
      group = button.dataset.jointGroup;
      pane.querySelectorAll('[data-joint-group]').forEach(function (b) {
        var on = b === button;
        b.classList.toggle('is-sel', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      renderJoints();
    };
  });

  /* ---------- 姿态 / 动作 / 步态 ---------- */

  function fillChips(box, items, attr, onPick) {
    box.textContent = '';
    if (!items || !items.length) { box.setAttribute('data-empty', ''); return; }
    box.removeAttribute('data-empty');
    items.forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'adv__chip';
      button.textContent = item.label || item.id;
      button.dataset[attr] = item.id;
      button.onclick = function () { onPick(item.id, button); };
      box.appendChild(button);
    });
  }

  /* attr 用 dataset 的驼峰写法（simGait），选择器那边再转成 data-sim-gait */
  function markOn(box, attr, id) {
    var sel = '[data-' + attr.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }) + ']';
    box.querySelectorAll(sel).forEach(function (b) {
      b.classList.toggle('is-on', b.dataset[attr] === id);
    });
  }

  function buildActions(table) {
    fillChips(presetsBox, table.presets, 'simPreset', function (id) {
      activePreset = id;
      markOn(presetsBox, 'simPreset', id);
      run('/sim/preset', { name: id }, '切换姿态');
    });
    fillChips(gesturesBox, table.gestures, 'simGesture', function (id) {
      activeGesture = id;
      activeGait = null;
      markOn(gesturesBox, 'simGesture', id);
      markOn(gaitsBox, 'simGait', null);
      run('/control/gesture', { name: id }, '触发动作');
    });
    fillChips(gaitsBox, table.gaits, 'simGait', function (id) {
      var stop = activeGait === id;
      activeGait = stop ? null : id;
      activeGesture = null;
      markOn(gaitsBox, 'simGait', activeGait);
      markOn(gesturesBox, 'simGesture', null);
      run('/sim/gait', { name: stop ? 'off' : id }, stop ? '停止步态' : '开始步态');
    });
    controls();
  }

  /* ---------- 相机：拖拽转视角、滚轮缩放 ---------- */

  function pushCamera() {
    if (!cam || !connected || camTimer) return;
    camTimer = setTimeout(function () {
      camTimer = null;
      api('/sim/camera', 'POST', cam).catch(function (e) { say('视角指令失败：' + e.message); });
    }, CAM_DEBOUNCE);
  }

  function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)); }

  var dragStart = null;
  viewport.addEventListener('pointerdown', function (event) {
    if (!connected || !cam) return;
    dragStart = { x: event.clientX, y: event.clientY, az: cam.azimuth, el: cam.elevation };
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', function (event) {
    if (!dragStart) return;
    cam.azimuth = Math.round(dragStart.az - (event.clientX - dragStart.x) * 0.4 * 10) / 10;
    cam.elevation = Math.round(clamp(dragStart.el - (event.clientY - dragStart.y) * 0.3, -85, 85) * 10) / 10;
    pushCamera();
  });
  ['pointerup', 'pointercancel'].forEach(function (name) {
    viewport.addEventListener(name, function () {
      if (!dragStart) return;
      dragStart = null;
      pushCamera();
    });
  });
  viewport.addEventListener('wheel', function (event) {
    if (!connected || !cam) return;
    event.preventDefault();
    cam.distance = Math.round(clamp(cam.distance * (1 + event.deltaY * 0.0012), 0.4, 6) * 100) / 100;
    pushCamera();
  }, { passive: false });

  camResetBtn.onclick = function () {
    if (!connected) return;
    api('/sim/camera', 'POST', { reset: true }).then(function (data) {
      cam = data;
      say('视角已复位。');
    }).catch(function (e) { say('视角复位失败：' + e.message); });
  };

  /* ---------- 画面与状态 ---------- */

  /* 取画面改成「一张加载完再取下一张」：固定 120ms 的定时器会在上一张
     还没下载完时就改写 src，把请求打断、白掉一帧，看起来就是掉帧。
     现在由 load/error 驱动节拍，另留 70ms 间隙，既不叠请求也不空转 */
  var FRAME_GAP = 55;
  var frameLoading = false, frameMiss = 0;

  function scheduleFrame(delay) {
    if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
    frameTimer = setTimeout(pollFrame, delay);
  }

  function pollFrame() {
    frameTimer = null;
    if (!connected || !showFrame || !visible() || frameLoading) return;
    frameLoading = true;
    frame.src = API + '/sim/frame?t=' + Date.now();
  }

  frame.addEventListener('load', function () {
    frameLoading = false;
    frameMiss = 0;
    if (frame.dataset.offline !== undefined) delete frame.dataset.offline;
    if (connected) scheduleFrame(FRAME_GAP);
  });
  frame.addEventListener('error', function () {
    /* 取不到画面：退到 1.5s 一次重试，避免把 502 刷满；提示只说一次 */
    frameLoading = false;
    frame.dataset.offline = '';
    if (frameMiss++ === 0) {
      say('没有画面：仿真桥可能跑在窗口模式，或离屏渲染不可用；数值与滑块仍可正常驱动。');
    }
    if (connected) scheduleFrame(1500);
  });

  /* 弹窗收起时取帧暂停，重新打开要能自己接上：监听 hidden 变化补一脚 */
  if (window.MutationObserver) {
    new MutationObserver(function () {
      if (!pane.hidden && connected) scheduleFrame(0);
    }).observe(pane, { attributes: true, attributeFilter: ['hidden'] });
  }

  shotBtn.onclick = function () {
    if (!connected) return;
    var link = document.createElement('a');
    link.href = API + '/sim/frame?t=' + Date.now();
    link.download = 'q1-sim-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jpg';
    document.body.appendChild(link);
    link.click();
    link.remove();
    say('已请求保存当前画面。');
  };

  /* ---------- 参数显示：左列，一行一项 ---------- */

  /* 行只建一次，之后只改右值文本，免得每 500ms 重建整块把滚动位置也抖掉 */
  var STATS = [
    ['t', '运行'], ['mode', '模式'], ['step', '步数'], ['contacts', '触点'],
    ['speed', '速度'], ['gesture', '动作'], ['gait', '步态'],
    ['bx', 'base x'], ['by', 'base y'], ['bz', 'base z'], ['dz', '机身'],
    ['cam', '视角'], ['stale', '延迟']
  ];
  var statVals = {};

  function buildStats() {
    if (!readout || readout.childElementCount) return;
    STATS.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'adv__stat';
      var key = document.createElement('span');
      key.textContent = item[1];
      var val = document.createElement('b');
      val.textContent = '-';
      row.appendChild(key);
      row.appendChild(val);
      readout.appendChild(row);
      statVals[item[0]] = val;
    });
  }

  function num(value, digits) {
    return typeof value === 'number' ? value.toFixed(digits) : '-';
  }

  function paintStats(state) {
    buildStats();
    var base = state.base || null;
    var camInfo = state.camera || null;
    var table = {
      t: num(state.t, 2) + ' s',
      mode: state.mode === 'dynamic' ? '动力学' : '运动学',
      step: String(state.step),
      contacts: String(state.contact_count),
      speed: num(state.speed, 1) + ' x',
      gesture: state.gesture || '-',
      gait: state.gait || '-',
      bx: base ? num(base.x, 3) : '-',
      by: base ? num(base.y, 3) : '-',
      bz: base ? num(base.z, 3) : '-',
      dz: num(state.base_dz || 0, 3),
      cam: camInfo ? camInfo.azimuth + '° / ' + camInfo.elevation + '°' : '无相机',
      stale: num(state.stale, 1) + ' s'
    };
    Object.keys(table).forEach(function (key) {
      var el = statVals[key];
      if (el && el.textContent !== table[key]) el.textContent = table[key];
    });
  }

  async function pollState() {
    if (!connected) return;
    try {
      var state = await api('/sim/state');
      lastState = state;
      dynamic = state.mode === 'dynamic';
      modeBtn.textContent = dynamic ? '切到运动学' : '切到动力学';
      if (state.camera) cam = state.camera;
      Object.keys(sliders).forEach(function (name) {
        if (dragging[name] || !(name in state.joints)) return;
        sliders[name].value = state.joints[name];
        paintFill(sliders[name]);
      });
      paintStats(state);
    } catch (e) {
      say('仿真状态读取失败：' + e.message);
    }
  }

  /* ---------- 连接 ---------- */

  async function connect() {
    if (busy || connected) return;
    busy = true; controls();
    var step = '连接';
    try {
      await api('/connections', 'POST', { robot_id: 'q1-sim', mode: 'sim' });
      step = '读取关节表';
      var table = await api('/sim/joints');
      joints = table.joints;
      cam = table.camera || null;
      connected = true;
      renderJoints();
      buildActions(table);
      say('已连接 q1-sim（nq=' + table.nq + '，关节 ' + table.joints.length + ' 个）。' +
          '右侧切手臂/腰/腿/联动，画面可拖动旋转，键盘 WASD 走路。');
      pollState();
      pollFrame();
      stateTimer = setInterval(pollState, 500);
      if (connectBtn) connectBtn.textContent = '已连接';
      hudState('仿真已连接');
    } catch (e) {
      if (connectBtn) connectBtn.textContent = '连接仿真';
      hudState('未连接');
      say(step + '失败：' + e.message + '。仿真桥没起的话先在终端看 8090 是否在监听');
    } finally { busy = false; controls(); }
  }

  async function run(path, body, label) {
    if (busy) return;
    busy = true; controls();
    try {
      await api(path, 'POST', body || {});
      say(label + ' 已下发');
      await pollState();
    } catch (e) { say(label + ' 失败：' + e.message); }
    finally { busy = false; controls(); }
  }

  if (connectBtn) connectBtn.onclick = connect;
  rail.querySelector('[data-sim-reset]').onclick = function () {
    activeGesture = activeGait = activePreset = null;
    markOn(gaitsBox, 'simGait', null);
    markOn(gesturesBox, 'simGesture', null);
    markOn(presetsBox, 'simPreset', null);
    run('/sim/reset', {}, '重置');
  };
  rail.querySelector('[data-sim-stop]').onclick = function () { run('/motion/stop', {}, '急停'); };
  rail.querySelector('[data-sim-mode]').onclick = function () {
    run('/sim/mode', { mode: dynamic ? 'kinematic' : 'dynamic' }, dynamic ? '切运动学' : '切动力学');
    setTimeout(pollState, 300);
  };

  speedInput.addEventListener('input', function () {
    speedVal.textContent = parseFloat(speedInput.value).toFixed(1) + 'x';
    paintFill(speedInput);
  });
  paintFill(speedInput);
  speedInput.addEventListener('change', function () {
    if (!connected) return;
    api('/sim/speed', 'POST', { speed: parseFloat(speedInput.value) })
      .catch(function (e) { say('速度设置失败：' + e.message); });
  });

  /* ---------- 底盘（页面上九宫格方向键 + 面板里左右转 + 键盘） ---------- */

  var DIRS = {
    'up': [0.3, 0, 0], 'down': [-0.3, 0, 0], 'left': [0, 0.3, 0], 'right': [0, -0.3, 0],
    'up-left': [0.3, 0.3, 0], 'up-right': [0.3, -0.3, 0],
    'down-left': [-0.3, 0.3, 0], 'down-right': [-0.3, -0.3, 0]
  };
  var holdTimer = null;

  /* 按住期间每 100ms 续一次；桥那边 0.5s 收不到指令就自动清零，
     所以浏览器崩溃或断网时机器人不会一直走 */
  function startHold(vec) {
    if (!connected || dynamic) return;
    stopHold();
    var send = function () {
      api('/motion/base', 'POST', { vx: vec[0], vy: vec[1], wz: vec[2] })
        .catch(function (e) { say('底盘指令失败：' + e.message); stopHold(); });
    };
    send();
    holdTimer = setInterval(send, 100);
  }

  function stopHold() {
    if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
    if (connected) api('/motion/stop', 'POST', {}).catch(function () {});
  }

  document.querySelectorAll('.dock__btn[data-dir]').forEach(function (button) {
    var vec = DIRS[button.dataset.dir];
    button.addEventListener('pointerdown', function () { startHold(vec); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (event) {
      button.addEventListener(event, stopHold);
    });
  });

  rail.querySelectorAll('[data-sim-turn]').forEach(function (button) {
    var wz = parseFloat(button.dataset.simTurn);
    button.addEventListener('pointerdown', function (event) {
      event.preventDefault();
      startHold([0, 0, wz]);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (event) {
      button.addEventListener(event, stopHold);
    });
  });

  /* 键盘：WASD 平移、Q/E 转向、方向键同九宫格、空格急停。
     焦点在滑块或输入框里时让位，免得拖滑块也触发走路。 */
  var KEYS = {
    KeyW: [0.3, 0, 0], KeyS: [-0.3, 0, 0], KeyA: [0, 0.3, 0], KeyD: [0, -0.3, 0],
    KeyQ: [0, 0, -0.8], KeyE: [0, 0, 0.8],
    ArrowUp: [0.3, 0, 0], ArrowDown: [-0.3, 0, 0], ArrowLeft: [0, 0.3, 0], ArrowRight: [0, -0.3, 0]
  };
  var held = {};
  document.addEventListener('keydown', function (event) {
    if (!connected || pane.hidden) return;
    var tag = (event.target && event.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (event.code === 'Space') { event.preventDefault(); stopHold(); return; }
    var vec = KEYS[event.code];
    if (!vec || held[event.code]) return;
    event.preventDefault();
    held[event.code] = true;
    startHold(vec);
  });
  document.addEventListener('keyup', function (event) {
    if (!held[event.code]) return;
    delete held[event.code];
    stopHold();
  });

  window.addEventListener('blur', function () { held = {}; stopHold(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') stopHold(); });

  /* HUD 那个连接状态原先由 js/integration.js 轮询 /status 统一写，那套 mock 联调
     已经停用，这里接手同一块文本：只写状态，电量与信号保持页面里的占位值 */
  var hudStateEl = document.querySelector('.hud__state--ready, [data-api-state]');
  function hudState(text) { if (hudStateEl) hudStateEl.textContent = text; }

  hudState('未连接');
  buildStats();
  controls();
})();
