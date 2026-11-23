/* 把快捷指令卡片（右栏 Shortcuts 页）拖到机器人身上。
   指针按下满 5px 才算拖（不到就还是点击，交给 rails.js 播动作）；
   拖起来时把卡片克隆一份挂到 body 上做影子，原卡从栏里收起来（visibility: hidden，
   位置照旧占着，不放一张半透明的底在那里）。
   拖动期间屏上是下载图标，机器人的头跟着指针转。
   松手落在机器人身上 → 卡片改成浮在摊开的掌心上方（不透明、轻微上下浮动），
   机器人开始「接住 → 思考 2s → 屏上打勾」，勾出来（robot-card 的 release）
   后卡片淡出缩小消失，再由机器人自己播卡上的动作；落在别处 → 影子飞回原位。

   命中判定与右手屏幕坐标都由 robot3d 提供，这里只管 DOM 那一半。 */
(function () {
  var THRESHOLD = 5;      /* 超过这个位移才算拖，否则按点击处理 */
  var PICKED_SCALE = 0.82;/* 托在手上时按卡片的原比例缩一点点，屏上不至于盖住半张脸 */
  var PALM_X = 0.08;      /* 手在卡片中心偏右一点，整张卡略往左让开面罩 */
  var PALM_LIFT = 22;     /* 卡片底边离手心的像素距离：掌心面本身约 9px，再留一道缝 */
  var FLOAT_AMP = 2.6;    /* 悬浮的上下浮动幅度（px） */
  /* 归位用一根阻尼弹簧，而不是「每秒衰减一个固定比例」的指数逼近：
     指数逼近的起步速度是凭空给的（放手那一帧直接从静止窜到最快），
     指针还在往右甩的时候卡片会当场拐回去，读起来就是那一帧「跳」了。
     弹簧从上一次拖动的速度接着走，方向先顺势滑一小段，再被拉回原位。
     OMEGA —— 角频率（rad/s），越大收得越快
     ZETA  —— 略欠阻尼，落位前只轻轻收一下，不来回晃 */
  var RETURN_OMEGA = 17;
  var RETURN_ZETA = 0.9;
  /* 速度估得再准也只是估：狂甩一下能到每秒几千像素，接过来会把卡甩出屏幕 */
  var RETURN_VMAX = 2600;

  var pending = null;     /* 按下但还没到阈值的候选 */
  var state = null;       /* 正在拖的影子 */
  var raf = 0;
  var lastT = 0;
  var suppressClick = false;
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 帧率无关的逼近系数：每秒衰减 rate，折算到这一帧的 dt 上。
     高刷屏与软渲染掉帧时，跟手与淡出的时长都还是同一条曲线 */
  function approach(dt, perSecond) {
    return 1 - Math.pow(perSecond, dt);
  }

  /* 没被磁吸推歪的布局盒：offsetParent 的 rect + offsetLeft/Top。
     卡片被拎着的那一瞬身上还挂着 magnet 写进去的 perspective 与 scale，
     直接量 getBoundingClientRect 拿到的是投影后的盒 —— 宽高都大 2% 左右，
     拿它当影子尺寸，落回原位时就比真卡整整大一圈，接缝一眼能看见。
     这里量的盒子恰好等于卡片摘掉变换后的样子，影子按它收尾就与真卡重合 */
  function layoutBox(el) {
    var p = el.offsetParent || document.body;
    var pr = p.getBoundingClientRect();
    var left = pr.left + el.offsetLeft;
    var top = pr.top + el.offsetTop;
    /* 与 magnet.js 的 boxOf 同一条：offsetParent 自己就是滚动区时
       （桌面端 .panel__body 既是滚动区又是绝对定位盒），它滚过的距离
       不在下面那圈循环里，得单独减，否则影子会落在滚动前的那个位置 */
    if (p.scrollTop) top -= p.scrollTop;
    if (p.scrollLeft) left -= p.scrollLeft;
    for (var n = el.parentElement; n && n !== p; n = n.parentElement) {
      if (n.scrollTop) top -= n.scrollTop;
      if (n.scrollLeft) left -= n.scrollLeft;
    }
    return {left: left, top: top, width: el.offsetWidth, height: el.offsetHeight};
  }

  function hitAt(x, y) {
    var api = window.robot3d;
    if (!api || typeof api.hitTest !== 'function') return false;
    try { return api.hitTest(x, y) === true; } catch (e) { return false; }
  }

  /* 接住之后卡面归场景里那块真卡画，内容得从 DOM 带过去：
     编号、两行字、底色、墨色、字体。影子（克隆件）带着 is-lit，
     此刻的 computed 值就是 hover 态那一套，深浅两套主题都取得到真颜色 ——
     浅色下填充在 ::before 上，深色下则是卡面自己的 background，
     所以底色的取法要看 ::before 有没有在显形 */
  function readCard(node) {
    if (!node) return null;
    var cs = getComputedStyle(node);
    var before = getComputedStyle(node, '::before');
    var id = node.querySelector('.sc__id');
    var brief = node.querySelector('.sc__brief');
    var intro = node.querySelector('.sc__intro');
    var time = node.querySelector('.sc__time');
    var go = node.querySelector('.sc__go');
    var lit = parseFloat(before.opacity) > 0.5;
    var goCs = go ? getComputedStyle(go) : null;
    return {
      id: id ? id.textContent.trim() : '',
      brief: brief ? brief.textContent.trim() : '',
      intro: intro ? intro.textContent.trim() : '',
      time: time ? time.textContent.trim() : '',
      color: (lit ? before.backgroundColor : cs.backgroundColor) || '#6e9182',
      ink: id ? getComputedStyle(id).color : '#fafafa',
      introInk: intro ? getComputedStyle(intro).color : '#fafafa',
      timeInk: time ? getComputedStyle(time).color : '#fafafa',
      btnBg: goCs ? goCs.backgroundColor : '#fafafa',
      btnInk: goCs ? goCs.color : '#6e9182',
      font: cs.fontFamily,
      weight: cs.fontWeight,
    };
  }

  function paint(ts) {
    if (!state) return;
    var dt = lastT ? Math.min(0.032, (ts - lastT) / 1000) : 1 / 60;
    lastT = ts;

    var node = state.node;

    if (state.mode === 'drag') {
      /* 影子就当长在指针上，不做跟随插值，拖起来才是 1:1 */
      var px = state.x, py = state.y;
      state.x = state.tx;
      state.y = state.ty;
      /* 顺手记下这一帧的速度：松手后归位就从这个速度出发。
         单帧位移会被指针事件的疏密放大，和上一帧的估计混一混再存 */
      state.vx = state.vx * 0.6 + ((state.x - px) / dt) * 0.4;
      state.vy = state.vy * 0.6 + ((state.y - py) / dt) * 0.4;
      node.classList.toggle('is-over', hitAt(state.x, state.y));
    } else if (state.mode === 'return') {
      /* 半隐式欧拉走弹簧；一帧超过 1/120 就拆成几步，掉帧时才不会因为
         步长太大把速度积到爆、把卡片甩过原位再弹回来 */
      var vx = state.vx, vy = state.vy;
      var vmax2 = RETURN_VMAX * RETURN_VMAX;
      if (vx * vx + vy * vy > vmax2) {
        var k0 = RETURN_VMAX / Math.sqrt(vx * vx + vy * vy);
        vx *= k0; vy *= k0;
      }
      var steps = Math.max(1, Math.ceil(dt / (1 / 120)));
      var h = dt / steps;
      for (var s = 0; s < steps; s++) {
        vx += (RETURN_OMEGA * RETURN_OMEGA * (state.tx - state.x) - 2 * RETURN_ZETA * RETURN_OMEGA * vx) * h;
        state.x += vx * h;
        vy += (RETURN_OMEGA * RETURN_OMEGA * (state.ty - state.y) - 2 * RETURN_ZETA * RETURN_OMEGA * vy) * h;
        state.y += vy * h;
      }
      state.vx = vx;
      state.vy = vy;
    } else {
      var k = approach(dt, 0.00002);
      state.x += (state.tx - state.x) * k;
      state.y += (state.ty - state.y) * k;
    }

    state.scale += (state.tscale - state.scale) * approach(dt, 0.002);

    if (state.mode === 'hand') {
      var api = window.robot3d;
      var hand = api && typeof api.handScreen === 'function' ? api.handScreen() : null;
      if (hand) {
        /* 掌心朝上摊平，卡片浮在掌面正上方：底边留一道缝，
           再叠一点极慢的上下浮动，读起来是被托着悬在那儿 */
        var hw = state.w * state.tscale;
        var hh = state.h * state.tscale;
        state.tx = hand.x - hw * PALM_X;
        state.ty = hand.y - hh / 2 - PALM_LIFT + Math.sin(performance.now() / 520) * FLOAT_AMP;
      }
      node.style.opacity = 1;
      /* 影子滑到掌心就够了：3D 那张卡已经在掌上亮起来，这张收掉。
         原卡先不复现，等仪式走完 release 再放回栏里 */
      if (state.handT0 && ts - state.handT0 > 150) {
        node.style.opacity = 0;
        state.mode = 'held';
        raf = 0;
        return;
      }
    }

    if (state.mode === 'return') {
      /* 回去的路上不再压暗：原卡是收起来的，这里要一路不透明地落回去，
         贴到原位的那一帧再把原卡放出来，两层才接得上 */
      node.style.opacity = 1;
      /* 位置、余速、尺寸三样都到位才算落定。差一两个像素就换人，
         两层之间会露一道错位的边；这里等到 0.6px 以内，最后一帧
         直接写成原位原尺寸，真卡就在同一个像素上露出来 */
      if (Math.abs(state.tx - state.x) < 0.6 && Math.abs(state.ty - state.y) < 0.6 &&
          Math.abs(state.vx) < 24 && Math.abs(state.vy) < 24 &&
          Math.abs(1 - state.scale) < 0.0015) {
        state.x = state.tx;
        state.y = state.ty;
        state.scale = 1;
        node.style.transform = 'translate3d(' + state.x + 'px,' + state.y + 'px,0)'
          + ' translate(-50%,-50%) scale(1)';
        stop();
        return;
      }
    }

    node.style.transform = 'translate3d(' + state.x + 'px,' + state.y + 'px,0)'
      + ' translate(-50%,-50%) scale(' + state.scale + ')';
    raf = requestAnimationFrame(paint);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (state && state.node && state.node.parentNode) state.node.parentNode.removeChild(state.node);
    if (state && state.card) state.card.classList.remove('is-dragging');
    state = null;
    document.body.classList.remove('is-card-drag');
    /* 原卡是收起来的（.is-dragging），到这一帧才算「放回去」；下载图标与头部跟随也一并收掉 */
    var api = window.robot3d;
    if (api && typeof api.endCardDrag === 'function') api.endCardDrag();
  }

  function begin(card, x, y) {
    /* 量的是布局盒而不是投影盒：卡片这会儿正被磁吸推着（透视 + 1.02 缩放），
       rect 会比真实卡面大一圈，影子照它做，归位时就对不上 */
    var rect = layoutBox(card);
    var cs = getComputedStyle(card);
    var node = card.cloneNode(true);

    node.classList.remove('is-on');
    /* is-lit 就是 hover 那一整套（填充层、文字反白、右下圆钮）。
       影子挂在 body 下、又 pointer-events:none，指针压不到它身上，
       原卡这会儿是 hidden 也不接悬停 —— 不手动点亮，卡从栏里拎出来就熄了 */
    node.classList.add('card-ghost', 'is-lit');
    node.style.width = rect.width + 'px';
    node.style.height = rect.height + 'px';
    /* 克隆件把 magnet 写在原卡上的 perspective 与 scale 一并抄了过来：
       不清掉的话影子自带一层 1.02 的缩放，拖起来比手上这张大一档，
       落回原位那一刻又突然缩回去。影子的几何只由下面这条 transform 说了算 */
    node.style.transform = '';
    node.style.scale = '';
    /* 组的系列色来自祖先 .sc-group，影子挂到 body 下会丢，手动搬一份过来 */
    node.style.setProperty('--sc', cs.getPropertyValue('--sc').trim() || '#91d2c3');
    document.body.appendChild(node);
    card.classList.add('is-dragging');
    document.body.classList.add('is-card-drag');
    node.style.opacity = 1;

    /* 拖起来就把屏上换成下载图标，头开始跟指针 */
    var api = window.robot3d;
    if (api && typeof api.beginCardDrag === 'function') api.beginCardDrag();

    state = {
      card: card,
      node: node,
      w: rect.width,
      h: rect.height,
      x: x,
      y: y,
      tx: x,
      ty: y,
      vx: 0,
      vy: 0,
      scale: 1.04,
      tscale: 1.04,
      opacity: 1,
      mode: 'drag',
      origin: {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2},
    };
    lastT = 0;
    node.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) translate(-50%,-50%) scale(1.04)';
    raf = requestAnimationFrame(paint);
  }

  document.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    if (!e.target.closest) return;
    var card = e.target.closest('.sc');
    if (!card || state) return;
    pending = {card: card, x: e.clientX, y: e.clientY, id: e.pointerId};
  });

  document.addEventListener('pointermove', function (e) {
    if (pending && e.pointerId === pending.id) {
      var dx = e.clientX - pending.x;
      var dy = e.clientY - pending.y;
      if (dx * dx + dy * dy < THRESHOLD * THRESHOLD) return;
      var card = pending.card;
      pending = null;
      /* 这一下之后浏览器还会补一次 click，别让它把动作提前播了 */
      suppressClick = true;
      begin(card, e.clientX, e.clientY);
      return;
    }
    if (state && state.mode === 'drag') {
      state.tx = e.clientX;
      state.ty = e.clientY;
    }
  });

  function release(e) {
    if (pending) { pending = null; return; }
    if (!state || state.mode !== 'drag') return;

    /* 指针可能在两次重绘之间又走了一小段：松手这一刻把影子对齐到放手点，
       回程从指尖出发，而不是从上一帧画的落点出发 */
    state.x = state.tx;
    state.y = state.ty;

    var card = state.card;
    var over = hitAt(e.clientX, e.clientY);
    var api = window.robot3d;
    /* 街舞那张挂在 data-action-motion 上（它在 rails.js 里走另一套绑定），
       两个属性都要认，否则接住之后仪式走完没有动作可播 */
    var motionId = card.dataset.motion || card.dataset.actionMotion || '';
    var picked = over && api && typeof api.pickUpCard === 'function'
      ? api.pickUpCard(motionId, readCard(state.node))
      : false;

    /* 松手就收掉下载图标：接住了要马上换成思考脸，没接住也别拖着这张图飞回去 */
    if (api && typeof api.endCardDrag === 'function') api.endCardDrag();

    if (picked) {
      /* 先让影子滑到掌心（3D 卡那边晚 120ms 才亮），到点把影子收掉换真卡。
         原卡仍收在栏里，等仪式走完 reward 的 release 再放回来 */
      state.mode = 'hand';
      state.tscale = PICKED_SCALE;
      state.handT0 = performance.now();
      state.node.classList.add('is-picked');
      state.node.classList.remove('is-over');
      state.node.style.opacity = 1;
      document.body.classList.remove('is-card-drag');
      return;
    }

    state.mode = 'return';
    state.tscale = 1;
    state.tx = state.origin.x;
    state.ty = state.origin.y;
    /* 飞回去这一路不再亮着：落回原位时由真卡的 :hover 接手 */
    state.node.classList.remove('is-over', 'is-lit');
    document.body.classList.remove('is-card-drag');
  }

  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', function () {
    if (pending) pending = null;
    if (state) {
      state.mode = 'return';
      state.tx = state.origin.x;
      state.ty = state.origin.y;
      state.node.classList.remove('is-over', 'is-lit');
      var api = window.robot3d;
      if (api && typeof api.endCardDrag === 'function') api.endCardDrag();
    }
  });

  /* 拖过之后的补发 click 在这里吃掉，指针没动的点击照常放行 */
  document.addEventListener('click', function (e) {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  /* 归位那一拍：卡回到栏里时轻轻涨一下再落定（幅度与曲线写在
     cards.css 的 card-back-pop 里，这里只管挂类与摘类）。
     先摘再挂是为了同一张卡连着被拿两次也能从第 0 帧起动画 ——
     浏览器对「类已经在身上」不会重新播；中间读一次 offsetWidth 强制重排，
     否则摘和挂落在同一帧里会被合并掉 */
  function popBack(card) {
    if (!card || REDUCED) return;
    card.classList.remove('is-back');
    void card.offsetWidth;
    card.classList.add('is-back');
    card.addEventListener('animationend', function end(ev) {
      if (ev.target !== card || ev.animationName !== 'card-back-pop') return;
      card.removeEventListener('animationend', end);
      card.classList.remove('is-back');
    });
  }

  /* 打勾之后释放：手里的 3D 卡自己淡出（robot3d 那边管），
     这一侧只负责把手里的影子收干净、把栏里那张原卡放回来 */
  window.addEventListener('robot-card', function (e) {
    if (!state || !e.detail) return;
    if (e.detail.phase === 'release') {
      state.node.classList.remove('is-picked', 'is-over');
      var back = state.card;
      /* 对话卡没有动作可播，把卡上的 data-dialog 传出去，
         由 js/dialog_card.js 替用户开口问这一句。动作卡这里是空的 */
      var dialog = back.getAttribute('data-dialog') || '';
      stop();
      /* stop() 里刚把 is-dragging 摘掉、原卡重新露出来，紧跟着弹这一下 */
      popBack(back);
      if (dialog) {
        window.dispatchEvent(new CustomEvent('primebotx-dialog-card', {
          detail: {id: dialog},
        }));
      }
    }
  });
})();
