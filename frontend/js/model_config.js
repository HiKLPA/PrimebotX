(function () {
  'use strict';

  var panel = document.querySelector('[data-model-panel]');
  var form = document.querySelector('[data-model-form]');
  var trigger = document.querySelector('[data-model-trigger]');
  var wrap = document.querySelector('[data-model-switch]');
  var label = document.querySelector('[data-model-label]');
  var effort = document.querySelector('[data-model-effort]');
  var menu = document.querySelector('[data-model-menu]');
  var menuList = document.querySelector('[data-model-menu-list]');
  if (!panel || !form || !trigger || !wrap || !label || !effort || !menu || !menuList) return;

  var formatInput = form.querySelector('[data-model-format]');
  var baseInput = form.querySelector('[data-model-base-url]');
  var modelInput = form.querySelector('[data-model-name]');
  var keyInput = form.querySelector('[data-model-key]');
  var statusNode = panel.querySelector('[data-model-status]');
  var note = panel.querySelector('[data-model-note]');
  var saveButton = form.querySelector('[data-model-save]');
  var fetchButton = form.querySelector('[data-model-fetch]');
  var options = document.querySelector('#model-name-options');
  if (!formatInput || !baseInput || !modelInput || !keyInput || !statusNode ||
      !note || !saveButton || !fetchButton || !options) return;
  var presetButtons = Array.prototype.slice.call(form.querySelectorAll('[data-model-preset]'));
  var queryApi = new URLSearchParams(location.search).get('api');
  var API = queryApi ? queryApi.replace(/\/+$/, '') : '/api/v1';
  var HISTORY_KEY = 'primebotx.modelHistory';
  var inventories = Object.create(null);
  var busy = false;
  var loaded = false;
  var loadError = '';
  statusNode.removeAttribute('data-i18n');
  var LEGACY_MODELS = {
    'deepseek-chat': 'deepseek-flash',
    'deepseek-reasoner': 'deepseek-v4-pro',
  };

  var PRESETS = {
    deepseek: {
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-flash', 'deepseek-v4-pro'],
    },
    /* 智谱的 Flash 档长期免费，且国内可直连：老配置里的 provider=zhipu
       靠这条留在 PRESETS 里，才不会被 normalizeProvider 降级成自定义 */
    zhipu: {
      label: '智谱 GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: ['glm-4-flash', 'glm-4.7-flash'],
    },
    custom: {
      label: 'OpenAI Compatible',
      baseUrl: '',
      models: [],
    },
  };

  var current = {
    provider: 'deepseek',
    base_url: PRESETS.deepseek.baseUrl,
    model: 'deepseek-flash',
    api_format: 'openai',
    configured: false,
    key_hint: '',
  };

  function t(key, fallback) {
    return typeof window.t === 'function' ? window.t(key) : fallback;
  }

  function formatLabel(format) {
    return format === 'anthropic'
      ? t('model.format.anthropic', 'Anthropic')
      : t('model.format.openai', 'OpenAI');
  }

  function normalizeProvider(provider) {
    return provider === 'openai' ? 'custom' : (PRESETS[provider] ? provider : 'custom');
  }

  function normalizeFormat(format) {
    return format === 'anthropic' ? 'anthropic' : 'openai';
  }

  function normalizeModel(provider, model) {
    return provider === 'deepseek' && LEGACY_MODELS[model] ? LEGACY_MODELS[model] : model;
  }

  function modelLabel(model) {
    if (model === 'deepseek-flash') return 'DeepSeek Flash';
    if (model === 'deepseek-v4-pro') return 'DeepSeek V4 Pro';
    if (model === 'glm-4-flash') return 'GLM-4-Flash';
    if (model === 'glm-4.7-flash') return 'GLM-4.7 Flash';
    return model;
  }

  function readHistory() {
    try {
      var value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (_error) {
      return {};
    }
  }

  function rememberModel(provider, model) {
    if (!provider || !model) return;
    var history = readHistory();
    var list = Array.isArray(history[provider]) ? history[provider] : [];
    if (!list.includes(model)) list.unshift(model);
    history[provider] = list.slice(0, 8);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (_error) {}
  }

  function modelsFor(provider) {
    var preset = PRESETS[provider] || PRESETS.custom;
    var history = readHistory()[provider];
    var values = preset.models.slice();
    var inventory = Array.isArray(inventories[provider]) ? inventories[provider] : [];
    inventory.forEach(function (model) {
      if (typeof model === 'string' && model && !values.includes(model)) values.push(model);
    });
    if (Array.isArray(history)) {
      history.forEach(function (model) {
        model = normalizeModel(provider, model);
        if (typeof model === 'string' && !values.includes(model)) values.push(model);
      });
    }
    if (current.provider === provider && current.model && !values.includes(current.model)) {
      values.unshift(current.model);
    }
    return values;
  }

  function setStatus(kind, text) {
    statusNode.className = 'model-view__status ' + (kind ? 'is-' + kind : '');
    statusNode.textContent = text;
  }

  /* 说明行只用来报「保存成功 / 具体错误」：没有话要说就清空，
     空元素由 css/rail.css 的 :empty 收掉，所以这里不再有常驻的默认文案 */
  function setNote(text, error) {
    if (!note) return;
    note.textContent = text || '';
    note.classList.toggle('is-error', !!error && !!text);
  }

  function renderDatalist(provider) {
    options.replaceChildren();
    modelsFor(provider).forEach(function (model) {
      var option = document.createElement('option');
      option.value = model;
      options.appendChild(option);
    });
  }

  function paintPreset(provider, baseUrl, model) {
    presetButtons.forEach(function (button) {
      var on = button.dataset.provider === provider &&
        button.dataset.baseUrl === baseUrl &&
        button.dataset.prefillModel === model;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function renderMenu() {
    menuList.replaceChildren();
    /* 当前模型不列进表里：它固定是面板底部那条胶囊本身，上面只放能换过去的候选。
       整个 provider 只有一个可选时（没配过、也没取到列表），退回把当前这条列出来，
       否则点开是一块空板 */
    var models = modelsFor(current.provider).filter(function (model) {
      return model !== current.model;
    });
    if (!models.length) models = [current.model || ''].filter(Boolean);
    models.forEach(function (model) {
      var item = document.createElement('button');
      item.type = 'button';
      /* 直接就是顶栏 / 账号面板那枚 .pill：底片、字色、hover 位移与按压全跟着
         全站那一套走，这里只补行高与内边距（见 chat.css 的 .model-menu .pill） */
      item.className = 'pill';
      item.dataset.modelChoice = model;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(model === current.model));
      if (model === current.model) item.classList.add('is-on');

      var name = document.createElement('span');
      name.className = 'pill__label';
      name.textContent = modelLabel(model);

      item.setAttribute('aria-label', model);
      item.append(name);
      item.insertAdjacentHTML('beforeend',
        '<svg class="pill__arrow" viewBox="0 0 32 32" aria-hidden="true"><path d="M23.78,16.54c.3-.3.3-.79,0-1.09l-4.35-4.35c-.3-.3-.79-.79-1.09-1.09l-4.35-4.35c-.3-.3-.89-.54-1.31-.54h-3.9c-.42,0-.77.35-.77.77v3.9c0,.42,.24,1.01,.54,1.31l4.35,4.35c.3,.3,.3,.79,0,1.09l-4.35,4.35c-.3,.3-.54,.89-.54,1.31v3.9c0,.42,.35,.77,.77,.77h3.9c.42,0,1.01-.24,1.31-.54l4.35-4.35c.3-.3,.79-.79,1.09-1.09l4.35-4.35Z"/></svg>');
      menuList.appendChild(item);
    });
  }

  function paint(config) {
    loaded = true;
    loadError = '';
    var provider = normalizeProvider(config.provider || 'custom');
    current = {
      provider: provider,
      base_url: config.base_url || '',
      model: normalizeModel(provider, config.model || ''),
      api_format: normalizeFormat(config.api_format),
      configured: !!config.configured,
      key_hint: config.key_hint || '',
    };
    formatInput.value = current.api_format;
    baseInput.value = current.base_url;
    modelInput.value = current.model;
    keyInput.value = '';
    keyInput.placeholder = current.configured
      ? (current.key_hint || '••••••••') + ' · ' + t('model.key.optional', 'Leave blank to keep')
      : 'sk-…';
    renderDatalist(current.provider);
    renderMenu();
    label.textContent = modelLabel(current.model) || t('model.choose', '选择模型');
    /* 右侧那枚小字只说推理强度（model.effort.high，高 / High），不再借它显示
       配置状态 —— 那是另一回事，顶栏的状态胶囊与 Key 输入框的提示各说一遍就够了。
       文案挂回 data-i18n，切语言时 i18n 直接改这一格 */
    effort.hidden = false;
    effort.setAttribute('data-i18n', 'model.effort.high');
    effort.textContent = t('model.effort.high', '高');
    /* 模型胶囊只挂 aria-label：原生 title 悬停会弹黑底小框，输入框尾部不要这个 */
    trigger.removeAttribute('title');
    trigger.setAttribute('aria-label', formatLabel(current.api_format) + ' · ' + current.model +
      ' · ' + (current.configured
        ? t('model.status.configured', '已配置')
        : t('model.status.unconfigured', '未配置')));
    wrap.classList.toggle('is-ready', current.configured);
    paintPreset(current.provider, current.base_url, current.model);
    setStatus(
      current.configured ? 'ready' : 'idle',
      current.configured ? t('model.status.ready', '已连接') : t('model.status.unconfigured', '未配置')
    );
    document.dispatchEvent(new CustomEvent('ai-model-change', { detail: current }));
  }

  async function request(method, body, path) {
    var response = await fetch(API + (path || '/ai/config'), {
      method: method,
      headers: body ? {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    var payload = null;
    try { payload = await response.json(); } catch (_error) {}
    if (!response.ok || (payload && payload.error)) {
      if (response.status === 404 && (!path || path === '/ai/config' || path === '/ai/models')) {
        throw new Error(t(
          'model.backend.outdated',
          '当前后端版本不支持模型设置，请重新构建并启动项目。'
        ));
      }
      throw new Error(payload && payload.error && payload.error.message
        ? payload.error.message
        : t('model.request.failed', '模型配置请求失败'));
    }
    return payload && payload.data ? payload.data : payload;
  }

  async function load() {
    setStatus('loading', t('model.status.loading', '正在读取'));
    try {
      paint(await request('GET'));
      setNote('');
    } catch (error) {
      loadError = error.message;
      label.textContent = t('model.status.offline', '服务未启动');
      trigger.removeAttribute('title');
      trigger.setAttribute('aria-label', error.message);
      setStatus('error', t('model.status.offline', '服务未启动'));
      setNote(error.message, true);
    }
  }

  async function save(patch, successText) {
    if (busy) return false;
    busy = true;
    trigger.disabled = true;
    trigger.setAttribute('aria-busy', 'true');
    label.textContent = t('model.status.saving', '正在应用');
    saveButton.disabled = true;
    setStatus('loading', t('model.status.saving', '正在应用'));
    try {
      var data = await request('PUT', patch);
      paint(data);
      rememberModel(data.provider, data.model);
      setNote(successText || t('model.saved', '模型配置已同步到对话'));
      return true;
    } catch (error) {
      paint(current);
      effort.hidden = false;
      /* 失败时临时把这格让给提示，data-i18n 摘掉，切语言不会把它冲回「高」 */
      effort.removeAttribute('data-i18n');
      effort.textContent = t('model.status.error', '保存失败');
      trigger.removeAttribute('title');
      trigger.setAttribute('aria-label', error.message);
      setStatus('error', t('model.status.error', '保存失败'));
      setNote(error.message, true);
      // Keep the menu open so a failed switch is visible next to the composer.
      openMenu();
      return false;
    } finally {
      busy = false;
      trigger.disabled = false;
      trigger.removeAttribute('aria-busy');
      saveButton.disabled = false;
    }
  }

  async function fetchModels() {
    if (busy) return;
    busy = true;
    fetchButton.disabled = true;
    setStatus('loading', t('model.fetch.loading', '正在获取模型'));
    try {
      var draft = {
        provider: current.provider,
        api_format: formatInput.value,
        base_url: baseInput.value.trim(),
      };
      if (keyInput.value.trim()) draft.api_key = keyInput.value.trim();
      var data = await request('POST', draft, '/ai/models');
      var models = Array.isArray(data.models) ? data.models.filter(function (item) {
        return typeof item === 'string' && item.trim();
      }) : [];
      inventories[current.provider] = models;
      renderDatalist(current.provider);
      renderMenu();
      if (models.length && !models.includes(modelInput.value.trim())) {
        modelInput.value = models[0];
      }
      setStatus('idle', t('model.fetch.available', '可选模型'));
      setNote(models.length
        ? t('model.fetch.ok', '模型列表已更新') + ' · ' + models.length
        : t('model.fetch.empty', '接口没有返回可用模型'));
    } catch (error) {
      setStatus('error', t('model.status.error', '获取失败'));
      setNote(error.message || t('model.fetch.failed', '获取模型列表失败'), true);
    } finally {
      busy = false;
      fetchButton.disabled = false;
    }
  }

  /* 胶囊长成面板：底板高度 = 胶囊 38 + 待选列表的高度，量完写到 --model-h 上，
     由 css 的 height 过渡从 38 走到这个值。列表在展开前是透明的但已经排版，
     没展开也能量到真实尺寸；量不到时 css 那边回落到 38 */
  function measureMenu() {
    /* 展开后的面板高 = 底行（当前模型 40 高 + 离底 4）+ 列表整块 */
    wrap.style.setProperty('--model-h', (44 + menu.offsetHeight) + 'px');
  }

  var closeTimer = 0;

  function closeMenu() {
    wrap.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    clearTimeout(closeTimer);
    /* 等底板缩回胶囊再收尾：列表 display:none，外层那格宽度也放开 */
    closeTimer = setTimeout(function () {
      menu.hidden = true;
      wrap.style.width = '';
    }, 320);
  }

  function openMenu() {
    renderMenu();
    clearTimeout(closeTimer);
    menu.hidden = false;
    /* 展开后那枚钮改成绝对定位（要横跨整块面板），外层就先按胶囊的原宽度钉住，
       否则这一格会塌成 0，底板与列表的 100% 也就没了参照 */
    wrap.style.width = wrap.offsetWidth + 'px';
    measureMenu();
    /* 先把「胶囊态」的 32 刷成当前计算值，再加类，height 才有起点可过渡 */
    void wrap.offsetWidth;
    wrap.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
  }

  presetButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      var provider = button.dataset.provider || 'custom';
      current.provider = provider;
      current.api_format = normalizeFormat(button.dataset.apiFormat);
      formatInput.value = current.api_format;
      baseInput.value = button.dataset.baseUrl || '';
      modelInput.value = button.dataset.prefillModel || '';
      renderDatalist(provider);
      paintPreset(provider, baseInput.value, modelInput.value);
      /* 顶部那枚状态胶囊只说服务端真实状态（已连接 / 未配置 / 服务未启动），
         点预设不再把它改成「待保存」—— 需要提醒的话由下面这行说明承担 */
      setNote(t('model.preset.filled', '已填入预设，补全 API Key 后保存即可。'));
      if (!baseInput.value) baseInput.focus();
      else if (!modelInput.value) modelInput.focus();
      else keyInput.focus();
    });
  });

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var provider = current.provider;
    var apiFormat = formatInput.value;
    var baseUrl = baseInput.value.trim();
    var model = modelInput.value.trim();
    if (!baseUrl || !model) {
      setStatus('error', t('model.status.error', '保存失败'));
      setNote(t('model.required', 'API 地址和模型名称不能为空。'), true);
      return;
    }
    var patch = {
      provider: provider,
      api_format: apiFormat,
      base_url: baseUrl,
      model: model,
    };
    if (keyInput.value.trim()) patch.api_key = keyInput.value.trim();
    if (await save(patch)) keyInput.value = '';
  });

  fetchButton.addEventListener('click', fetchModels);

  trigger.addEventListener('click', function () {
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  menu.addEventListener('click', async function (event) {
    var choice = event.target.closest('[data-model-choice]');
    if (choice) {
      var model = choice.dataset.modelChoice;
      closeMenu();
      if (model === current.model && current.configured) return;
      await save({
        provider: current.provider,
        api_format: current.api_format,
        base_url: current.base_url,
        model: model,
      }, t('model.switched', '已切换模型'));
      return;
    }
    if (event.target.closest('[data-model-manage]')) {
      closeMenu();
      /* 模型页搬进 Settings 了：先开弹窗，再点那枚 Model 页签。
         页签按名字点，不依赖左列的顺序 */
      var entry = document.querySelector('.pill[data-modal="Settings"]');
      if (entry) entry.click();
      var tab = document.querySelector('[data-set-tab="model"]');
      if (tab) tab.click();
    }
  });

  document.addEventListener('pointerdown', function (event) {
    if (menu.hidden || event.target.closest('.composer__model, [data-model-menu]')) return;
    closeMenu();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !menu.hidden) {
      closeMenu();
      trigger.focus();
    }
  });

  /* 换视口宽窄时列表会重排（窄屏那档底部与宽度都变），展开中的底板要跟着量一次 */
  window.addEventListener('resize', function () {
    if (!menu.hidden) measureMenu();
  });
  document.addEventListener('langchange', function () {
    if (loaded) paint(current);
    else if (loadError) {
      label.textContent = t('model.status.offline', '服务未启动');
      setStatus('error', t('model.status.offline', '服务未启动'));
      setNote(loadError, true);
      return;
    }
    setNote('');
  });

  window.primebotxModels = {
    refresh: load,
    get current() { return Object.assign({}, current); },
    setModel: function (model) {
      return save({
        provider: current.provider,
        api_format: current.api_format,
        base_url: current.base_url,
        model: model,
      });
    },
  };

  load();
})();
