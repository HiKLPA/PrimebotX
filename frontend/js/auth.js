/* 登录 / 注册：首次进入网站浮出；未登录时点账号胶囊照常展开菜单
   （Settings / Privacy / Contact 都能用），点头像才回到这里。
   面板结构与样式分别是 PrimebotX.html 里的 #auth 与 css/auth.css，
   按钮就是顶栏那枚 .pill，动画一条都没有另写。

   后端口（见 backend/src/web_system.cpp）：
     POST /api/v1/auth/register  {username, password, display_name?}
     POST /api/v1/auth/login     {username, password} → access_token
     GET  /api/v1/auth/me        Authorization: Bearer <token>
     POST /api/v1/auth/logout    Authorization: Bearer <token>
   回包统一是 {request_id, data, error:{code, message}}。出错时直接把后端那句
   摆到面板下方 —— 它本来就是给人看的（用户名已注册 / 用户名或密码错误 /
   请求过于频繁），前端再编一套只会两边说法不一致。

   token 存 localStorage：换标签页、关掉浏览器再进来都还算登录。
   「先逛逛」也记一笔 seen，之后不再自动浮出；点账号胶囊照样能打开。 */
(function () {
  const API = '/api/v1';
  const TOKEN_KEY = 'primebotx.auth.token';
  const SEEN_KEY = 'primebotx.auth.seen';

  const root = document.getElementById('auth');
  if (!root) return;

  const form = document.getElementById('auth-panel');
  const panel = root.querySelector('.auth__panel');
  const msgEl = document.getElementById('auth-msg');
  const usernameEl = document.getElementById('auth-username');
  const displayEl = document.getElementById('auth-display');
  const passwordEl = document.getElementById('auth-password');
  const submitBtn = document.getElementById('auth-submit');
  const submitLabel = submitBtn ? submitBtn.querySelector('.pill__label') : null;
  const greetName = root.querySelector('[data-greet-name]');
  const greetEl = root.querySelector('.auth__greet');
  const tabs = Array.prototype.slice.call(root.querySelectorAll('[data-auth-mode]'));
  const registerOnly = Array.prototype.slice.call(root.querySelectorAll('[data-auth-register-only]'));
  const skipEls = Array.prototype.slice.call(document.querySelectorAll('[data-auth-skip]'));

  const account = document.getElementById('account');
  const nameEl = account ? account.querySelector('.user__name') : null;
  const trigger = account ? account.querySelector('.user__trigger') : null;
  const logoutBtn = account ? account.querySelector('[data-auth-logout]') : null;
  const logoutLabel = logoutBtn ? logoutBtn.querySelector('.pill__label') : null;

  let user = null;
  let mode = 'login';
  let busy = false;

  /* 退出的两段式确认：第一下只上膛 —— 这一项染成 warning、字换成 Confirm，
     3 秒内再点一下才真的退出。 */
  const LOGOUT_HOLD = 3000;
  let logoutArmed = false;
  let logoutTimer = 0;

  /* ---------- 存取 ---------- */

  function readToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (err) { return ''; }
  }
  function writeToken(token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch (err) {}
  }
  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (err) {}
  }
  function seen() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (err) { return false; }
  }
  function markSeen() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (err) {}
  }

  /* 所有非 GET 都要带 Idempotency-Key（后端在业务锁里按它去重），
     且同一个键提交不同内容会被判 409，所以每次提交现生成一个 ——
     复用同一个键的话，第二次输错密码也会拿回第一次那份成功的缓存 */
  function idempotencyKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  async function api(path, options) {
    const opts = options || {};
    const method = opts.method || 'GET';
    const headers = { 'Content-Type': 'application/json' };
    if (method !== 'GET') headers['Idempotency-Key'] = idempotencyKey();
    const token = readToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    let res;
    try {
      res = await fetch(API + path, {
        method: method,
        headers: headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
      });
    } catch (err) {
      throw new Error(t('auth.error.network'));
    }
    let payload = null;
    try { payload = await res.json(); } catch (err) {}
    if (!res.ok) {
      const error = new Error(
        (payload && payload.error && payload.error.message) || t('auth.error.network')
      );
      error.status = res.status;
      error.code = payload && payload.error ? payload.error.code : '';
      throw error;
    }
    return (payload && payload.data) || null;
  }

  /* ---------- 面板 ---------- */

  function setMessage(text, kind) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.classList.toggle('is-error', kind === 'error');
    msgEl.classList.toggle('is-ok', kind === 'ok');
  }

  /* 提交钮的字跟着页签走；语种一变也由这里重写，
     data-i18n 只管得住静态那几处（标签、占位、页签本身）。
     未登录时用户名那一格是一枚入口（注册/登录），不是占位词 */
  function refreshCopy() {
    const key = mode === 'register' ? 'register' : 'login';
    if (submitLabel) submitLabel.textContent = t('auth.' + key);
    if (!user && nameEl) nameEl.textContent = t('auth.entry');
    /* 退出项的字是脚本按状态写的（上膛时是 Confirm），而 i18n 切语言时会先
       照 data-i18n 刷回 Log out —— 这里按当前状态再写一遍，别让确认态丢字 */
    paintLogout();
  }

  /* 提交钮的宽度由 flex 吃满整列，CSS 能算出来，但卡片的宽度会随视口伸缩；
     而顶栏胶囊 hover 时靠 --pill-w 反推右缘，所以这里量一次真实宽度写回去 */
  function syncPillWidth() {
    if (!submitBtn) return;
    const width = submitBtn.getBoundingClientRect().width;
    if (width) submitBtn.style.setProperty('--pill-w', width + 'px');
  }

  function setMode(next) {
    mode = next === 'register' ? 'register' : 'login';
    tabs.forEach(function (btn) {
      const on = btn.dataset.authMode === mode;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    registerOnly.forEach(function (el) { el.hidden = mode !== 'register'; });
    if (passwordEl) {
      passwordEl.setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
    }
    refreshCopy();
    setMessage('');
  }

  /* 左栏那两行大字跟着用户名走。空着的时候塞一个不含字形的空格 ——
     给空串会让第二行塌掉，HELLO 下面那行一没，整块的位置就跳了 */
  function syncGreet() {
    if (!greetName || !usernameEl) return;
    greetName.textContent = (usernameEl.value || '').trim() || '\u00a0';
  }

  /* ---------- 弹出 / 收回 ---------- */

  /* 与弹窗那套弹出动画同一个来源：时长、两段式挤压形变、缓动全部取自
     js/modal.js 递出的 window.primebotxPopTiming（见那里的注释）。
     这里不写字面量，改弹窗那边的节拍，这张卡片自动跟上。
     modal.js 在页面靠后加载，但它的守卫（无 GSAP 时整段退出）会让这个对象缺席，
     所以取的时候留一份同值的兜底，保证卡片不会因为拿不到节拍而弹不出来 */
  const POP_FALLBACK = {
    open: 0.4, close: 0.15, up: 0.25, back: 0.75,
    out: 'power2.out', in: 'power2.in',
    squashX: 0.75, squashY: 0.9, closeX: 0.25, closeY: 0.8,
    peakX: 1.02, peakY: 1.02, squashEase: 'elastic.out(1.1, 0.8)'
  };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let timeline = null;
  let closing = false;

  function pop() {
    return window.primebotxPopTiming || POP_FALLBACK;
  }

  /* 起手先落在挤窄态再撑开：卡片是「被挤出来」的，
     不是从下往上浮出来的 —— 与弹窗弹开的说法一致。
     遮罩现在是一整片纯色，淡入交给根节点统一做：卡片缩放的同一拍里
     纯色从 0 提到 1，不会出现「卡片悬在一块半透明膜上」那种分离感 */
  function popIn() {
    if (!window.gsap || !panel) return;
    const t = pop();
    if (timeline) timeline.kill();
    gsap.killTweensOf(panel);
    gsap.killTweensOf(root);
    /* 上一次收回可能停在 is-closing（磨砂那一层）上，重开时先摘掉 */
    root.classList.remove('is-closing');
    if (reduceMotion.matches) {
      gsap.set(panel, { opacity: 1, scaleX: 1, scaleY: 1 });
      gsap.set(root, { opacity: 1 });
      return;
    }
    gsap.set(root, { opacity: 0 });
    gsap.set(panel, { opacity: 0, scaleX: t.squashX, scaleY: t.squashY });
    timeline = gsap.timeline({
      onComplete: function () {
        /* 根节点的透明度只服务这次开合，交还给 CSS，
           免得留一行 inline opacity 把下次收回的起点钉死 */
        gsap.set(root, { clearProps: 'opacity' });
      }
    });
    timeline.to(root, { opacity: 1, duration: t.open * 0.7, ease: 'power1.out' }, 0)
            .to(panel, { opacity: 1, duration: t.open, ease: t.out }, 0)
            .to(panel, { scaleX: t.peakX, scaleY: t.peakY, duration: t.up, ease: 'power2.out' }, 0)
            .to(panel, { scaleX: 1, scaleY: 1, duration: t.back, ease: t.squashEase }, t.up);
  }

  /* 收回比弹出短得多：两轴压得比起手更扁，像被抽走。
     done 在动画走完时才执行 —— 面板要在收的过程里继续可见，
     提前摘掉 is-open 会让它当场消失，动画等于没做。
     渐隐压在根节点上，遮罩的纯色跟着一起退；is-closing 期间根节点补了磨砂，
     纯色退掉之后露出来的是模糊的舞台，再由根节点整片淡掉，不是硬切 */
  function popOut(done) {
    if (!window.gsap || !panel) { done(); return; }
    const t = pop();
    if (timeline) timeline.kill();
    gsap.killTweensOf(panel);
    gsap.killTweensOf(root);
    if (reduceMotion.matches) {
      gsap.set(panel, { opacity: 0 });
      gsap.set(root, { opacity: 0 });
      done();
      return;
    }
    root.classList.add('is-closing');
    timeline = gsap.timeline({
      onComplete: function () {
        root.classList.remove('is-closing');
        gsap.set(root, { clearProps: 'opacity' });
        done();
      }
    });
    timeline.to(panel, {
      opacity: 0, scaleX: t.closeX, scaleY: t.closeY,
      duration: t.close, ease: t.in
    }, 0)
    /* 比卡片慢一倍半：卡片先收掉，剩下的纯色与磨砂再慢慢退，
       两个动作错开，收回才像一层幕落下，而不是东西被同时抽走 */
    .to(root, { opacity: 0, duration: 0.3, ease: 'power2.out' }, 0);
  }

  function openPanel() {
    /* 正在收回时又被叫开：从当前姿态直接弹回去，不再从头 set 一次 */
    if (root.classList.contains('is-open') && !closing) return;
    closing = false;
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    /* 登录页盖住整片舞台，磁吸与机器人的满帧都先停手：
       遮罩背后每帧都要重新模糊一次，留着动画只会白烧帧预算 */
    document.body.classList.add('is-auth');
    /* 面板是从账号胶囊里点出来的，那一层菜单先收起：
       否则登录 / 注册完收起卡片，背后还摊着一块菜单 */
    if (account) {
      account.classList.remove('is-open', 'is-picking');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    }
    if (window.robot3d && window.robot3d.suspend) window.robot3d.suspend(1200);
    /* 每次重新浮出都从「看着你」的常态开始：上一次的吹口哨或笑脸不该带进来 */
    if (window.primebotxAuthFaces) window.primebotxAuthFaces.idle();
    syncGreet();
    popIn();
    window.setTimeout(function () {
      if (!root.classList.contains('is-open') || closing) return;
      /* 密码管理器常在这一刻才把用户名填进来，而且不派发 input 事件，
         所以聚焦前后各对齐一次大字 */
      syncGreet();
      const target = usernameEl && usernameEl.value ? passwordEl : usernameEl;
      if (target) target.focus({ preventScroll: true });
    }, 90);
  }

  function closePanel() {
    if (!root.classList.contains('is-open') || closing) return;
    closing = true;
    root.setAttribute('aria-hidden', 'true');
    setMessage('');
    if (passwordEl) passwordEl.value = '';
    popOut(function () {
      /* 走到这里说明没有再被叫开：中途重开的话上面那条 timeline 会被 kill，
         onComplete 不会触发 */
      closing = false;
      root.classList.remove('is-open');
      document.body.classList.remove('is-auth');
      /* 卡片走了，左栏那几枚色块和彩带也回到常态，下次开面板不会接着上一次的笑脸 */
      if (window.primebotxAuthFaces) window.primebotxAuthFaces.idle();
      /* 行尾那根下划线也收起来：下次浮出要重新看焦点落在哪一格 */
      if (greetEl) greetEl.classList.remove('is-typing');
      if (trigger) trigger.focus({ preventScroll: true });
    });
  }

  /* 「先逛逛」、点遮罩、Esc 都是同一个动作：收起，并记下这次选择 */
  function skip() {
    markSeen();
    closePanel();
  }

  /* ---------- 账号状态 ---------- */

  /* 状态一变就广播一次：头像那边据此决定画不画脸、要不要接点击。
     两边都不互相引用，谁先加载都能对上 */
  function broadcast() {
    document.dispatchEvent(new CustomEvent('authchange', { detail: { user: user } }));
  }

  function applyGuest() {
    user = null;
    if (nameEl) {
      /* 未登录时这一格是入口：字是「注册/登录」，点它开面板（见 wire） */
      nameEl.textContent = t('auth.entry');
      nameEl.removeAttribute('title');
    }
    if (account) {
      account.classList.remove('is-signed-in');
      account.classList.add('is-guest');
    }
    if (logoutBtn) {
      /* 掉线 / 退出之后这一项要回到「Log out」的样子，别把确认态带到下一次登录 */
      disarmLogout();
      logoutBtn.hidden = true;
      logoutBtn.classList.remove('is-active');
      logoutBtn.setAttribute('aria-pressed', 'false');
    }
    broadcast();
  }

  function applyUser(next) {
    if (!next) { applyGuest(); return; }
    user = next;
    if (nameEl) {
      nameEl.textContent = next.display_name || next.username;
      nameEl.title = next.username;
    }
    if (account) {
      account.classList.add('is-signed-in');
      account.classList.remove('is-guest');
    }
    if (logoutBtn) logoutBtn.hidden = false;
    if (usernameEl) usernameEl.value = next.username;
    broadcast();
  }

  /* ---------- 退出登录的确认态 ---------- */

  /* 画法只有一条依据：logoutArmed。菜单那套组内单选会在点击时抢先给这一项挂
     is-active，这里立刻收回 —— 亮不亮只该由确认态决定，与「选中」无关 */
  function paintLogout() {
    if (!logoutBtn) return;
    logoutBtn.classList.remove('is-active');
    logoutBtn.setAttribute('aria-pressed', 'false');
    logoutBtn.classList.toggle('is-arm', logoutArmed);
    if (logoutLabel) logoutLabel.textContent = t(logoutArmed ? 'auth.logout.confirm' : 'auth.logout');
  }

  function disarmLogout() {
    if (logoutTimer) { clearTimeout(logoutTimer); logoutTimer = 0; }
    if (!logoutArmed) return;
    logoutArmed = false;
    paintLogout();
  }

  function armLogout() {
    if (logoutArmed) return;
    logoutArmed = true;
    paintLogout();
    /* 固定 3 秒、不随指针进出提前收回：确认靠「再点一下」完成，
       指针停不停在按钮上都不是信号。 */
    if (logoutTimer) clearTimeout(logoutTimer);
    logoutTimer = setTimeout(disarmLogout, LOGOUT_HOLD);
  }

  async function logout() {
    disarmLogout();
    if (logoutBtn) logoutBtn.disabled = true;
    if (window.primebotxProfile && typeof window.primebotxProfile.flush === 'function') {
      try { await window.primebotxProfile.flush(); } catch (err) {}
    }
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
    } catch (err) {
      /* 会话可能已经在别处失效：本地照清，别把用户困在登录态里 */
    }
    if (logoutBtn) logoutBtn.disabled = false;
    clearToken();
    applyGuest();
    if (account) {
      account.classList.remove('is-open', 'is-picking');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    }
  }

  /* ---------- 提交 ---------- */

  /* 被挡下来的那一下：表情先换成震惊，再去看是哪一格。
     三种错误共用同一条出口，免得每处都抄一遍 */
  function reject(errorKey, field) {
    setMessage(t(errorKey), 'error');
    if (field) field.focus();
    if (window.primebotxAuthFaces) window.primebotxAuthFaces.shock();
  }

  async function submit() {
    if (busy) return;
    const username = (usernameEl.value || '').trim();
    const password = passwordEl.value || '';
    const display = (displayEl.value || '').trim();

    /* 先按后端那几条规则挡一遍：本地能立刻指出是哪一格不对，
       不必等一次往返；后端校验照旧是最后一道 */
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
      reject('auth.error.username', usernameEl);
      return;
    }
    if (password.length < 8 || password.length > 16) {
      reject('auth.error.password', passwordEl);
      return;
    }
    if (mode === 'register' && display.length > 32) {
      reject('auth.error.display', displayEl);
      return;
    }

    busy = true;
    submitBtn.disabled = true;
    setMessage('');
    try {
      if (mode === 'register') {
        const body = { username: username, password: password };
        if (display) body.display_name = display;
        await api('/auth/register', { method: 'POST', body: body });
        /* 注册不发 token：切回登录页，用户名留着，只需要再输一次密码 */
        setMode('login');
        usernameEl.value = username;
        passwordEl.value = '';
        syncGreet();
        setMessage(t('auth.register.ok'), 'ok');
        passwordEl.focus();
        /* 笑脸放在真的注册成功之后：先切回登录页、把光标放回密码框，
           再笑 —— 不然「笑完发现用户名已被占用」比不笑更尴尬 */
        if (window.primebotxAuthFaces) window.primebotxAuthFaces.celebrate();
      } else {
        const data = await api('/auth/login', {
          method: 'POST',
          body: { username: username, password: password }
        });
        writeToken(data.access_token);
        markSeen();
        applyUser(data.user);
        /* 笑脸与彩带先亮一下再收起卡片：立刻 closePanel 会把刚喷出去的
           彩带连同整块左栏一起切掉，950ms 刚好够它飞到画面上方 */
        if (window.primebotxAuthFaces) window.primebotxAuthFaces.celebrate();
        window.setTimeout(closePanel, 950);
      }
    } catch (err) {
      setMessage(err.message, 'error');
      /* 账号或密码不匹配也走震惊：提交那一刻不再抢着笑，
         笑脸与彩带只留给真的进去了的那一次 */
      if (window.primebotxAuthFaces) window.primebotxAuthFaces.shock();
    } finally {
      busy = false;
      submitBtn.disabled = false;
    }
  }

  /* ---------- 装配 ---------- */

  function wire() {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submit();
    });
    /* 用户名每敲一个字，左栏那行大字跟着换；用 input 而不是 keyup，
       粘贴、输入法上屏、右键清空都能接住 */
    if (usernameEl) {
      usernameEl.addEventListener('input', syncGreet);
      /* 行尾那根下划线只在用户名格子拿着焦点时闪 ——
         光标挪到密码框、或点掉了，它就收起来，不抢「别过头吹口哨」那只眼睛的戏 */
      usernameEl.addEventListener('focus', function () {
        if (greetEl) greetEl.classList.add('is-typing');
      });
      usernameEl.addEventListener('blur', function () {
        if (greetEl) greetEl.classList.remove('is-typing');
      });
    }
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () { setMode(btn.dataset.authMode); });
    });
    skipEls.forEach(function (el) {
      el.addEventListener('click', skip);
    });
    /* 登录卡片外的遮罩空白也算一次明确的退出动作。
       面板内部交给表单自己处理，点击输入框、页签和按钮都不会误关。 */
    root.addEventListener('click', function (event) {
      if (event.target.closest('.auth__panel')) return;
      skip();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && root.classList.contains('is-open')) skip();
    });

    /* 账号胶囊未登录时照常展开菜单：Settings / Privacy / Contact 都不需要账号。
       登录入口是用户名那一格（点它开面板）；头像那边在未登录时也指向这里 */
    if (nameEl) {
      nameEl.addEventListener('click', function (event) {
        if (user) return;
        event.preventDefault();
        event.stopPropagation();
        openPanel();
      });
    }

    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        /* 第一下只上膛：这一项染成 warning、字换成 Confirm，不真的退 ——
           顺手也把菜单那套组内单选会挂上的「选中」摘掉（在 paintLogout 里）。
           第二下才走；想反悔就等 3 秒，或干脆不点 */
        if (!logoutArmed) { armLogout(); return; }
        disarmLogout();
        logout();
      });
    }

    document.addEventListener('langchange', refreshCopy);

    /* 按钮宽度随卡片宽度变（视口缩放、窄屏单列），量出来写回 --pill-w */
    if (window.ResizeObserver && submitBtn) {
      new ResizeObserver(syncPillWidth).observe(submitBtn);
    }
    window.addEventListener('resize', syncPillWidth);
  }

  function boot() {
    wire();
    setMode('login');
    syncGreet();
    applyGuest();
    syncPillWidth();

    if (readToken()) {
      api('/auth/me').then(function (data) {
        applyUser(data.user);
      }).catch(function (err) {
        if (err.status === 401) clearToken();
        applyGuest();
        if (!seen()) openPanel();
      });
      return;
    }
    /* 第一次进来：等页面落定再浮出，免得和顶栏 / 机器人的入场叠在一起 */
    if (!seen()) window.setTimeout(openPanel, 700);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* 给别的脚本留个读口：当前登录用户与手动开合 */
  window.primebotxAuth = {
    get user() { return user; },
    get token() { return readToken(); },
    open: openPanel,
    close: closePanel,
    logout: logout
  };
})();
