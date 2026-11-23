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
    /* 面板内容按选中项切视图：data-view 取按钮 data-panel 的小写，
       CSS 只留对应的那一页（右栏四页：gestures / emotions / shortcuts / edit） */
    const body = rail.querySelector('[data-panel-body]');
    if (body) {
      body.dataset.view = String((item && item.dataset.panel) || '').toLowerCase();
      body.scrollTop = 0;
      /* 同一个视图名再写到栏体上：页标题那一层（.rail__head）是滚动区的兄弟，
         拿不到 body 的 data-view，得靠栏体上的这一份来选显哪一枚标题 */
      rail.dataset.view = body.dataset.view;
    }
  }

  /* 首屏还没点过任何图标，栏体上先补一份初始视图名，标题才能照常显示 */
  rails.forEach(function (rail) {
    const body = rail.querySelector('[data-panel-body]');
    const view = body && body.dataset.view;
    if (view && !rail.dataset.view) rail.dataset.view = view;
  });

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

/* 右栏动作面板：先用空白卡占好四列的位置，手势与表情模块随后往这些节点里
   填内容（缩略图 / 表情屏），只填不换节点 —— 磁吸脚本在加载时把卡收进自己的
   列表，换掉 DOM 就得重扫一遍。
   手势页 10 张（除左栏那三张动作卡之外的其余手势）、表情页 16 张（四行），
   都是一行四张 */
(function () {
  var COUNTS = { gestures: 10, emotions: 16 };
  document.querySelectorAll('[data-rail-grid]').forEach(function (grid) {
    var total = COUNTS[grid.dataset.railGrid] || 8;
    var html = '';
    for (var i = 0; i < total; i++) {
      html += '<div class="rail__card" aria-hidden="true"></div>';
    }
    grid.innerHTML = html;
  });
})();

/* 快捷指令合集：卡片排在右栏 Shortcuts 页里，两组一次全出 —— 没有钉 / 取钉，
   也不再按组切页。这一段只管新增卡片：编辑页填的类型 / 名字 / 简介从这里落成一张 .sc，
   追加到该组末尾、编号按位置重排；新增的同样进 localStorage，刷新后按顺序重放一遍 */
(function () {
  var STORE = 'primebotx:cards';   /* 新增卡片：{ type, name, brief } */
  var LABEL = { action: 'Action', dialog: 'Dialog' };

  var made = [];
  try {
    var store = JSON.parse(localStorage.getItem(STORE) || '[]');
    if (Array.isArray(store)) made = store.filter(function (c) {
      return c && LABEL[c.type] && c.name;
    });
  } catch (e) {}

  function saveMade() {
    try { localStorage.setItem(STORE, JSON.stringify(made)); } catch (e) {}
  }

  /* 照第一张现成的卡克隆：描边、内层排版、右下圆钮的图标全沿用，
     只换编号、名字、简介三个文本位。表单里填的「简介」落在 .sc__intro 那一行，
     时长那行（.sc__time）自定义卡没有，克隆过来是空的，清掉免得留一段占位文案 */
  var cardTpl = document.querySelector('[data-rail-view="shortcuts"] .sc');

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function gridOf(type) {
    var g = document.querySelector('[data-rail-view="shortcuts"] .sc-group--' + type);
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
    var i = card.querySelector('.sc__id');
    var n = card.querySelector('.sc__brief');
    var b = card.querySelector('.sc__intro');
    var t = card.querySelector('.sc__time');
    if (i) i.textContent = id;
    if (n) n.textContent = name;
    if (b) b.textContent = brief;
    /* 自定义卡没有动作，也就没有时长；模板那张的秒数不能留在新卡上 */
    if (t) t.remove();
    return card;
  }

  function addCard(type, name, brief, keep) {
    var grid = gridOf(type);
    if (!grid || !cardTpl) return null;
    var card = makeCard(pad2(grid.children.length + 1), name, brief);
    grid.appendChild(card);
    renumber(grid);
    /* 磁吸脚本在加载时就收过一遍元素，新插进来的这张要补收 */
    if (window.magnetRescan) window.magnetRescan();
    if (keep) {
      made.push({ type: type, name: name, brief: brief });
      saveMade();
    }
    return card;
  }

  /* 加完得让人当场看见：右栏切到快捷指令页（键在右栏，栏体不在开着的状态就先点开），
     再把这组最后一张 —— 也就是刚加的那张 —— 滚进视野。
     滚动作放在下一帧：点完按钮面板才开始展开，宽度还在 0.3s 的过渡里 */
  function reveal(type) {
    var rail = document.getElementById('rail-tools');
    if (!rail) return;
    var item = rail.querySelector('.item[data-panel="Shortcuts"]');
    var body = rail.querySelector('[data-panel-body]');
    if (!item || !body) return;
    if (!rail.classList.contains('is-open') || body.dataset.view !== 'shortcuts') item.click();
    var grid = gridOf(type);
    var card = grid && grid.lastElementChild;
    if (!card || !card.scrollIntoView) return;
    requestAnimationFrame(function () {
      card.scrollIntoView({ block: 'nearest' });
    });
  }

  /* 上次新增的卡片先补回 DOM */
  if (cardTpl) made.forEach(function (c) { addCard(c.type, c.name, c.brief, false); });

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
  const avatar = user.querySelector('.avatar');

  function setOpen(on) {
    user.classList.toggle('is-open', on);
    /* 收面板时把头像选择区一起收掉：它的展开高度挂在面板高度上，
       留着不关，下次点开胶囊会先看到那块选择条 */
    if (!on) user.classList.remove('is-picking');
    /* 收起态头像被 trigger 盖着，不该被 Tab 选中；展开后它才是独立的一站 */
    if (avatar) avatar.tabIndex = on ? 0 : -1;
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

/* 快捷指令卡触发主页动作：卡上带 data-motion 时，点一下就在主页模型上播放同名动作。
   模型是 6.4MB 的 GLB，比这段脚本晚就绪，早到的点击先记下来，等 robot-ready 补播一次。
   播放期间给卡挂 .is-on（配色与悬停同一套），按时长自己收掉；
   时长读 getGestureInfo，读不到就按默认 4 秒兜底 */
(function () {
  var pending = null;

  function play(id) {
    var api = window.robot3d;
    if (!api || typeof api.playGesture !== 'function') {
      pending = id;
      return false;
    }
    var ok = false;
    try { ok = api.playGesture(id) === true; } catch (e) { ok = false; }
    if (!ok) pending = id;
    return ok;
  }

  window.addEventListener('robot-ready', function () {
    if (!pending) return;
    var id = pending;
    pending = null;
    play(id);
  });

  function bind(card) {
    /* 卡有两种写法：普通动作挂在 data-motion，街舞那张用 data-action-motion */
    var id = card.dataset.motion || card.dataset.actionMotion;
    if (!id) return;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    if (!card.getAttribute('aria-label')) card.setAttribute('aria-label', id);

    function activate() {
      if (!play(id)) return;
      card.classList.add('is-on');
      clearTimeout(card.__motionTimer);
      var info = window.robot3d && window.robot3d.getGestureInfo
        ? window.robot3d.getGestureInfo(id)
        : null;
      var ms = info && info.duration ? info.duration * 1000 + 240 : 4240;
      card.__motionTimer = setTimeout(function () { card.classList.remove('is-on'); }, ms);
    }

    card.addEventListener('click', activate);
    /* 卡里还嵌着图钉，键盘回车在按钮上不算触发卡片 */
    card.addEventListener('keydown', function (e) {
      if (e.target !== card) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      activate();
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.sc[data-motion], .sc[data-action-motion]'), bind);
})();
