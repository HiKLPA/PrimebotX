/* 按下时的微弱弹性压弹：只补间 --press（一个无单位倍数），
   底片按 1 - --press × --press-k 等比缩放，四周收得一样多；
   按下缩进一格，抬起用 elastic 回弹并轻微过冲；
   文字、图标、hover 放大逻辑都不参与，避免和 transform 过渡打架。 */
(function () {
  if (!window.gsap) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  /* 仿真面板里的胶囊（手臂/腰/腿/联动、姿态/动作/步态、右侧工具按钮）、
     弹窗右上角的连接按钮、左栏编辑页的类型三选与提交钮，
     同样是「底片 + --press」结构，一并接管 */
  var SEL = '.pill, .item, .mrow__btn, .chat__btn, .seg__opt, .dock__btn,' +
            '.adv__tab, .adv__chip, .adv__btn, .modal__act-btn,' +
            '.edit__type, .edit__reset, .edit__add';
  var PRESS_PILL = 1.0;   // 顶栏胶囊压入档位（× --press-k 得缩放比例）
  var PRESS_MENU = 1.2;   // 账号面板菜单项
  var PRESS_ITEM = 1.2;   // 侧栏圆钮
  var DOWN = 0.15;        // 压入时长
  var UP = 0.5;           // 回弹时长
  var EASE_DOWN = 'power2.out';
  var EASE_UP = 'elastic.out(1, 0.6)';   // 幅度小、振荡快，回弹只有一下

  var state = new WeakMap();
  var pressed = null;

  function depth(el) {
    if (el.closest('.user__menu')) return PRESS_MENU;
    /* 侧栏圆钮、弹窗行内圆钮、聊天区圆钮同规格，压入深度也取同一档 */
    if (el.classList.contains('item') || el.classList.contains('mrow__btn') ||
        el.classList.contains('chat__btn') || el.classList.contains('dock__btn')) return PRESS_ITEM;
    return PRESS_PILL;
  }
  /* 已经处于激活态的按钮再点一次只是取消或重复，不再重播压弹：
     侧栏已展开的那一项（is-active）、行内已置顶的那一颗（is-on）、
     顶栏已选中的胶囊（aria-pressed="true"）、以及正开着对应弹窗的那枚胶囊
     （data-open，由弹窗脚本在 paint / hide 里写）都算激活 */
  function activated(el) {
    if (el.dataset && el.dataset.open === 'true') return true;
    if (el.classList.contains('is-active') || el.classList.contains('is-on')) return true;
    /* 已经选中的分组 tab（is-sel）同理：再点一次只是重复选同一组 */
    if (el.classList.contains('is-sel')) return true;
    /* 背景三选一里已选中的那枚同理：再点一次是重复，不再压弹 */
    if (el.classList.contains('seg__opt') && el.getAttribute('aria-checked') === 'true') return true;
    return el.classList.contains('pill') && el.getAttribute('aria-pressed') === 'true';
  }
  function tween(el, to, dur, ease, done) {
    var s = state.get(el);
    if (!s) { s = { v: 0 }; state.set(el, s); }
    gsap.to(s, {
      v: to, duration: dur, ease: ease, overwrite: true,
      onUpdate: function () { el.style.setProperty('--press', s.v.toFixed(3)); },
      onComplete: done
    });
  }
  /* 连续快速点击时，把上一枚弹到一半的直接归位，避免它卡在收缩状态 */
  function settle(el) {
    var s = state.get(el);
    if (s) { gsap.killTweensOf(s); s.v = 0; }
    el.style.removeProperty('--press');
    el.classList.remove('is-press');
  }
  function release() {
    if (!pressed) return;
    var el = pressed;
    pressed = null;
    tween(el, 0, UP, EASE_UP, function () {
      el.classList.remove('is-press');       // 交回 CSS：hover 的 transform 过渡恢复
      el.style.removeProperty('--press');
      var s = state.get(el);
      if (s) s.v = 0;
    });
  }

  document.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var el = e.target.closest && e.target.closest(SEL);
    if (!el || el.disabled) return;
    /* data-no-press：逐例豁免。当前没有胶囊用它 —— 页面上带胶囊底片的按钮
       全部接入按压；留着这个开关是为了以后某枚确实不该动的按钮 */
    if (el.hasAttribute('data-no-press')) return;
    /* 已激活的按钮（点第二次只是收起 / 取消）不重播压弹，直接放行 */
    if (activated(el)) return;
    if (pressed && pressed !== el) settle(pressed);
    pressed = el;
    el.classList.add('is-press');   // 关掉这条 transform 过渡，几何交给 GSAP 逐帧写
    tween(el, depth(el), DOWN, EASE_DOWN);
  }, true);

  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
})();
