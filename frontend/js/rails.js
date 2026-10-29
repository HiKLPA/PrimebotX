/* 折叠栏交互：点击图标 → 所在栏向锚定侧相反方向展开；
   左右两栏各自独立，可以同时展开（每栏内仍只保留一个选中项）；
   只有移动端两栏都贴底、展开会占满整行，那里才保持互斥 */
(function () {
  const rails = Array.from(document.querySelectorAll('.rail'));
  const narrow = window.matchMedia('(max-width: 640px)');

  function close(rail) {
    rail.classList.remove('is-open');
    rail.querySelectorAll('.item').forEach(function (i) {
      i.classList.remove('is-active');
      i.setAttribute('aria-expanded', 'false');
    });
  }

  function open(rail, item) {
    if (narrow.matches) rails.forEach(function (r) { if (r !== rail) close(r); });
    /* 栏体被推到屏外时先唤回来 —— 点图标就是要用这一栏 */
    if (rail.classList.contains('is-hidden')) {
      if (window.railMotion) window.railMotion(rail, false);
      else rail.classList.remove('is-hidden');
      const t = document.querySelector('.rail__toggle[data-rail="' +
        (rail.classList.contains('rail--right') ? 'right' : 'left') + '"]');
      if (t) t.setAttribute('aria-label', 'Hide panel');
    }
    rail.classList.add('is-open');
    rail.querySelectorAll('.item').forEach(function (i) {
      const on = !!item && i === item;
      i.classList.toggle('is-active', on);
      i.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    /* 面板内容按选中项切视图：Pinned 三组全列，其余只留本类卡片，
       Edit 项对应的是同一块面板里的编辑页（表单在 HTML 里，排在卡片组前面） */
    const body = rail.querySelector('[data-panel-body]');
    if (body) {
      body.dataset.view = String((item && item.dataset.panel) || '').toLowerCase();
      body.scrollTop = 0;
    }
  }

  rails.forEach(function (rail) {
    /* 箭头已经搬到栏体外（fixed），用 data-rail 关联回各自的栏 */
    const side = rail.classList.contains('rail--right') ? 'right' : 'left';
    const toggle = document.querySelector('.rail__toggle[data-rail="' + side + '"]');
    if (toggle) {
      toggle.addEventListener('click', function () {
        const hide = !rail.classList.contains('is-hidden');
        close(rail);
        /* 移入移出交给脚本的弹性补间（定义在引入了 GSAP 的那段）；
           还没就绪就退回纯 class 切换，功能不受影响 */
        if (window.railMotion) window.railMotion(rail, hide);
        else rail.classList.toggle('is-hidden', hide);
        toggle.setAttribute('aria-label', hide ? 'Show panel' : 'Hide panel');
      });
    }

    rail.querySelectorAll('.item').forEach(function (item) {
      item.addEventListener('click', function () {
        if (item.classList.contains('is-active')) close(rail);
        else open(rail, item);
      });
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') rails.forEach(close);
  });

  document.addEventListener('pointerdown', function (e) {
    if (!e.target.closest('.rail')) rails.forEach(close);
  });
})();

/* 底部控制面板：只有升降两态。位移与形变的补间在开合那段脚本里
   （.is-open 一变，MutationObserver 就把整条时间轴跑起来），
   这里只管状态、文案与中间那枚播放键的图标 */
(function () {
  var dock = document.querySelector('.dock');
  if (!dock) return;
  var toggle = dock.querySelector('.dock__toggle');
  var play = dock.querySelector('.dock__btn--play');

  /* 左右两列先铺空白卡片占位：各三行、一行四张。
     写在这里而不是 HTML 里，是因为卡片由磁吸脚本在加载时统一收集，
     这段脚本正好排在它前面；以后接真实动作时把这段换成数据渲染即可 */
  dock.querySelectorAll('.dock__grid').forEach(function (grid) {
    var rows = 3, cols = 4, html = '';
    for (var i = 0; i < rows * cols; i++) {
      html += '<div class="dock__card" aria-hidden="true"></div>';
    }
    grid.innerHTML = html;
  });

  if (toggle) {
    toggle.addEventListener('click', function () {
      var open = !dock.classList.contains('is-open');
      /* 升降交给弹性补间（定义在引入 GSAP 的那段）；
         还没就绪就直接切类，CSS 里的终值兜底，功能不受影响 */
      if (window.dockMotion) window.dockMotion(dock, open);
      else dock.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Collapse panel' : 'Expand panel');
    });
  }

  /* 播放 / 暂停只在两枚图标之间换，不接任何播放状态 */
  if (play) {
    play.addEventListener('click', function () {
      var playing = play.classList.toggle('is-playing');
      play.setAttribute('aria-pressed', playing ? 'true' : 'false');
      play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    });
  }
})();

/* 卡片图钉：点一下钉进 Pinned（按所在分组归位）。取钉要两步：
   已钉的卡片第一次点只换成对勾（确认取消），第二次点才真的取出，
   避免在 Pinned 页里误点一下卡片就消失。
   状态写在 localStorage，刷新后还在；键是「分组:编号」，同一编号在三个分组里各算一张。

   这一段还管新增卡片：左栏编辑页填的类型 / 名字 / 简介从这里落成一张 .sc，
   追加到该组末尾、编号按位置重排、当场绑上图钉。新增的卡片同样进 localStorage，
   刷新后按顺序重放一遍，编号因此始终和 pinned 的键对得上 */
(function () {
  var KEY = 'primebot:pinned';
  var STORE = 'primebot:cards';   /* 新增卡片：{ type, name, brief } */
  var CONFIRM_MS = 2800;   /* 对勾停留多久后自动退回「已钉」态 */
  var LABEL = { action: 'Action', dialog: 'Dialog', tendance: 'Tendance' };
  var pinned = Object.create(null);
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (Array.isArray(saved)) saved.forEach(function (k) { pinned[k] = true; });
  } catch (e) {}

  var made = [];
  try {
    var store = JSON.parse(localStorage.getItem(STORE) || '[]');
    if (Array.isArray(store)) made = store.filter(function (c) {
      return c && LABEL[c.type] && c.name;
    });
  } catch (e) {}

  function keyOf(card) {
    var g = card.closest('.sc-group');
    var m = g ? /sc-group--([a-z]+)/.exec(g.className) : null;
    var id = card.querySelector('.sc__id');
    return (m ? m[1] : 'x') + ':' + (id ? id.textContent.trim() : '');
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(Object.keys(pinned))); } catch (e) {}
  }

  function saveMade() {
    try { localStorage.setItem(STORE, JSON.stringify(made)); } catch (e) {}
  }

  /* 退出确认态，标签回到「已钉」该有的 Unpin */
  function resetConfirm(card) {
    if (!card.classList.contains('is-confirm-unpin')) return;
    card.classList.remove('is-confirm-unpin');
    clearTimeout(card.__pinTimer);
    var b = card.querySelector('.sc__pin');
    if (b) b.setAttribute('aria-label', card.classList.contains('is-pinned') ? 'Unpin' : 'Pin');
  }

  function askConfirm(card) {
    resetConfirm(card);
    card.classList.add('is-confirm-unpin');
    var b = card.querySelector('.sc__pin');
    if (b) b.setAttribute('aria-label', 'Confirm unpin');
    card.__pinTimer = setTimeout(function () { resetConfirm(card); }, CONFIRM_MS);
  }

  /* 一组里一张都没钉 → 整组收起（CSS 里 .is-vacant 只在 pinned 视图生效）。
     全页一张都没有时面板就空着，此时给一段空态说明（.panel__empty），
     判据挂在 body 的 data-pin-empty 上，样式那边只认 pinned 视图 */
  function paint(body) {
    var total = 0;
    body.querySelectorAll('.sc-group').forEach(function (g) {
      var any = false;
      g.querySelectorAll('.sc').forEach(function (c) {
        if (pinned[c.dataset.pinKey]) { any = true; total++; }
      });
      g.classList.toggle('is-vacant', !any);
    });
    body.setAttribute('data-pin-empty', total ? '0' : '1');
  }

  /* 绑定一张卡片的图钉行为。新增的卡片插进来之后也要走这一段，
     所以从原来的遍历里提出来，用 __pinBound 防止重复挂事件 */
  function bindCard(card) {
    if (card.__pinBound) return;
    card.__pinBound = true;

    var body = card.closest('[data-panel-body]');
    var k = keyOf(card);
    var btn = card.querySelector('.sc__pin');
    card.dataset.pinKey = k;

    function show(on) {
      card.classList.toggle('is-pinned', on);
      if (!btn) return;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', on ? 'Unpin' : 'Pin');
    }

    show(!!pinned[k]);
    if (!btn) return;
    /* 指针离开卡片就撤掉确认态，避免对勾挂着不动 */
    card.addEventListener('mouseleave', function () { resetConfirm(card); });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      /* 冒泡被截断了，这里手动把别的卡片的确认态收掉 */
      document.querySelectorAll('.sc.is-confirm-unpin').forEach(function (c) {
        if (c !== card) resetConfirm(c);
      });
      var on = card.classList.contains('is-pinned');
      /* 已钉且还没进确认态 → 这一下只换成对勾，不改数据 */
      if (on && !card.classList.contains('is-confirm-unpin')) {
        askConfirm(card);
        return;
      }
      resetConfirm(card);
      on = !on;
      show(on);
      if (on) pinned[k] = true; else delete pinned[k];
      save();
      if (body) {
        paint(body);
        /* 显示/隐藏改了高度与滚动行程，带着标题补间一起重量 */
        body.dispatchEvent(new CustomEvent('pinchange'));
      }
    });
  }

  /* ---- 新增卡片 ---- */
  /* 照第一张现成的卡克隆：描边、内层排版、两枚圆钮的图标全沿用，
     只换编号、名字、简介三个文本位。模板在 pinned 视图里可能被隐藏，节点仍在 */
  var cardTpl = document.querySelector('[data-panel-body] .sc');

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function gridOf(type) {
    var g = document.querySelector('.panel__body .sc-group--' + type);
    return g ? g.querySelector('.sc-grid') : null;
  }

  /* 编号是「组内第几张」：插入后整组按顺序重排一次，插在中间也不撞号 */
  function renumber(grid) {
    Array.prototype.forEach.call(grid.children, function (card, i) {
      var id = card.querySelector('.sc__id');
      if (id) id.textContent = pad2(i + 1);
    });
  }

  function makeCard(id, name, brief) {
    var card = cardTpl.cloneNode(true);
    card.classList.remove('is-pinned', 'is-confirm-unpin');
    card.removeAttribute('data-pin-key');
    card.__pinBound = false;
    var i = card.querySelector('.sc__id');
    var n = card.querySelector('.sc__brief');
    var b = card.querySelector('.sc__time');
    var p = card.querySelector('.sc__pin');
    if (i) i.textContent = id;
    if (n) n.textContent = name;
    if (b) b.textContent = brief;
    if (p) {
      p.setAttribute('aria-pressed', 'false');
      p.setAttribute('aria-label', 'Pin');
    }
    return card;
  }

  function addCard(type, name, brief, keep) {
    var grid = gridOf(type);
    if (!grid || !cardTpl) return null;
    var card = makeCard(pad2(grid.children.length + 1), name, brief);
    grid.appendChild(card);
    renumber(grid);
    bindCard(card);

    /* 新卡片是未钉状态：pinned 视图下它自己不显示，但组的空壳判定要重跑 */
    var body = card.closest('[data-panel-body]');
    if (body) {
      paint(body);
      body.dispatchEvent(new CustomEvent('pinchange'));
    }
    /* 磁吸脚本在加载时就收过一遍元素，新插进来的这张要补收 */
    if (window.magnetRescan) window.magnetRescan();
    if (keep) {
      made.push({ type: type, name: name, brief: brief });
      saveMade();
    }
    return card;
  }

  /* 加完得让人当场看见：把同一块面板切到该组。
     编辑页和卡片组现在共用左栏这一块面板，所以这一步只是换 data-view，
     不涉及栏体开合 —— 窄屏也一样适用 */
  function reveal(type) {
    var rail = document.getElementById('rail-shortcuts');
    if (!rail) return;
    var item = rail.querySelector('.item[data-panel="' + LABEL[type] + '"]');
    if (!item) return;
    var body = rail.querySelector('[data-panel-body]');
    /* 已经停在这一组就别点：这一下会把它收起 */
    if (rail.classList.contains('is-open') && body && body.dataset.view === type) return;
    item.click();
  }

  /* 上次新增的卡片先补回 DOM，再统一绑定（绑定循环扫的是全部 .sc） */
  if (cardTpl) made.forEach(function (c) { addCard(c.type, c.name, c.brief, false); });

  Array.prototype.forEach.call(document.querySelectorAll('[data-panel-body]'), function (body) {
    var cards = body.querySelectorAll('.sc');
    if (!cards.length) return;
    Array.prototype.forEach.call(cards, bindCard);
    paint(body);
  });

  /* ---- 编辑页：先选类型，再填名字与简介 ---- */
  (function () {
    var root = document.querySelector('[data-edit-only]');
    if (!root) return;
    var types = Array.prototype.slice.call(root.querySelectorAll('[data-edit-type]'));
    var nameIn = root.querySelector('[data-edit-name]');
    var briefIn = root.querySelector('[data-edit-brief]');
    var submit = root.querySelector('[data-edit-add]');
    var reset = root.querySelector('[data-edit-reset]');
    var type = types.length ? types[0].dataset.editType : 'action';

    function pick(btn) {
      type = btn.dataset.editType;
      types.forEach(function (b) {
        var on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    types.forEach(function (b) {
      b.addEventListener('click', function () { pick(b); });
    });

    /* 名字必填：空着提交只会得到一张第一行空白、看不出是什么的卡片 */
    function commit() {
      if (!nameIn || !briefIn) return;
      var name = nameIn.value.trim();
      var brief = briefIn.value.trim();
      if (!name) { nameIn.focus(); return; }
      addCard(type, name, brief, true);
      reveal(type);
      nameIn.value = '';
      briefIn.value = '';
      nameIn.focus();
    }

    if (submit) submit.addEventListener('click', commit);
    /* 重置：清掉已填的名字与简介，类型回到第一项。只动表单，不碰已加的卡片 */
    if (reset) reset.addEventListener('click', function () {
      if (nameIn) nameIn.value = '';
      if (briefIn) briefIn.value = '';
      if (types.length) pick(types[0]);
      if (nameIn) nameIn.focus();
    });
    /* 输入框里回车即提交；按钮上的回车交给按钮自己，不重复触发 */
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        commit();
      }
    });
  })();

  /* 点了别处也算放弃取钉 */
  document.addEventListener('click', function (e) {
    document.querySelectorAll('.sc.is-confirm-unpin').forEach(function (card) {
      if (!card.contains(e.target)) resetConfirm(card);
    });
  });
})();

/* 顶栏胶囊：组内单选，点击即选中；再次点击当前选中项重复触发按压反馈 */
(function () {
  document.querySelectorAll('.group').forEach(function (group) {
    group.querySelectorAll('.pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        group.querySelectorAll('.pill').forEach(function (p) {
          const on = p === pill;
          p.classList.toggle('is-active', on);
          p.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      });
    });
  });
})();



/* 账号胶囊：点击展开为面板，点击外部 / Esc 收起；菜单项组内单选 */
(function () {
  const user = document.getElementById('account');
  if (!user) return;
  const trigger = user.querySelector('.user__trigger');

  function setOpen(on) {
    user.classList.toggle('is-open', on);
    trigger.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  trigger.addEventListener('click', function () {
    setOpen(!user.classList.contains('is-open'));
  });

  user.querySelectorAll('.user__menu .pill').forEach(function (pill) {
    pill.addEventListener('click', function () {
      user.querySelectorAll('.user__menu .pill').forEach(function (p) {
        const on = p === pill;
        p.classList.toggle('is-active', on);
        p.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    });
  });

  document.addEventListener('pointerdown', function (e) {
    if (!e.target.closest('#account')) setOpen(false);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setOpen(false);
  });
})();
