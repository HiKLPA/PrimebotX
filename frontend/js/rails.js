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
    rail.classList.add('is-open');
    rail.querySelectorAll('.item').forEach(function (i) {
      const on = i === item;
      i.classList.toggle('is-active', on);
      i.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    /* 面板内容按选中项切视图：Pinned 三组全列，其余只留本类卡片 */
    const body = rail.querySelector('[data-panel-body]');
    if (body) {
      body.dataset.view = (item.dataset.panel || '').toLowerCase();
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
   状态写在 localStorage，刷新后还在；键是「分组:编号」，同一编号在三个分组里各算一张 */
(function () {
  var KEY = 'primebot:pinned';
  var CONFIRM_MS = 2800;   /* 对勾停留多久后自动退回「已钉」态 */
  var pinned = Object.create(null);
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (Array.isArray(saved)) saved.forEach(function (k) { pinned[k] = true; });
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

  /* 一组里一张都没钉 → 整组收起（CSS 里 .is-vacant 只在 pinned 视图生效）；
     全页都没钉 → data-pin-empty 让面板出一行提示 */
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

  Array.prototype.forEach.call(document.querySelectorAll('[data-panel-body]'), function (body) {
    var cards = body.querySelectorAll('.sc');
    if (!cards.length) return;
    Array.prototype.forEach.call(cards, function (card) {
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
        paint(body);
        /* 显示/隐藏改了高度与滚动行程，带着标题补间一起重量 */
        body.dispatchEvent(new CustomEvent('pinchange'));
      });
    });
    paint(body);
  });

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
