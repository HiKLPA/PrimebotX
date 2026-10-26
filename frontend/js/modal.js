/* 弹窗的弹出 / 收回，复刻 STRCAT 的面板呼出，所有时长与栏体的 pop() 对齐：
   打开时先把面板压到挤窄态（x 0.75 / y 0.9）；透明度 0.4s 走 panelOut，
   缩放分两段 —— 0.25s power2.out 撑过 1 到 1.02，再用 0.75s elastic.out(1.1, .8) 落定；
   收回时缩放与透明度一起 0.4s 走 panelIn（末段先轻微反向再收拢）。
   阴影跟栏体同一套：柔光半径 --sh 16→32、透明度 --sh-a .10→.20，
   时长共用那 0.25 / 0.75 两段，与形变一起鼓、一起落，弹窗才有「浮起来又落定」的分量。
   本工程没引 CustomEase，曲线按同一组控制点采表插值，和栏体那段 pop() 等价。 */
(function () {
  var root = document.getElementById('modal');
  if (!root || !window.gsap) return;
  var panel = root.querySelector('.modal__panel');
  var NAMES = ['Connect', 'Preference', 'Advance', 'Settings'];
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* 三枚胶囊各自那套标题区文案。左列 = 弹窗标题 + 一行说明，
     右列 = 一行标题 + 一行说明；除 Connect 的两行是实指，其余是占位，
     接上真实数据源时替换这里的字符串即可 */
  var META = {
    Connect:    { sub: '2 available', right: 'Q1_RandomName', rightSub: 'current' },
    Preference: { sub: '3 available', right: 'Q1_RandomName', rightSub: 'current' },
    Advance:    { sub: '1 available', right: 'Q1_RandomName', rightSub: 'current' },
    /* Settings 左列只有标题和当前选项；右列（已确认的机型）与它无关，整列收掉 */
    Settings:   { sub: 'Appearance' }
  };
  var titleL = panel.querySelectorAll('[data-modal-title]');
  var subL   = panel.querySelectorAll('[data-modal-sub]');
  var foot   = panel.querySelector('[data-modal-foot]');
  var head   = panel.querySelector('.modal__head');
  var headEnd = panel.querySelector('[data-head-end]');
  /* 左下角 HUD 的设备名：connect 的「当前设备」落到哪里，它就跟到哪里。
     HUD 在脚本跑之前就已入 DOM，这里直接抓，抓不到（结构改动）就静默跳过 */
  var hudDevice = document.querySelector('[data-hud-device]');
  /* 限宽跑马灯：名字放得下就还原成单份；放不下就复制一份拼成
     「名字 空隙 名字 空隙」，整条轨道向左平移一份的宽度——动画走完
     正好回到起点，接缝两侧间距一致，读起来是无缝循环。
     时长按 32px/s 的速度随宽度走，宽名字转得慢、节奏不变 */
  window.hudName = function (name) {
    var box = document.querySelector('.hud__name');
    var track = hudDevice;
    if (!box || !track) return;
    /* is-loop 挂在外层盒上，CSS 的选择器是 .hud__name.is-loop .hud__name-track；
       挂到 track 自己身上选择器永远匹配不上，动画就不会启动 */
    box.classList.remove('is-loop');
    track.style.animationDuration = '';
    track.textContent = name || '';
    if (track.scrollWidth <= box.clientWidth) return;
    /* 循环态：两份都用同一款 hud__name-copy（各自带 16px 右距）拼装，
       轨道两半严格等宽 —— translateX(-50%) 恰好平移一份的宽度，
       接缝两侧间距一致，周期跳回起点时画面完全重合，不会顿一下。
       之前只有副本带右距，两半不等宽：名字之间没间隔、周期末还会跳帧 */
    track.textContent = '';
    var copy = document.createElement('span');
    copy.className = 'hud__name-copy';
    copy.textContent = name;
    var ghost = copy.cloneNode(true);
    ghost.setAttribute('aria-hidden', 'true');
    track.appendChild(copy);
    track.appendChild(ghost);
    box.classList.add('is-loop');
    track.style.animationDuration = (track.scrollWidth / 2 / 32).toFixed(2) + 's';
  };
  function paintDevice(name) {
    titleL[1].textContent = name;
    if (window.hudName) window.hudName(name);
    else if (hudDevice) hudDevice.textContent = name;
  }

  /* 右上的主题色标题是「已确认」的机型，不是「正在选」的那一行：
     选别的行只改左侧高亮，右上要等 Confirm 才换。
     confirmed 为 null 表示还没确认过任何一次，此时取初始选中行当现状 */
  var confirmed = null;

  /* 把「当前弹窗对应的那枚胶囊」标成激活（data-open），
     文件尾部的按压脚本读到它就不再给这枚胶囊压弹 ——
     弹窗开着时反复点同一枚，只是重写一遍文案，没有任何动画。
     name 传空表示没有打开的弹窗，全部清掉 */
  function markPill(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.pill'), function (p) {
      if (name && p.textContent.trim() === name) p.setAttribute('data-open', 'true');
      else p.removeAttribute('data-open');
    });
  }

  function paint(name) {
    var m = META[name] || {};
    titleL[0].textContent = name;
    subL[0].textContent   = m.sub || '';
    if (confirmed === null) {
      var sel0 = document.querySelector('[data-model-list] .mrow.is-sel');
      confirmed = (sel0 && sel0.dataset.model) || m.right || '';
    }
    paintDevice(confirmed);
    subL[1].textContent   = m.rightSub || '';
    panel.setAttribute('aria-label', name);
    /* 从一个弹窗直接换到另一个时，先把上一个胶囊那组还原：
       不然从 Settings 切到 Connect、再关窗，Settings 那枚会一直亮着。
       同名重播（再点一次当前这枚）不能还原，否则按钮会先灭一下 */
    restorePills(name);
    markPill(name);
    /* 机型列表与页脚都只属于 Connect：换到别的弹窗时整块收掉，
       别留一条空白按钮区或一片空列表 */
    Array.prototype.forEach.call(panel.querySelectorAll('[data-connect-only]'), function (el) {
      el.hidden = name !== 'Connect';
    });
    /* Settings 是另一种版式：标题在左区，整块顶部标题区收掉，
       原来的 64px 让给左右两栏 */
    var isSet = name === 'Settings';
    Array.prototype.forEach.call(panel.querySelectorAll('[data-settings-only]'), function (el) {
      el.hidden = !isSet;
    });
    if (head) head.hidden = isSet;
    headEnd.hidden = isSet;   /* 右上那列讲的是机型，Settings 用不上 */
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

  /* 阴影通道：与栏体 pop() 同一组数值（柔光 16 → 32、透明度 .10 → .20），
     时长也共用 UP_DUR / BACK_DUR，阴影和形变一起鼓、一起落 */
  var SH_BASE   = '16px';   /* 常态柔光半径，与 CSS 的 --sh 初值一致 */
  var SH_MAX    = '32px';   /* 撑开时的柔光半径：翻一倍，浮起感靠这一下 */
  var SH_A_BASE = 0.1;      /* 常态透明度，与 CSS 的 --sh-a 初值一致 */
  var SH_A_MAX  = 0.2;      /* 撑开时再加 0.1，阴影同时变宽变实 */
  var SH_UP     = UP_DUR;   /* 冲到最鼓的时长 */
  var SH_BACK   = BACK_DUR; /* 落回常态的时长，与缩放同时结束 */
  var SH_CLOSE  = SH_CLOSE_DUR;   /* 收回时归位，与栏体同值 .2 */

  var tl = null, shown = false, closing = false;

  /* 弹窗胶囊的选中态只活到弹窗关掉为止。
     开窗前的 pointerdown 先记下那一组本来选中的是哪一枚（相机与 Modal 那组、
     控制组、账号菜单各自独立），关窗时再按它还原 —— 不记这一笔的话，
     点过 Settings 之后那枚会一直亮着：它只是开弹窗的入口，不是切到了常驻视图。
     用 pointerdown 而不是 click，因为按钮自己的组内单选也挂在 click 上，
     同一元素上按注册顺序先跑，等 click 走到这里选中态已经换过一遍了。
     弹窗已经开着时不再记录：那是从一个弹窗换到另一个，要还原的仍是头一次开窗前的样子 */
  document.addEventListener('pointerdown', function (e) {
    if (shown) return;
    var pill = e.target.closest && e.target.closest('.pill');
    if (!pill) return;
    var lab = pill.querySelector('.pill__label');
    if (!lab || NAMES.indexOf(lab.textContent.trim()) < 0) return;
    var box = pill.closest('.group, .user__menu');
    if (!box) return;
    var cur = box.querySelector('.pill.is-active');
    box.dataset.prevActive = cur ? cur.querySelector('.pill__label').textContent.trim() : '';
  }, true);

  /* 按记下的那一枚还原：空串表示开窗前这一组谁都没选中，全部熄灭。
     keep 是「这次要留下的那一枚」，换弹窗时传新的名字，免得把刚点亮的那组也还原掉 */
  function restorePills(keep) {
    Array.prototype.forEach.call(document.querySelectorAll('.pill[data-open]'), function (p) {
      var lab = p.querySelector('.pill__label');
      if (keep && lab && lab.textContent.trim() === keep) return;
      var box = p.closest('.group, .user__menu');
      if (!box) return;
      var prev = box.dataset.prevActive || '';
      Array.prototype.forEach.call(box.querySelectorAll('.pill'), function (x) {
        var l = x.querySelector('.pill__label');
        var on = !!l && l.textContent.trim() === prev;
        x.classList.toggle('is-active', on);
        x.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      delete box.dataset.prevActive;
    });
  }

  /* 形变 + 阴影这一对通道，打开与「换胶囊重播」共用同一套节拍。
     调用前面板应已在挤窄态、阴影在常态；两段式与栏体 pop() 逐帧等价 */
  function squashChannel(t) {
    return t
      .to(panel, { scaleX: PEAK_X, scaleY: PEAK_Y, duration: UP_DUR, ease: 'power2.out' }, 0)
      .to(panel, { scaleX: 1, scaleY: 1, duration: BACK_DUR, ease: SQUASH_EASE }, UP_DUR)
      /* --sh / --sh-a 是 @property 注册过的 <length> / <number>，可以直接补间 */
      .to(panel, { '--sh': SH_MAX, '--sh-a': SH_A_MAX, duration: SH_UP, ease: 'power2.out' }, 0)
      .to(panel, { '--sh': SH_BASE, '--sh-a': SH_A_BASE, duration: SH_BACK, ease: SQUASH_EASE }, SH_UP);
  }

  function show() {
    shown = true;
    closing = false;              /* 新一轮打开，页脚的「只触发一次」放行 */
    root.style.visibility = 'visible';
    root.setAttribute('aria-hidden', 'false');
    if (tl) tl.kill();
    gsap.killTweensOf(panel);
    /* 起手落在挤窄态：这一步不可见，面板此时 opacity 还是 0。
       阴影一起回到常态，避免上一次收回被打断时带着 32px 的柔光起手 */
    gsap.set(panel, { opacity: 0, scaleX: SQUASH_X, scaleY: SQUASH_Y });
    gsap.set(panel, { '--sh': SH_BASE, '--sh-a': SH_A_BASE });
    if (reduce.matches) {
      gsap.set(panel, { opacity: 1, scaleX: 1, scaleY: 1 });
      return;
    }
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
    if (reduce.matches) {
      gsap.set(panel, { opacity: 0 });
      gsap.set(panel, { '--sh': SH_BASE, '--sh-a': SH_A_BASE });
      root.style.visibility = 'hidden';
      return;
    }
    tl = gsap.timeline({
      onComplete: function () {
        if (!shown) root.style.visibility = 'hidden';   /* 期间又被点开就保持可见 */
      }
    });
    /* 收回的内容通道走 CLOSE_DUR，两轴各取收回专用值，比打开起手更扁 */
    tl.to(panel, {
      opacity: 0, scaleX: CLOSE_X, scaleY: CLOSE_Y,
      duration: CLOSE_DUR, ease: PANEL_IN
    }, 0);
    /* 阴影归位和栏体收回一样是 .2 power2.out：套 panelIn（前段几乎不动）的话，
       阴影会是被裁掉而不是收回去的 */
    tl.to(panel, { '--sh': SH_BASE, '--sh-a': SH_A_BASE, duration: SH_CLOSE, ease: 'power2.out' }, 0);
  }

  /* 这几枚胶囊开弹窗；Camera / Modal 与账号菜单里其余两项保持原样。
     点菜单项不收起账号面板：选中哪一项就留在哪一项上，面板只在点空白与 Esc 时收。
     高亮交给账号面板自己那套组内单选（点谁亮谁），这里不再插手，
     否则会在同一次点击里先亮起来又被抹掉，闪一下 */
  Array.prototype.forEach.call(document.querySelectorAll('.pill'), function (pill) {
    var label = pill.querySelector('.pill__label');
    if (!label || NAMES.indexOf(label.textContent.trim()) < 0) return;
    pill.addEventListener('click', function () {
      /* 文案在动画之前写入：起手那一帧面板还不可见，换字不会被看见 */
      paint(label.textContent.trim());
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
      gsap.set(panel, { opacity: 1, scaleX: 1, scaleY: 1 });
      gsap.set(panel, { '--sh': SH_BASE, '--sh-a': SH_A_BASE });
    });
  });

  /* 页脚两枚：Cancel 只关闭；Confirm 只落定，不关窗 ——
     把列表里当前选中的机型记成 confirmed、换上右上的主题色名字，
     再派一个 modal:confirm（detail 里带弹窗名和机型名），面板留在原地。
     Cancel 的收回时机提前到 pointerdown —— click 要等抬起，按下的那一刻面板就该开始收，
     这样按钮的按压回弹和面板的收回是并行的，不会出现「按钮弹完了窗还开着」。
     click 只留给键盘（Enter / Space 的 click 其 detail 为 0），
     指针那次已被 closing 标志挡掉，同一次操作不会跑两遍 */
  function fire(btn) {
    if (btn.dataset.act === 'confirm') {
      var sel = document.querySelector('[data-model-list] .mrow.is-sel');
      if (sel && sel.dataset.model) {
        confirmed = sel.dataset.model;
        paintDevice(confirmed);
      }
      root.dispatchEvent(new CustomEvent('modal:confirm', {
        detail: { name: panel.getAttribute('aria-label'), model: confirmed }
      }));
      return;   /* 不 hide()：确认后面板继续开着，还能接着改选 */
    }
    if (closing) return;
    closing = true;
    hide();
  }
  if (foot) {
    foot.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var btn = e.target.closest && e.target.closest('[data-act]');
      if (btn) fire(btn);
    });
    foot.addEventListener('click', function (e) {
      if (e.detail !== 0) return;   /* 指针的 click 已在 pointerdown 里处理过 */
      var btn = e.target.closest && e.target.closest('[data-act]');
      if (btn) fire(btn);
    });
  }

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

  /* 就地改名若改的正是已确认的那台机型，confirmed 与两处展示
     （connect 右上、左下角 HUD）一起跟过去；model:rename 从列表带
     bubbles 派发，document 上接得住 */
  document.addEventListener('model:rename', function (e) {
    var d = e.detail || {};
    if (confirmed !== null && confirmed === d.from) paintDevice(d.to);
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
    if (panel.getAttribute('aria-label') === 'Settings') subL[0].textContent = key.replace(/^./, function (c) {
      return c.toUpperCase();
    });
  }
  Array.prototype.forEach.call(tabs, function (t) {
    t.addEventListener('click', function () { pickTab(t.dataset.setTab); });
  });

  /* 明暗模式：day / night，切的是 <html> 上的 data-theme，颜色全部由 :root 那套
     变量带出来，night 就是预留给深色的那一组。首帧之前 <head> 里已经按存下的选择
     设过一次，这里只负责按钮状态与记住选择；背景画布的底色和点阵色阶由背景脚本
     监听同一个属性自己重铺，不用在这里通知它 */
  var MODE_KEY = 'px.mode';
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
     旧版存过 matrix 的，读进来一律当 plain（旧 plain 那种纯静态点阵已经删掉） */
  var BG_KEY = 'px.bg';
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
})();
