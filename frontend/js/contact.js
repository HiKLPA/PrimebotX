/* Contact 胶囊：两段式仓库入口，不再开弹窗。
   第一下不跳转，只把按钮上的字换成仓库地址 —— 先让你看清要去哪；
   在同一个按钮上再点一次，才真的在新标签页打开 GitHub。
   点完把指针移开、在按钮外停满 3 秒，文字退回 Contact。
   这段停留给用户留下确认与反悔的时间。 */
(function () {
  var pill = document.querySelector('.pill[data-contact]');
  if (!pill) return;
  var label = pill.querySelector('.pill__label');
  if (!label) return;

  /* 跳转用完整地址，显示用的那一行去掉协议头，和原先 Contact 页里那行链接文字一致 */
  var REPO = 'https://github.com/HiKLPA/PrimebotX';
  var LINK_TEXT = 'github.com/HiKLPA/PrimebotX';
  var HOLD_MS = 3000;

  var armed = false;
  var timer = 0;
  var swapTimer = 0;      /* 换字中间那一下的定时器（先淡出、再改字） */
  var swapToken = 0;      /* 连着切两次时，只让最后那一次落地 */

  /* 换字分两拍：先把当前这行淡出（0.11s），换掉文案与链接态，再淡入 0.16s。
     长度和 topbar.css 里 pill-swap-out 一致，改时长要两边一起改 */
  var SWAP_OUT = 110;
  var SWAP_IN = 180;

  function clearSwap() {
    if (swapTimer) {
      clearTimeout(swapTimer);
      swapTimer = 0;
    }
  }

  /* 把文字与状态一起写到位：链接态挂在 pill 上，字号、左右内边距都跟着它走。
     账号菜单里那套组内单选（rails.js）是点谁给谁挂 is-active；
     这枚胶囊已经不打开任何面板，亮不亮只该由 armed 决定，所以在这里收回来 */
  function settle() {
    label.textContent = armed ? LINK_TEXT : t('nav.contact');
    pill.classList.toggle('is-link', armed);
    pill.classList.remove('is-active');
    pill.setAttribute('aria-pressed', 'false');
  }

  /* animate = 是否需要走那段淡出淡入。首屏、切语言时直接落字，不动画 */
  function paint(animate) {
    /* 菜单那套组内单选会在点击时抢先挂上 is-active，这里立刻收回：
       它管的是「选中」，与换字无关，放在动画之后收会让胶囊先亮一下再灭 */
    pill.classList.remove('is-active');
    pill.setAttribute('aria-pressed', 'false');

    var next = armed ? LINK_TEXT : t('nav.contact');
    if (!animate || label.textContent === next) {
      clearSwap();
      swapToken += 1;
      pill.classList.remove('is-swap-out', 'is-swap-in');
      settle();
      return;
    }

    var token = ++swapToken;
    clearSwap();
    pill.classList.remove('is-swap-in');
    pill.classList.add('is-swap-out');
    swapTimer = setTimeout(function () {
      swapTimer = 0;
      if (token !== swapToken) return;
      /* 旧字已经淡到看不见了，这时候换文案与链接态，字号跳变不会被看到 */
      settle();
      pill.classList.remove('is-swap-out');
      pill.classList.add('is-swap-in');
      setTimeout(function () {
        if (token === swapToken) pill.classList.remove('is-swap-in');
      }, SWAP_IN);
    }, SWAP_OUT);
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  }

  function disarm() {
    stop();
    if (!armed) return;
    armed = false;
    paint(true);
  }

  /* 起表：从这一刻算，满 3 秒退回 Contact。重复调用只是重置时钟 */
  function schedule() {
    if (!armed) return;
    stop();
    timer = setTimeout(disarm, HOLD_MS);
  }

  function arm(live) {
    armed = true;
    paint(true);
    /* live = 点下去的时候指针确实压在按钮上（鼠标、触屏）：那就等 pointerleave 再起表，
       人还在看这个地址，不该在他眼皮底下换字。
       键盘回车没有指针可等，当场开始倒计时 */
    if (!live) timer = setTimeout(disarm, HOLD_MS);
  }

  pill.addEventListener('click', function (event) {
    event.preventDefault();
    if (!armed) {
      arm(event.detail > 0 && pill.matches(':hover'));
      return;
    }
    /* 第二下才真的走：新标签页打开，第三个参数带上 noopener / noreferrer，
       新页拿不到本页的 window.opener */
    window.open(REPO, '_blank', 'noopener,noreferrer');
    disarm();
  });

  /* 指针离开胶囊就开始倒计时；中途移回按钮上把时钟作废，离开时重新起表 */
  pill.addEventListener('pointerleave', schedule);
  pill.addEventListener('pointerenter', function () {
    if (armed) stop();
  });
  /* 菜单被收起时 pointerleave 不一定还会来（胶囊跟着面板一起失去命中），
     所以点到别处也算「人走了」；点在这枚胶囊自己身上不算 */
  document.addEventListener('pointerdown', function (event) {
    if (armed && !pill.contains(event.target)) schedule();
  }, true);
  /* Esc 收起账号面板，顺手把这枚胶囊也退回原样 */
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && armed) disarm();
  });

  document.addEventListener('langchange', function () { paint(false); });
  paint(false);
})();
