/* 弹窗的弹出 / 收回，复刻 STRCAT 的面板呼出，所有时长与栏体的 pop() 对齐：
   打开时先把面板压到挤窄态（x 0.75 / y 0.9）；透明度 0.4s 走 panelOut，
   缩放分两段 —— 0.25s power2.out 撑过 1 到 1.02，再用 0.75s elastic.out(1.1, .8) 落定；
   收回时缩放与透明度一起 0.4s 走 panelIn（末段先轻微反向再收拢）。
   阴影跟栏体同一套：柔光 16→32、透明度 .10→.20，时长共用那 0.25 / 0.75 两段，
   与形变一起鼓、一起落，弹窗才有「浮起来又落定」的分量。但阴影不再是 box-shadow
   补间，而是两层独立元素切 opacity（见 cards.css 的 .modal__glow）——
   每帧重画一道 32px 模糊是弹出掉帧的主因。
   本工程没引 CustomEase，曲线按同一组控制点采表插值，和栏体那段 pop() 等价。 */
(function () {
  var root = document.getElementById('modal');
  if (!root || !window.gsap) return;
  var panel = root.querySelector('.modal__panel');
  /* Contact 不在这张表里：账号菜单那枚胶囊改成两段式链接入口（js/contact.js），
     不再有对应的弹窗 */
  var NAMES = ['Preference', 'Settings', 'Privacy'];
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* 三枚胶囊各自那套标题区文案。左列 = 弹窗标题 + 一行说明；
     接上真实数据源时替换这里的字符串即可 */
  var META = {
    Preference: { sub: '3 available' },
    Settings:   { sub: 'Appearance' },
    /* 账号菜单里那两枚也是这套弹窗。说明行讲的是各自的内容，不是占位 */
    Privacy:    { sub: '隐私政策' }
  };
  var titleL = panel.querySelectorAll('[data-modal-title]');
  var subL   = panel.querySelectorAll('[data-modal-sub]');
  var head   = panel.querySelector('.modal__head');

  /* 把「当前弹窗对应的那枚胶囊」标成激活（data-open），
     文件尾部的按压脚本读到它就不再给这枚胶囊压弹 ——
     弹窗开着时反复点同一枚，只是重写一遍文案，没有任何动画。
     name 传空表示没有打开的弹窗，全部清掉 */
  function markPill(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.pill[data-modal]'), function (p) {
      if (name && p.dataset.modal === name) p.setAttribute('data-open', 'true');
      else p.removeAttribute('data-open');
    });
  }

  var TITLE_KEY = {
    Preference: 'modal.preference.title',
    Settings: 'settings.title',
    Privacy: 'modal.privacy.title'
  };
  var SUB_KEY = {
    Preference: 'modal.preference.available',
    Settings: 'settings.appearance',
    Privacy: 'modal.privacy.sub'
  };

  function paint(name) {
    var m = META[name] || {};
    titleL[0].textContent = TITLE_KEY[name] ? t(TITLE_KEY[name]) : name;
    if (subL[0]) subL[0].textContent = SUB_KEY[name] ? t(SUB_KEY[name]) : (m.sub || '');
    panel.setAttribute('aria-label', name);
    /* 从一个弹窗直接换到另一个时，先把上一个胶囊那组还原：
       不然从 Settings 切到别的弹窗、再关窗，Settings 那枚会一直亮着。
       同名重播（再点一次当前这枚）不能还原，否则按钮会先灭一下 */
    restorePills(name);
    markPill(name);
    /* Settings 是另一种版式：标题在左区，整块顶部标题区收掉，
       原来的 64px 让给左右两栏 */
    var isSet = name === 'Settings';
    Array.prototype.forEach.call(panel.querySelectorAll('[data-settings-only]'), function (el) {
      el.hidden = !isSet;
    });
    if (head) head.hidden = isSet;
    /* Privacy 是一段纯文本（.doc），和 Settings 一样按弹窗名整块切。
       这块没有内部状态，切走再回来内容不变，不需要另外复位 */
    Array.prototype.forEach.call(panel.querySelectorAll('[data-privacy-only]'), function (el) {
      el.hidden = name !== 'Privacy';
    });
    /* Preference 是机器人外观那一块（换皮 + 导入）：照弹窗名整块切。
       卡片的选中态由 js/q1skin.js 自己写，这里只负责显隐，
       切走再回来外观、导入列表都还是原样 */
    Array.prototype.forEach.call(panel.querySelectorAll('[data-preference-only]'), function (el) {
      el.hidden = name !== 'Preference';
    });
  }

  /* cubic-bezier(x1,y1,x2,y2) → x 到 y 的查表函数；y 允许越出 0~1（过冲就靠它） */
  function cubicEase(x1, y1, x2, y2) {
    var N = 160, xs = [], ys = [], i, t;
    var bez = function (a, b, u) {
      var v = 1 - u;
      return 3 * a * u * v * v + 3 * b * u * u * v + u * u * u;
    };
    for (i = 0; i <= N; i++) {
      t = i / N;
      xs.push(bez(x1, x2, t));
      ys.push(bez(y1, y2, t));
    }
    return function (p) {
      if (p <= 0) return 0;
      if (p >= 1) return 1;
      var lo = 0, hi = N, mid;
      while (lo < hi) {
        mid = (lo + hi) >> 1;
        if (xs[mid] < p) lo = mid + 1; else hi = mid;
      }
      var k = Math.max(1, lo), span = (xs[k] - xs[k - 1]) || 1;
      return ys[k - 1] + (ys[k] - ys[k - 1]) * ((p - xs[k - 1]) / span);
    };
  }
  var PANEL_OUT = cubicEase(0.22, 1.18, 0.36, 1);   /* STRCAT panelOut */
  var PANEL_IN  = cubicEase(0.64, 0, 0.78, -0.18);  /* STRCAT panelIn */

  /* 时长与栏体的 pop() 逐项对齐：内容 0.4 进 / 0.4 出，形变分两段 ——
     先 0.25 撑过 1 到极值，再用 0.75 的弹性落定；收回时的形变归位 0.2 */
  var OPEN_DUR    = 0.4;    /* 透明度通道（栏体 OPEN_DUR） */
  var CLOSE_DUR   = 0.15;   /* 收回：比栏体短，弹窗一收就走，不必等满一拍 */
  var UP_DUR      = 0.25;   /* 撑到两轴极值（栏体 UP_DUR） */
  var BACK_DUR    = 0.75;   /* 弹性收回 1（栏体 BACK_DUR） */
  var SH_CLOSE_DUR = 0.2;   /* 收回时阴影归位（栏体同值，power2.out） */
  var SQUASH_X    = 0.75;   /* 起手横向挤压（OPEN_SQUASH_X） */
  var SQUASH_Y    = 0.9;    /* 起手纵向（OPEN_SQUASH_Y） */
  var CLOSE_X     = 0.25;   /* 收回时的横向压缩：比打开起手更扁，收得像被抽走 */
  var CLOSE_Y     = 0.8;    /* 收回时的纵向压缩：比起手的 0.9 更扁，两轴一起抽走 */
  var PEAK_X      = 1.02;   /* 横向拉伸极值，与栏体同值：1 → 1.02 → 1 */
  var PEAK_Y      = 1.02;   /* 纵向同值，等比鼓一下 */
  var SQUASH_EASE = 'elastic.out(1.1, 0.8)';

  /* 这一套节拍递给登录 / 注册面板用（js/auth.js 的 popIn / popOut）：
     那里没有胶囊作为起点，但卡片弹出来的挤压形变、缓动与时长要跟弹窗一致，
     数值整包递出去，不另抄一份 —— 以后调这里，登录面板跟着变 */
  window.primebotxPopTiming = {
    open: OPEN_DUR, close: CLOSE_DUR, up: UP_DUR, back: BACK_DUR,
    out: PANEL_OUT, in: PANEL_IN,
    squashX: SQUASH_X, squashY: SQUASH_Y,
    closeX: CLOSE_X, closeY: CLOSE_Y,
    peakX: PEAK_X, peakY: PEAK_Y,
    squashEase: SQUASH_EASE
  };

  /* 阴影通道：值仍与栏体 pop() 一致（柔光 16 → 32、透明度 .10 → .20），
     只是改成「展开态那层 0 → 1」，时长共用 UP_DUR / BACK_DUR */
  var SH_UP     = UP_DUR;   /* 冲到最鼓的时长 */
  var SH_BACK   = BACK_DUR; /* 落回常态的时长，与缩放同时结束 */
  var SH_CLOSE  = SH_CLOSE_DUR;   /* 收回时归位，与栏体同值 .2 */

  var tl = null, shown = false;

  /* 柔光那两层（见 cards.css 的 .modal__glow）。
     面板呼吸时阴影要从 16px/.1 变到 32px/.2，但不再补间 box-shadow ——
     那条每帧都要重画一道大范围模糊，是弹出掉帧的主因。
     现在只把「展开态」那层的 opacity 推上去：合成层做透明度，零重绘 */
  var glow = panel.querySelector('.modal__glow--up');

  /* 弹窗胶囊的选中态只活到弹窗关掉为止。
     开窗前的 pointerdown 先记下那一组本来选中的是哪一枚（相机与 Modal 那组、
     控制组、账号菜单各自独立），关窗时再按它还原 —— 不记这一笔的话，
     点过 Settings 之后那枚会一直亮着：它只是开弹窗的入口，不是切到了常驻视图。
     用 pointerdown 而不是 click，因为按钮自己的组内单选也挂在 click 上，
     同一元素上按注册顺序先跑，等 click 走到这里选中态已经换过一遍了。
     弹窗已经开着时不再记录：那是从一个弹窗换到另一个，要还原的仍是头一次开窗前的样子 */
  document.addEventListener('pointerdown', function (e) {
    if (shown) return;
    var pill = e.target.closest && e.target.closest('.pill[data-modal]');
    if (!pill) return;
    if (NAMES.indexOf(pill.dataset.modal) < 0) return;
    var box = pill.closest('.group, .user__menu');
    if (!box) return;
    var cur = box.querySelector('.pill.is-active');
    box.dataset.prevActive = cur && cur.dataset.modal ? cur.dataset.modal : '';
  }, true);

  /* 按记下的那一枚还原：空串表示开窗前这一组谁都没选中，全部熄灭。
     keep 是「这次要留下的那一枚」，换弹窗时传新的名字，免得把刚点亮的那组也还原掉 */
  function restorePills(keep) {
    Array.prototype.forEach.call(document.querySelectorAll('.pill[data-open]'), function (p) {
      if (keep && p.dataset.modal === keep) return;
      var box = p.closest('.group, .user__menu');
      if (!box) return;
      var prev = box.dataset.prevActive || '';
      Array.prototype.forEach.call(box.querySelectorAll('.pill'), function (x) {
        var on = !!x.dataset.modal && x.dataset.modal === prev;
        x.classList.toggle('is-active', on);
        x.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      delete box.dataset.prevActive;
    });
  }

  /* 形变 + 阴影这一对通道，打开与「换胶囊重播」共用同一套节拍。
     调用前面板应已在挤窄态、阴影在常态；两段式与栏体 pop() 逐帧等价 */
  function squashChannel(t) {
    t.to(panel, { scaleX: PEAK_X, scaleY: PEAK_Y, duration: UP_DUR, ease: 'power2.out' }, 0)
     .to(panel, { scaleX: 1, scaleY: 1, duration: BACK_DUR, ease: SQUASH_EASE }, UP_DUR);
    /* 阴影那一路：展开态那层 0 → 1，时长与缩放共用 UP_DUR / BACK_DUR，
       阴影和形变一起鼓、一起落。改的只是 opacity */
    if (glow) {
      t.to(glow, { opacity: 1, duration: SH_UP, ease: 'power2.out' }, 0)
       .to(glow, { opacity: 0, duration: SH_BACK, ease: SQUASH_EASE }, SH_UP);
    }
    return t;
  }

  /* 弹出这一段把机器人让出来：同一帧里既要缩放整块面板、又要重画阴影与文字，
     再叠一次 17 万面的白壳就挤不出 16ms 了。3D 暂停 1.15 秒（盖住 0.4 的
     内容通道到 1.0 的弹性落定），之后由 is-modal 这个标记把它按在低帧率上；
     关窗时两道一起撤掉。body 上的 is-modal 同时让磁吸停手 ——
     光标此刻正停在顶栏胶囊上，那层带 backdrop-filter 的托盘还在倾斜的话，
     每帧都要重新模糊一次它背后的画布 */
  function restRobot(ms) {
    if (window.robot3d && window.robot3d.suspend) window.robot3d.suspend(ms);
  }

  function show() {
    shown = true;
    root.style.visibility = 'visible';
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('is-modal');
    if (tl) tl.kill();
    gsap.killTweensOf(panel);
    if (glow) gsap.killTweensOf(glow);
    /* 起手落在挤窄态：这一步不可见，面板此时 opacity 还是 0。
       阴影一起回到常态，避免上一次收回被打断时还挂着展开态那一层 */
    gsap.set(panel, { opacity: 0, scaleX: SQUASH_X, scaleY: SQUASH_Y });
    if (glow) gsap.set(glow, { opacity: 0 });
    if (reduce.matches) {
      gsap.set(panel, { opacity: 1, scaleX: 1, scaleY: 1 });
      return;
    }
    restRobot(1150);
    tl = gsap.timeline();
    tl.to(panel, { opacity: 1, duration: OPEN_DUR, ease: PANEL_OUT }, 0);
    squashChannel(tl);
  }

  function hide() {
    if (!shown) return;
    shown = false;
    root.setAttribute('aria-hidden', 'true');
    restorePills();   /* 先按开窗前的样子把胶囊还原，再清掉 data-open */
    markPill(null);   /* 弹窗都收了，胶囊不再是激活态，压弹恢复 */
    if (tl) tl.kill();
    gsap.killTweensOf(panel);
    if (glow) gsap.killTweensOf(glow);
    if (reduce.matches) {
      gsap.set(panel, { opacity: 0 });
      if (glow) gsap.set(glow, { opacity: 0 });
      root.style.visibility = 'hidden';
      document.body.classList.remove('is-modal');
      return;
    }
    tl = gsap.timeline({
      onComplete: function () {
        /* 期间又被点开就保持可见，也别归位：下次开窗还接着这次的姿态走 */
        if (shown) return;
        root.style.visibility = 'hidden';
        document.body.classList.remove('is-modal');
      }
    });
    /* 收回的内容通道走 CLOSE_DUR，两轴各取收回专用值，比打开起手更扁 */
    tl.to(panel, {
      opacity: 0, scaleX: CLOSE_X, scaleY: CLOSE_Y,
      duration: CLOSE_DUR, ease: PANEL_IN
    }, 0);
    /* 阴影归位和栏体收回一样是 .2 power2.out：套 panelIn（前段几乎不动）的话，
       阴影会是被裁掉而不是收回去的 */
    if (glow) tl.to(glow, { opacity: 0, duration: SH_CLOSE, ease: 'power2.out' }, 0);
  }

  /* 这几枚胶囊开弹窗；Camera / Modal 与账号菜单里其余两项保持原样。
     点菜单项不收起账号面板：选中哪一项就留在哪一项上，面板只在点空白与 Esc 时收。
     高亮交给账号面板自己那套组内单选（点谁亮谁），这里不再插手，
     否则会在同一次点击里先亮起来又被抹掉，闪一下 */
  Array.prototype.forEach.call(document.querySelectorAll('.pill[data-modal]'), function (pill) {
    if (NAMES.indexOf(pill.dataset.modal) < 0) return;
    pill.addEventListener('click', function () {
      /* 文案在动画之前写入：起手那一帧面板还不可见，换字不会被看见 */
      paint(pill.dataset.modal);
      if (!shown) {
        show();
        return;
      }
      /* 弹出动画还在跑：只换字，形变与阴影一根手指都别碰。
         这里若照旧 kill + set，等于把弹到一半的面板硬拽到 1，动画就断了 */
      if (tl && tl.isActive()) return;
      /* 已经落定（或 tl 已结束）：把形态与阴影按回落定态，
         万一上一次被打断过，也不会带着半程的 0.97 或 32px 阴影挂着 */
      if (tl) tl.kill();
      gsap.killTweensOf(panel);
      if (glow) gsap.killTweensOf(glow);
      gsap.set(panel, { opacity: 1, scaleX: 1, scaleY: 1 });
      if (glow) gsap.set(glow, { opacity: 0 });
    });
  });

  /* 点面板外 / Esc 收回；落在胶囊上的点击交给胶囊自己，避免「刚开就关」 */
  document.addEventListener('pointerdown', function (e) {
    if (!shown) return;
    if (root.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.pill')) return;
    hide();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hide();
  });

  /* ---------- Settings 内部 ---------- */

  /* 左列选项单选：点哪个，右侧只留对应那一块。目前只有 Appearance 一项，
     选项与面板都用 data 属性配对，加新项时两边各补一个节点即可 */
  var tabs = panel.querySelectorAll('[data-set-tab]');
  function pickTab(key) {
    Array.prototype.forEach.call(tabs, function (t) {
      var on = t.dataset.setTab === key;
      t.classList.toggle('is-sel', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(panel.querySelectorAll('[data-set-pane]'), function (g) {
      g.hidden = g.dataset.setPane !== key;
    });
    /* 标题区那行说明跟着当前选项走 */
    if (panel.getAttribute('aria-label') === 'Settings') {
      var subMap = { appearance: 'settings.appearance', language: 'settings.language', model: 'settings.model' };
      if (subL[0]) subL[0].textContent = subMap[key] ? t(subMap[key]) : key;
    }
  }
  Array.prototype.forEach.call(tabs, function (t) {
    t.addEventListener('click', function () { pickTab(t.dataset.setTab); });
  });

  /* ---------- Settings 内部 ---------- */

  /* 明暗模式：day / night，切的是 <html> 上的 data-theme，颜色全部由 :root 那套
     变量带出来，night 就是预留给深色的那一组。首帧之前 <head> 里已经按存下的选择
     设过一次，这里只负责按钮状态与记住选择；背景画布的底色和点阵色阶由背景脚本
     监听同一个属性自己重铺，不用在这里通知它 */
  var MODE_KEY = 'primebotx.mode';
  var modeSegs = panel.querySelectorAll('.seg__opt[data-mode]');
  var modeVt = null;   /* 上一次还没播完的视图过渡，连点时先掐掉再起新的 */

  function markMode(key) {
    Array.prototype.forEach.call(modeSegs, function (b) {
      var on = b.dataset.mode === key;
      b.classList.toggle('is-sel', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function pickMode(key) {
    if (key !== 'night') key = 'day';
    var html = document.documentElement;
    var want = key === 'night' ? 'dark' : 'light';
    /* 值没变就什么都不做：重复点当前那一枚时不该重播一遍过渡，
       背景脚本的 MutationObserver 也不用白跑一次重铺（正在扩散的波阵会被打断） */
    if (html.getAttribute('data-theme') === want) {
      markMode(key);
      try { localStorage.setItem(MODE_KEY, key); } catch (e) {}
      return;
    }
    /* 按钮状态与主题在同一帧里换完：放进过渡回调里，旧画面的快照才是完整的旧状态，
       不会出现「按钮已经高亮成 night、背景还是浅色」的错位帧 */
    function apply() {
      markMode(key);
      html.setAttribute('data-theme', want);
    }
    /* 整页交叉淡入淡出：切换前后各截一张快照交给合成器去混，真实页面在过渡期间不重绘，
       面板背后的 backdrop 模糊也不用逐帧重算。逐条补间颜色反而更卡 —— 全站上千个
       颜色属性一起过渡，每一帧都要重排重绘。没有这个 API 就退回瞬切 */
    if (document.startViewTransition) {
      if (modeVt && modeVt.skipTransition) modeVt.skipTransition();
      modeVt = document.startViewTransition(apply);
    } else {
      apply();
    }
    try { localStorage.setItem(MODE_KEY, key); } catch (e) {}
  }
  Array.prototype.forEach.call(modeSegs, function (b) {
    b.addEventListener('click', function () { pickMode(b.dataset.mode); });
  });
  /* 没存过就按当前 <html> 上已经是哪一种来点亮，别把 night 刷成 day */
  try {
    var savedMode = localStorage.getItem(MODE_KEY);
    pickMode(savedMode === 'night' || savedMode === 'day' ? savedMode
      : (document.documentElement.getAttribute('data-theme') === 'dark' ? 'night' : 'day'));
  } catch (e) { pickMode('day'); }

  /* 背景样式：三选一，写进背景脚本（window.Bgfx）并记住选择。
     背景脚本自己也会读同一个键，所以刷新后一进页面就是上次那一种，不用等这里来对齐。
     旧版存过 matrix 的，读进来一律当 plain（plain 现在就是那层静态基础网格） */
  var BG_KEY = 'primebotx.bg';
  var segs = panel.querySelectorAll('.seg__opt[data-bg]');
  function pickBg(key) {
    if (key !== 'plain' && key !== 'wave') key = 'magnetic';
    Array.prototype.forEach.call(segs, function (b) {
      var on = b.dataset.bg === key;
      b.classList.toggle('is-sel', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    try { localStorage.setItem(BG_KEY, key); } catch (e) {}
    if (window.Bgfx && window.Bgfx.setStyle) window.Bgfx.setStyle(key);
  }
  Array.prototype.forEach.call(segs, function (b) {
    b.addEventListener('click', function () { pickBg(b.dataset.bg); });
  });
  /* 进来先把按钮状态对齐已存的选择（背景脚本可能还没跑到，setStyle 内部会自己判断） */
  try {
    var savedBg = localStorage.getItem(BG_KEY);
    if (savedBg === 'matrix') savedBg = 'plain';
    pickBg(savedBg === 'plain' || savedBg === 'wave' ? savedBg : 'magnetic');
  } catch (e) {}

  document.addEventListener('langchange', function () {
    if (!shown) return;
    var name = panel.getAttribute('aria-label');
    if (name && TITLE_KEY[name]) {
      titleL[0].textContent = t(TITLE_KEY[name]);
      if (subL[0]) subL[0].textContent = SUB_KEY[name] ? t(SUB_KEY[name]) : '';
    }
  });

  /* 机器人显示范围：body（上半身）/ head（头部特写），写进 px.bot 并通知 3D 模块。
     3D 模块自己也读同一个键，所以刷新后直接就是上次那一档；
     这里调用时它可能还没加载完，那就只存键，等它起来自己认 */
  var BOT_KEY = 'primebotx.bot';
  var botSegs = panel.querySelectorAll('.seg__opt[data-bot]');
  function pickBot(key) {
    if (key !== 'head') key = 'body';
    Array.prototype.forEach.call(botSegs, function (b) {
      var on = b.dataset.bot === key;
      b.classList.toggle('is-sel', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    try { localStorage.setItem(BOT_KEY, key); } catch (e) {}
    if (window.robot3d && window.robot3d.setFraming) window.robot3d.setFraming(key);
  }
  Array.prototype.forEach.call(botSegs, function (b) {
    b.addEventListener('click', function () { pickBot(b.dataset.bot); });
  });
  try {
    pickBot(localStorage.getItem(BOT_KEY) === 'head' ? 'head' : 'body');
  } catch (e) { pickBot('body'); }
})();
