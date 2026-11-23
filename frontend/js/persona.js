/* AI 角色预设：内置角色负责快速开始，自定义角色与当前选择保存在浏览器本地。
   角色设定只影响表达方式；动作白名单和 JSON 输出约束仍由本地 AI 服务控制。 */
(function () {
  'use strict';

  var panel = document.querySelector('[data-persona-view]');
  if (!panel) return;

  var list = panel.querySelector('[data-persona-list]');
  var form = panel.querySelector('[data-persona-form]');
  var status = panel.querySelector('[data-persona-status]');
  var newButton = panel.querySelector('[data-persona-new]');
  var resetButton = panel.querySelector('[data-persona-reset]');
  var nameInput = form.querySelector('[data-persona-name]');
  var styleInput = form.querySelector('[data-persona-style]');
  var colorInput = form.querySelector('[data-persona-color]');
  var initialsInput = form.querySelector('[data-persona-initials]');
  var promptInput = form.querySelector('[data-persona-prompt]');
  var note = panel.querySelector('[data-persona-note]');
  var PREFS_KEY = 'primebotx:personas';
  var ACTIVE_KEY = 'primebotx:persona';

  var DEFAULTS = [
    {
      id: 'builtin:companion',
      name: 'PrimebotX',
      nameZh: 'PrimebotX',
      style: 'Warm and thoughtful',
      styleZh: '温柔知性',
      color: '#91d2c3',
      initials: 'IB',
      prompt: '你是一位温柔知性的陪伴者。先理解用户的情绪和处境，再给出清晰、可执行的建议。语气自然亲切，不评判用户，也不使用居高临下的表达；普通问候保持简洁，需要解释时再逐步展开。'
    },
    {
      id: 'builtin:mentor',
      name: 'Study Partner',
      nameZh: '学习搭档',
      style: 'Patient and structured',
      styleZh: '耐心清晰',
      color: '#6d8fc9',
      initials: '学',
      prompt: '你是一位耐心的学习搭档。先判断用户卡在哪一步，再用生活化类比和分步骤讲解帮助理解。避免一次堆太多信息，每轮优先解决一个小问题，并在结尾给出一个可马上练习或思考的小步骤。'
    },
    {
      id: 'builtin:creative',
      name: 'Idea Director',
      nameZh: '灵感导演',
      style: 'Curious and imaginative',
      styleZh: '好奇心与想象力',
      color: '#c86482',
      initials: '想',
      prompt: '你是一位富有想象力的创意搭档。回答时先抓住用户真正想表达的核心，再从不同角度提供新鲜但可落地的想法。可以大胆联想，但要明确区分灵感、假设和事实，并主动指出下一步最容易验证的方向。'
    },
    {
      id: 'builtin:advisor',
      name: 'Calm Advisor',
      nameZh: '冷静顾问',
      style: 'Concise and evidence-led',
      styleZh: '简洁理性',
      color: '#6e9182',
      initials: '析',
      prompt: '你是一位冷静、务实的顾问。优先给出结论，再说明关键依据、风险和取舍。信息不足时明确指出假设，不为了显得确定而编造事实。语言简洁，但不要冷淡，重要建议要能直接执行。'
    }
  ];

  function lang() {
    return typeof window.getLang === 'function' && window.getLang() === 'zh' ? 'zh' : 'en';
  }

  /* 取词条；t() 拿不到时会原样返回 key，这里换成一句兜底英文 */
  function L(key, fallback) {
    if (typeof t !== 'function') return fallback;
    var text = t(key);
    return text === key ? fallback : text;
  }

  function displayName(persona) {
    return lang() === 'zh' ? (persona.nameZh || persona.name) : (persona.name || persona.nameZh);
  }

  function displayStyle(persona) {
    return lang() === 'zh' ? (persona.styleZh || persona.style) : (persona.style || persona.styleZh);
  }

  function readCustom() {
    try {
      var value = JSON.parse(localStorage.getItem(PREFS_KEY) || '[]');
      if (!Array.isArray(value)) return [];
      return value.filter(function (item) {
        return item && typeof item.id === 'string' && item.id.indexOf('custom:') === 0 &&
          typeof item.name === 'string' && typeof item.prompt === 'string';
      }).slice(0, 24);
    } catch (_error) {
      return [];
    }
  }

  function saveCustom() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(custom)); } catch (_error) {}
  }

  function readActiveId() {
    try { return localStorage.getItem(ACTIVE_KEY) || DEFAULTS[0].id; }
    catch (_error) { return DEFAULTS[0].id; }
  }

  function saveActiveId(id) {
    try { localStorage.setItem(ACTIVE_KEY, id); } catch (_error) {}
  }

  function all() { return DEFAULTS.concat(custom); }

  function byId(id) {
    return all().find(function (item) { return item.id === id; }) || null;
  }

  var custom = readCustom();
  var selectedId = readActiveId();
  if (!byId(selectedId)) selectedId = DEFAULTS[0].id;
  var editing = byId(selectedId);
  var editingCustom = !!(editing && editing.id.indexOf('custom:') === 0);

  function setNote(text, error) {
    note.textContent = text;
    note.classList.toggle('is-error', !!error);
  }

  /* 角色设定这一格随内容长高：先把高度放回 auto 量出内容，
     再夹在单行（42）与八行之间，超出的部分交给纵向滚动。
     行高 14 × 1.5 = 21，上下内边距 10+10，八行即 8×21+20 = 188 */
  var PROMPT_MIN_H = 42;
  var PROMPT_MAX_H = 188;

  function layoutPrompt() {
    /* 面板被切走时是 display:none，这一格量不出内容高度，
       写回去就成了单行 —— 等它重新出现在视口里再算 */
    if (!promptInput.offsetParent) return;
    promptInput.style.height = 'auto';
    var content = promptInput.scrollHeight;
    promptInput.style.height = Math.min(Math.max(content, PROMPT_MIN_H), PROMPT_MAX_H) + 'px';
    promptInput.style.overflowY = content > PROMPT_MAX_H + 1 ? 'auto' : 'hidden';
  }

  function fillForm(persona) {
    editing = persona;
    editingCustom = persona.id.indexOf('custom:') === 0;
    nameInput.value = persona.name || '';
    styleInput.value = persona.style || '';
    colorInput.value = /^#[0-9a-f]{6}$/i.test(persona.color || '') ? persona.color : '#91d2c3';
    initialsInput.value = (persona.initials || '').slice(0, 3);
    promptInput.value = persona.prompt || '';
    status.textContent = editingCustom
      ? (typeof t === 'function' ? t('persona.custom') : '自定义角色')
      : (typeof t === 'function' ? t('persona.builtin') : '内置预设');
    layoutPrompt();
  }

  /* 卡片右侧的删除确认：点第一下只 arm，3 秒内不再点就自动收回。
     时长与账号面板的退出确认一致（auth.js 里的 LOGOUT_HOLD），
     两个动作都是不可逆的，误触的代价一样大 */
  var REMOVE_HOLD = 3000;
  var armedRemove = null;
  var removeTimer = 0;

  function disarmRemove() {
    if (removeTimer) { clearTimeout(removeTimer); removeTimer = 0; }
    if (!armedRemove) return;
    armedRemove.classList.remove('is-armed');
    armedRemove.setAttribute('aria-label', L('persona.delete', 'Delete'));
    armedRemove = null;
  }

  function buildRemove(persona) {
    var node = document.createElement('span');
    node.className = 'persona-card__remove';
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-label', L('persona.delete', 'Delete'));
    node.innerHTML =
      '<svg class="persona-card__remove-x" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M7 7l10 10M17 7 7 17"/></svg>' +
      '<span class="persona-card__remove-text"></span>';
    node.querySelector('.persona-card__remove-text').textContent =
      L('persona.deleteConfirm', 'Confirm');

    node.addEventListener('click', function (event) {
      /* 卡片本身是一枚 button，这一下不能顺带把角色切走 */
      event.preventDefault();
      event.stopPropagation();
      if (armedRemove !== node) {
        disarmRemove();
        armedRemove = node;
        node.classList.add('is-armed');
        node.setAttribute('aria-label',
          L('persona.deleteConfirm', 'Confirm') + ' ' + displayName(persona));
        removeTimer = setTimeout(disarmRemove, REMOVE_HOLD);
        return;
      }
      disarmRemove();
      removeCustom(persona.id);
    });
    node.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      node.click();
    });
    return node;
  }

  function removeCustom(id) {
    var index = custom.findIndex(function (item) { return item.id === id; });
    if (index < 0) return;
    custom = custom.slice();
    custom.splice(index, 1);
    saveCustom();
    if (selectedId === id) {
      selectedId = DEFAULTS[0].id;
      saveActiveId(selectedId);
      paintActive();
      emitChange();
    } else {
      /* 删的不是当前选中的那只：只重画列表，别把表单里正在编辑的内容冲掉 */
      paintList();
    }
    setNote(L('persona.deleted', 'Custom persona deleted.'));
  }

  function paintList() {
    disarmRemove();
    list.replaceChildren();
    all().forEach(function (persona) {
      var removable = persona.id.indexOf('custom:') === 0;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'persona-card';
      button.dataset.personaId = persona.id;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(persona.id === selectedId));
      button.style.setProperty('--persona-color', persona.color || '#91d2c3');
      button.classList.toggle('is-on', persona.id === selectedId);
      button.classList.toggle('is-custom', removable);
      /* 删除钮只在自定义卡上有，类名挂在卡上是为了让文字让位只发生在这种卡上 */
      button.classList.toggle('is-removable', removable);

      var avatar = document.createElement('span');
      avatar.className = 'persona-card__avatar';
      avatar.textContent = (persona.initials || displayName(persona).slice(0, 2) || 'AI').slice(0, 3);
      var copy = document.createElement('span');
      copy.className = 'persona-card__copy';
      var name = document.createElement('strong');
      name.textContent = displayName(persona);
      var style = document.createElement('span');
      style.textContent = displayStyle(persona);
      copy.append(name, style);
      button.append(avatar, copy);
      if (removable) button.appendChild(buildRemove(persona));
      button.addEventListener('click', function () {
        select(persona.id);
      });
      list.appendChild(button);
    });
    /* 卡片是这一轮才建出来的，磁吸脚本启动时扫不到：补收一次，
       光标正好停在原处时也会按新元素重新瞄一遍 */
    if (typeof window.magnetRescan === 'function') window.magnetRescan();
  }

  function paintActive() {
    var active = byId(selectedId) || DEFAULTS[0];
    document.querySelectorAll('[data-chat-persona]').forEach(function (node) {
      node.textContent = displayName(active);
      node.style.setProperty('--persona-color', active.color || '#91d2c3');
    });
    /* 聊天页左上角那枚头像：与 persona 卡片同一套标记 —— 底色取角色的
       标记色，字取缩写；没填缩写就退回名字前两位 */
    var mark = (active.initials || displayName(active).slice(0, 2) || 'AI').slice(0, 3);
    document.querySelectorAll('[data-chat-avatar]').forEach(function (node) {
      node.textContent = mark;
      node.style.setProperty('--persona-color', active.color || '#91d2c3');
    });
    fillForm(active);
    paintList();
  }

  function emitChange() {
    var active = byId(selectedId) || DEFAULTS[0];
    document.dispatchEvent(new CustomEvent('persona-change', {
      detail: {
        id: active.id,
        name: displayName(active),
        style: displayStyle(active),
        color: active.color || '#91d2c3',
        prompt: active.prompt || ''
      }
    }));
  }

  function select(id) {
    if (!byId(id)) return;
    selectedId = id;
    saveActiveId(id);
    paintActive();
    setNote(typeof t === 'function' ? t('persona.useNote') : '已切换，下一条消息会使用这个角色。');
    emitChange();
  }

  function previewFromInputs() {
    fillForm({
      id: editing.id,
      name: nameInput.value,
      style: styleInput.value,
      color: colorInput.value,
      initials: initialsInput.value,
      prompt: promptInput.value
    });
  }

  form.addEventListener('input', function (event) {
    if (event.target === nameInput || event.target === styleInput ||
        event.target === colorInput || event.target === initialsInput ||
        event.target === promptInput) {
      previewFromInputs();
      setNote('');
    }
  });

  /* 敲字这一路不用单独绑：form 的 input 事件会走 previewFromInputs →
     fillForm，末尾已经算过一次高度。这里只管窗口尺寸变化 */
  window.addEventListener('resize', layoutPrompt);
  /* 视图切回 persona、或栏从收起状态展开时，这一格重新进入视口再补算一次。
     用 IntersectionObserver 而不是 ResizeObserver：后者会被我们自己写入的
     高度反过来触发，量一次改一次来回打转 */
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) layoutPrompt();
      });
    }).observe(promptInput);
  }

  /* 丢掉未保存的改动，回到当前选中角色已存下的样子。
     新建态下 selectedId 仍是上一个选中的角色，所以按一下也顺便退出新建 */
  if (resetButton) {
    resetButton.addEventListener('click', function () {
      fillForm(byId(selectedId) || DEFAULTS[0]);
      setNote(L('persona.resetNote', 'Reverted to the saved version of this persona.'));
    });
  }

  newButton.addEventListener('click', function () {
    editingCustom = true;
    fillForm({
      id: 'custom:' + Date.now(),
      name: '',
      style: '',
      color: '#91d2c3',
      initials: '',
      prompt: ''
    });
    setNote(typeof t === 'function' ? t('persona.newNote') : '填写角色设定后保存，就会出现在这里的角色列表中。');
    nameInput.focus();
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var name = nameInput.value.trim();
    var prompt = promptInput.value.trim();
    if (!name || !prompt) {
      setNote(typeof t === 'function' ? t('persona.required') : '角色名称和角色设定不能为空。', true);
      (!name ? nameInput : promptInput).focus();
      return;
    }

    var id = editing.id;
    if (id.indexOf('custom:') !== 0) id = 'custom:' + Date.now();
    var record = {
      id: id,
      name: name,
      style: styleInput.value.trim() || 'Custom style',
      color: colorInput.value || '#91d2c3',
      initials: (initialsInput.value.trim() || name.slice(0, 2)).slice(0, 3),
      prompt: prompt
    };
    var existing = custom.findIndex(function (item) { return item.id === id; });
    if (existing >= 0) custom[existing] = record;
    else custom.unshift(record);
    custom = custom.slice(0, 24);
    selectedId = id;
    saveCustom();
    saveActiveId(id);
    paintActive();
    setNote(typeof t === 'function' ? t('persona.saved') : '角色已保存在本机，并设为当前角色。');
    emitChange();
  });

  document.addEventListener('langchange', function () {
    paintActive();
  });

  window.primebotxPersona = {
    get active() {
      var active = byId(selectedId) || DEFAULTS[0];
      return {
        id: active.id,
        name: displayName(active),
        style: displayStyle(active),
        color: active.color || '#91d2c3',
        prompt: active.prompt || ''
      };
    },
    select: select
  };

  paintActive();
  emitChange();
})();
