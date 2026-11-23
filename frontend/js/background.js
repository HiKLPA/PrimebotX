/* 背景点阵，三种样式，由 Settings 弹窗切换：
   plain    只有一层常驻的基础网格点，指针扫过也不动。它整片预渲染在底图里，
            换到这一档之后一次都不再重画，等于一张静态背景。
   magnetic 鼠标周围的一圈点被「磁铁」推开，同时变深、变大。三件事都由点到鼠标的
            距离决定，越近越强；位移和浓度各存一份，每帧朝目标缓一步，所以鼠标甩走、
            移出窗口时，点是自己滑回原位的，不会瞬移。
   wave     没有常驻点阵，只有波经过的地方才有点：指针每走一段就在路径上留一个波源，
            每个波源向外发一道环，环长大、变厚再淡掉，于是指针身后拖着一串前前后后
            的波纹，停手后它们继续扩散到散尽，画面回到空底。

   magnetic 里，远处不动的点不重画：它们早就预渲染在底图里，每帧贴一次底图
   即可，只有被扰动的那几百个点需要「先擦掉原位、再按新位置画回来」。 */
(function () {
  var cvs = document.getElementById('bgfx');
  if (!cvs) return;
  var ctx = cvs.getContext('2d');
  if (!ctx) return;

  var docEl = document.documentElement;
  var DPR = 1, W = 0, H = 0, cols = 0, rows = 0;

  /* ---------- 磁铁 ---------- */
  var CELL      = 16;     /* 点阵间距 */
  var BASE_S    = 2;      /* 常驻点的边长 */
  var BASE_A    = .1;     /* 常驻点的透明度：也是颜色梯度的下限 */
  var R         = 128;    /* 磁场半径：超过这个距离的点不动 */
  var PUSH      = 8;      /* 最靠近鼠标的点被推开的距离 px */
  var DOT_MAX   = 4;      /* 最近的点的边长 */
  var ALPHA_MAX = .5;     /* 最近的点的颜色浓度 */

  var OX = null, OY = null, IN = null, LIST = null;
  var baseCvs = null, bgColor = '#f0f0f0';
  var pal = [];
  var mx = -1e5, my = -1e5;     /* 鼠标位置；移出窗口就扔到屏幕外，磁场自然消失 */
  var R2 = 0, ease = .4, lastN = 0;
  var MODE = 'magnetic';    /* plain：静态基础网格；magnetic：磁铁推开；wave：从指针扩散的波阵 */

  /* ---------- Wave：从指针扩散的波阵 ----------
     一个波源就是一道环：出生时半径 0，此后按 SPD 匀速长大，
     环上的点亮度按「离波前的距离」给，涨落的宽度是 SPAN；
     年龄越大整体越暗，到 LIFE 秒自动退休。
     指针沿路每走 GAP px 留一个源，一连串源就是身后拖着的那串波纹。
     只算环带上的点，环外面一个都不用碰；没有波源时整帧不画。 */
  var W_SPD  = 192;    /* 波前速度 px/s：稍慢一点，看着像水面上推开的圈 */
  var W_SPAN = 16;     /* 波包半宽 px：越大越厚、越糊 */
  var W_LIFE = 1.6;    /* 一道波从生到散尽的秒数 */
  var W_GAP  = 32;     /* 指针每走这么多 px 留一个波源，越小拖得越密 */
  var W_IDLE = 2048;   /* 指针停住时每隔多少 ms 自己吐一个弱波（0 = 关掉） */
  var W_S0   = 2;      /* 波峰上点的边长 */
  var W_S1   = 4;  
  var W_AMAX = .4;     /* 波峰上点的颜色浓度 */
  var MAX_SRC = 64;    /* 同时活着的波源上限 */
  var SRC = [], wAcc = 0, lastEmit = 0;
  var ACC = null, TOUCH = null, nTouch = 0, wpal = [];

  /* 32 级颜色：浓度按强度分级，画的时候只在这一级变了才换一次 fillStyle */
  function buildPalette() {
    var dark = docEl.getAttribute('data-theme') === 'dark';
    var accent = dark ? '145,210,195' : '110,145,130';
    var base = BASE_A + (dark ? .03 : 0);
    pal = [];
    for (var k = 0; k < 32; k++) {
      var a = base + (ALPHA_MAX - base) * (k / 31);
      pal.push('rgba(' + accent + ',' + a.toFixed(3) + ')');
    }
    /* 波阵的色阶从「几乎看不见」起步：没有常驻点兜底，弱波也得留一点影子，
       所以下面取 0.8 次幂，把低段抬起来 */
    wpal = [];
    for (var m = 0; m < 32; m++) {
      var wa = W_AMAX * Math.pow(m / 31, .8);
      wpal.push('rgba(' + accent + ',' + wa.toFixed(3) + ')');
    }
  }

  window.addEventListener('pointermove', function (e) {
    var ddx = e.clientX - mx, ddy = e.clientY - my;
    /* 第一次进来 mx 在屏幕外，那一步差值没有意义，扔掉 */
    if (ddx > -4e3 && ddx < 4e3) {
      if (MODE === 'wave') {
        emitPath(mx, my, e.clientX, e.clientY);
      }
    }
    mx = e.clientX;
    my = e.clientY;
    wake();          /* 循环静止时靠这一步重新点火 */
  }, { passive: true });

  /* 指针离开窗口：把磁铁收走，点自己滑回去；波源留在原地，让最后一圈自己走完 */
  window.addEventListener('pointerout', function (e) {
    if (!e.relatedTarget) { mx = -1e5; my = -1e5; wAcc = 0; wake(); }
  }, { passive: true });

  /* 算这一帧每个点的位移与浓度，返回还在动的点数 */
  function update() {
    var n = 0, i, j, idx, x, y, dx, dy, d2, d, u, f, ti, tox, toy, ox, oy, nx, ny;
    for (j = 0; j < rows; j++) {
      y = j * CELL;
      if (y > H + 8) break;
      for (i = 0; i < cols; i++) {
        x = i * CELL;
        if (x > W + 8) break;
        idx = j * cols + i;
        dx = x - mx;
        dy = y - my;
        d2 = dx * dx + dy * dy;
        ti = 0; tox = 0; toy = 0;
        if (d2 < R2) {
          d = Math.sqrt(d2);
          u = 1 - d / R;
          ti = u;                         /* 颜色与大小：线性，越近越深越大 */
          f = u * u * (3 - 2 * u);        /* 排斥力：两头平、中间陡，圈边不会有折角 */
          if (d > .6) {
            nx = dx / d; ny = dy / d;
          } else {
            nx = 0; ny = -1;              /* 正好压在鼠标上，往上推 */
          }
          tox = nx * PUSH * f;
          toy = ny * PUSH * f;
        }
        ox = OX[idx] + (tox - OX[idx]) * ease;
        oy = OY[idx] + (toy - OY[idx]) * ease;
        ti = IN[idx] + (ti - IN[idx]) * ease;
        OX[idx] = ox;
        OY[idx] = oy;
        IN[idx] = ti;
        /* 还有一丁点残余就重画，完全回位就交给底图 */
        if (ox > -.012 && ox < .012 && oy > -.012 && oy < .012 && ti < .004) continue;
        LIST[n++] = idx;
      }
    }
    return n;
  }

  function drawBase() {
    if (baseCvs) ctx.drawImage(baseCvs, 0, 0, W, H);
    else { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H); }
  }

  /* 上一帧改动过的矩形 [x0, y0, x1, y1]（CSS px），下一帧只需要把它贴回底图。
     整屏 drawImage 在 1440×900、DPR 2 时要摊掉五百多万像素，横扫时主线程就耗在
     这一次全屏拷贝上；改成只恢复被动过的那一小块，通常只有一两百像素见方。
     源矩形对齐到整数设备像素，免得 1:1 拷贝还被重采样一次 */
  var prevBox = null;

  function restoreBox(x0, y0, x1, y1) {
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > W) x1 = W;
    if (y1 > H) y1 = H;
    if (x1 <= x0 || y1 <= y0) return;
    if (!baseCvs) {
      ctx.fillStyle = bgColor;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      return;
    }
    var sx = Math.floor(x0 * DPR), sy = Math.floor(y0 * DPR);
    var ex = Math.ceil(x1 * DPR),  ey = Math.ceil(y1 * DPR);
    ctx.drawImage(baseCvs, sx, sy, ex - sx, ey - sy,
                  sx / DPR, sy / DPR, (ex - sx) / DPR, (ey - sy) / DPR);
  }

  /* 本帧全部点（原位置到新位置之间）的外包框，带 s 与半像素余量 */
  function boxOfDots(n) {
    var k, idx, i, j, x, y, s, t, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (k = 0; k < n; k++) {
      idx = LIST[k];
      i = idx % cols;
      j = (idx - i) / cols;
      t = IN[idx];
      s = BASE_S + (DOT_MAX - BASE_S) * t;
      x = i * CELL + OX[idx];
      y = j * CELL + OY[idx];
      if (x - s < x0) x0 = x - s;
      if (y - s < y0) y0 = y - s;
      if (x + s > x1) x1 = x + s;
      if (y + s > y1) y1 = y + s;
    }
    return [x0 - 1, y0 - 1, x1 + 1, y1 + 1];
  }

  /* 每帧入口：Plain 不参与动画（点阵全在底图里，一张静止的网格），
     Wave 走波源，Magnetic 走距离磁场。
     返回值是「这一帧还有没有东西在动」，静止时外面据此停掉 rAF */
  function paint() {
    if (MODE === 'plain') return false;
    if (MODE === 'wave') return paintWave();
    var n = update();
    if (!n) {
      /* 全部回位：把最后一帧动过的那块贴回底图，画布重新和底图逐像素一致 */
      if (prevBox) { restoreBox(prevBox[0], prevBox[1], prevBox[2], prevBox[3]); prevBox = null; }
      lastN = 0;
      return false;
    }
    lastN = n;

    var k, i, j, idx, s, t, lv, last = -1;

    /* 本帧的绘制范围并上上一帧：上一帧画出的点就在那里，一起被底图盖掉，
       不用再逐点 fillRect 擦一遍（点最多时有上千个，那也是一千次绘制调用） */
    var box = boxOfDots(n);
    var rx0 = prevBox ? Math.min(box[0], prevBox[0]) : box[0];
    var ry0 = prevBox ? Math.min(box[1], prevBox[1]) : box[1];
    var rx1 = prevBox ? Math.max(box[2], prevBox[2]) : box[2];
    var ry1 = prevBox ? Math.max(box[3], prevBox[3]) : box[3];
    restoreBox(rx0, ry0, rx1, ry1);

    /* 画：位置加位移，边长和颜色跟着浓度走 */
    for (k = 0; k < n; k++) {
      idx = LIST[k];
      i = idx % cols;
      j = (idx - i) / cols;
      t = IN[idx];
      s = BASE_S + (DOT_MAX - BASE_S) * t;
      lv = (t * 31) | 0;
      if (lv > 31) lv = 31;
      if (lv !== last) { ctx.fillStyle = pal[lv]; last = lv; }
      ctx.fillRect(i * CELL + OX[idx] - s / 2, j * CELL + OY[idx] - s / 2, s, s);
    }
    prevBox = box;
    return true;
  }

  /* ---------- Wave：从指针扩散的波阵 ---------- */

  /* 沿指针这一步走过的线段等距补波源。
     按路程补而不是按帧补，走快走慢的疏密才一致；
     从窗口外跳进来的那一步（几百 px）直接丢掉，不然会在半空炸出一串圈 */
  function emitPath(x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > .01) || len > 480) return;
    var t = performance.now();
    var d = W_GAP - wAcc;                 /* 离下一个波源还差多少 px */
    if (d < 1) d = 1;
    var f;
    while (d <= len) {
      f = d / len;
      pushSource(x0 + dx * f, y0 + dy * f, t, 1);
      d += W_GAP;
    }
    wAcc = len - (d - W_GAP);             /* 走到两个源中间时，余量留给下一步 */
    if (wAcc < 0) wAcc = 0;
    lastEmit = t;
  }

  function pushSource(x, y, t, a) {
    SRC.push({ x: x, y: y, t: t, a: a });
    if (SRC.length > MAX_SRC) SRC.shift();   /* 甩得再快也不至于堆出上百道圈 */
  }

  /* 把这一帧所有波源的影响累加进 ACC，只遍历每道环带覆盖到的那几行点。
     多个源重叠时取最大值：相加会把交叠处叠成一条白带，取最大更像一道道波峰 */
  function collect(now) {
    var k, s, age, r, r2, sp, amp, inv, fast, rin;
    var cx, cy, j0, j1, j, y, dy, ao, ai, ao2, ai2, seg, xa, xb, i0, i1, i, x, dxx, d2, p, e, idx;
    for (k = 0; k < SRC.length; k++) {
      s = SRC[k];
      age = (now - s.t) / 1000;
      if (age < 0) age = 0;
      r = age * W_SPD;
      /* 两份衰减叠在一起：越老越淡、越走越散，再乘上源的强度 */
      amp = 1 - age / W_LIFE;
      if (amp <= 0) continue;
      amp = Math.pow(amp, 1.15) * s.a / (1 + r / 620);
      if (amp < .05) continue;
      sp = W_SPAN;
      r2 = r * r;
      fast = r > sp;                      /* 半径够大时可以用切线近似，省一次开方 */
      inv = fast ? 1 / (2 * r * sp) : 0;
      cx = s.x; cy = s.y;
      j0 = Math.floor((cy - r - sp * 2) / CELL);
      j1 = Math.ceil((cy + r + sp * 2) / CELL);
      if (j0 < 0) j0 = 0;
      if (j1 > rows - 1) j1 = rows - 1;
      rin = r - sp * 2;
      if (rin < 0) rin = 0;               /* 还小的时候就是一枚实心圆，不挖空 */
      for (j = j0; j <= j1; j++) {
        y = j * CELL;
        dy = y - cy;
        ao2 = (r + sp * 2) * (r + sp * 2) - dy * dy;
        if (ao2 <= 0) continue;
        ao = Math.sqrt(ao2);              /* 这一行上环带外沿的半宽 */
        ai2 = rin * rin - dy * dy;
        ai = ai2 > 0 ? Math.sqrt(ai2) : 0;  /* 内沿：把环里面挖空 */
        for (seg = 0; seg < 2; seg++) {
          if (ai > 0) {
            xa = seg ? cx + ai : cx - ao;
            xb = seg ? cx + ao : cx - ai;
          } else {
            if (seg) continue;            /* 环还没长过一行，两段并成一段 */
            xa = cx - ao; xb = cx + ao;
          }
          i0 = Math.floor(xa / CELL);
          i1 = Math.ceil(xb / CELL);
          if (i0 < 0) i0 = 0;
          if (i1 > cols - 1) i1 = cols - 1;
          for (i = i0; i <= i1; i++) {
            x = i * CELL;
            dxx = x - cx;
            d2 = dxx * dxx + dy * dy;
            p = fast ? (d2 - r2) * inv : (Math.sqrt(d2) - r) / sp;
            if (p < -2 || p > 2) continue;      /* 出了波包，这个点不受影响 */
            e = 1 / (1 + p * p);
            e = e * e * amp;                    /* 平方一次：波峰更窄，圈更清爽 */
            idx = j * cols + i;
            if (e <= ACC[idx]) continue;
            if (ACC[idx] === 0) TOUCH[nTouch++] = idx;
            ACC[idx] = e;
          }
        }
      }
    }
  }

  /* 按浓度画点，画完把 ACC 归零，留给下一帧。
     两遍：第一遍只求这一帧要动的范围，贴回底图后再画第二遍 */
  function drawDots() {
    var k, idx, i, j, t, s, lv, last = -1, n = 0;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;

    for (k = 0; k < nTouch; k++) {
      idx = TOUCH[k];
      t = ACC[idx];
      if (t < .05) continue;
      if (t > 1) t = 1;
      i = idx % cols;
      j = (idx - i) / cols;
      s = W_S0 + (W_S1 - W_S0) * t;
      if (i * CELL - s < x0) x0 = i * CELL - s;
      if (j * CELL - s < y0) y0 = j * CELL - s;
      if (i * CELL + s > x1) x1 = i * CELL + s;
      if (j * CELL + s > y1) y1 = j * CELL + s;
    }
    if (x0 > x1) { nTouch = 0; return 0; }
    x0 -= 1; y0 -= 1; x1 += 1; y1 += 1;

    var rx0 = prevBox ? Math.min(x0, prevBox[0]) : x0;
    var ry0 = prevBox ? Math.min(y0, prevBox[1]) : y0;
    var rx1 = prevBox ? Math.max(x1, prevBox[2]) : x1;
    var ry1 = prevBox ? Math.max(y1, prevBox[3]) : y1;
    restoreBox(rx0, ry0, rx1, ry1);
    prevBox = [x0, y0, x1, y1];

    for (k = 0; k < nTouch; k++) {
      idx = TOUCH[k];
      t = ACC[idx];
      ACC[idx] = 0;
      if (t < .05) continue;               /* 太淡，画出来只是一点脏 */
      if (t > 1) t = 1;
      i = idx % cols;
      j = (idx - i) / cols;
      s = W_S0 + (W_S1 - W_S0) * t;
      lv = (t * 31) | 0;
      if (lv > 31) lv = 31;
      if (lv !== last) { ctx.fillStyle = wpal[lv]; last = lv; }
      ctx.fillRect(i * CELL - s / 2, j * CELL - s / 2, s, s);
      n++;
    }
    nTouch = 0;
    return n;
  }

  function paintWave() {
    var now = performance.now();

    while (SRC.length && now - SRC[0].t > W_LIFE * 1000) SRC.shift();

    /* 指针停住时别让画面死掉：隔一会儿从原地轻轻推一圈出去 */
    if (W_IDLE && mx > -1e4 && now - lastEmit > W_IDLE) {
      pushSource(mx, my, now, .55);
      lastEmit = now;
    }

    if (!SRC.length) {
      /* 最后一圈散尽，把最后动过的那块擦回空底 */
      if (prevBox) { restoreBox(prevBox[0], prevBox[1], prevBox[2], prevBox[3]); prevBox = null; }
      lastN = 0;
      return false;
    }

    collect(now);
    lastN = drawDots();                       /* wave 的底图上没有常驻点 */
    return true;
  }

  /* 底色 + 常驻点阵：只在尺寸或主题变化时重建一次。
     wave 的底图只有底色，点全靠波阵现画 */
  function buildBase() {
    var dark = docEl.getAttribute('data-theme') === 'dark';
    var accent = dark ? '145,210,195' : '110,145,130';
    baseCvs = document.createElement('canvas');
    baseCvs.width = cvs.width;
    baseCvs.height = cvs.height;
    var b = baseCvs.getContext('2d');
    if (!b) { baseCvs = null; return; }
    b.setTransform(DPR, 0, 0, DPR, 0, 0);
    b.fillStyle = bgColor;
    b.fillRect(0, 0, W, H);
    if (MODE === 'wave') return;
    b.fillStyle = 'rgba(' + accent + ',' + (dark ? BASE_A + .03 : BASE_A) + ')';
    for (var j = 0; j * CELL <= H; j++) {
      for (var i = 0; i * CELL <= W; i++) {
        b.fillRect(i * CELL - BASE_S / 2, j * CELL - BASE_S / 2, BASE_S, BASE_S);
      }
    }
  }

  /* 背景样式由 Settings 弹窗写入，键名与弹窗脚本里的一致。
     plain 就是那层静态基础网格，没有任何交互：
     旧版存过 matrix 的，这里也读成 plain，不用去改 localStorage */
  var BG_KEY = 'primebotx.bg';
  function readMode() {
    try {
      var v = localStorage.getItem(BG_KEY);
      if (v === 'wave') return 'wave';
      if (v === 'plain' || v === 'matrix') return 'plain';
      return 'magnetic';
    } catch (e) { return 'magnetic'; }
  }
  function resetField() {
    if (OX) { OX.fill(0); OY.fill(0); IN.fill(0); }
    if (ACC) ACC.fill(0);
    SRC.length = 0;
    nTouch = 0;
    wAcc = 0;
    lastN = 0;
    prevBox = null;      /* 底图马上要重铺，旧的脏矩形没有意义了 */
  }
  function setStyle(m) {
    MODE = m === 'magnetic' ? 'magnetic' : (m === 'wave' ? 'wave' : 'plain');
    /* 换样式先把上一种留下的位移、浓度、波源清掉：
       只停住不推进的话，点会永远歪在最后一次鼠标位置上，波也会在后一种样式里接着走 */
    resetField();
    buildBase();          /* wave 的底图不带点阵，plain 换回来要重铺一次 */
    drawBase();
    wake();               /* plain 下第一帧就返回 false，循环随即停掉 */
  }
  window.Bgfx = { setStyle: setStyle, getStyle: function () { return MODE; } };

  /* 底色统一从 CSS 变量读：浅色 #f0f0f0、深色 #2d2d2d 都由 :root 决定，
     读不到才回落到 data-theme 上的这两档兜底值 */
  function readBg() {
    bgColor = getComputedStyle(docEl).getPropertyValue('--bg').trim()
              || (docEl.getAttribute('data-theme') === 'dark' ? '#2d2d2d' : '#f0f0f0');
  }

  /* 明暗模式切换：底色、常驻点的色阶、波阵的色阶都在 buildPalette / buildBase 里按
     当前 data-theme 现算，所以属性一变就把这两步重跑一遍、再把底图重铺。
     旧的位移与波源留着没有意义 —— 它们的位置还在，颜色却属于上一套底色，
     接着画会在新底上留下一道错色的残影 */
  new MutationObserver(function () {
    resetField();
    readBg();
    buildPalette();
    buildBase();
    drawBase();
    wake();
  }).observe(docEl, { attributes: true, attributeFilter: ['data-theme'] });

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = cvs.clientWidth || window.innerWidth;
    H = cvs.clientHeight || window.innerHeight;
    cvs.width  = Math.round(W * DPR);
    cvs.height = Math.round(H * DPR);
    readBg();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    cols = Math.max(8, Math.ceil(W / CELL) + 1);
    rows = Math.max(8, Math.ceil(H / CELL) + 1);
    OX = new Float32Array(cols * rows);
    OY = new Float32Array(cols * rows);
    IN = new Float32Array(cols * rows);
    LIST = new Int32Array(cols * rows);
    ACC = new Float32Array(cols * rows);
    TOUCH = new Int32Array(cols * rows);
    SRC.length = 0; nTouch = 0; wAcc = 0; lastEmit = 0;
    R2 = R * R;
    lastN = 0;
    prevBox = null;
    buildPalette();
    buildBase();
    drawBase();
    wake();               /* 尺寸变了，循环可能正停着，重新点火 */
  }

  MODE = readMode();
  resize();
  window.addEventListener('resize', resize, { passive: true });

  /* 挂在自己的 rAF 上：不看 GSAP 有没有加载、不受系统「减少动态效果」影响。
     只有真在动的时候才排下一帧：点全部回位、波全部散尽之后循环整个停掉，
     静止的页面不再每帧空转一次 rAF；指针、样式、尺寸变化由 wake() 重新点火 */
  var lastT = 0, rafId = 0, idleTimer = 0;

  function wake() {
    /* plain 是一张静态网格，底图铺好之后就再没有东西要推进：
       指针、尺寸、主题变化都不用点火，循环一次都不进 */
    if (MODE === 'plain') return;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
    if (rafId) return;
    lastT = 0;                              /* 重开循环时重新计时，别拿旧时间戳算 dt */
    rafId = requestAnimationFrame(frame);
  }

  function frame(t) {
    rafId = 0;
    var dt = lastT ? (t - lastT) / 1000 : 1 / 60;
    lastT = t;
    if (dt > .05) dt = .05;                 /* 切标签页回来别一下跳完 */
    ease = 1 - Math.pow(1 - .4, dt * 60);   /* 与帧率无关的跟随速度 */
    if (paint()) { rafId = requestAnimationFrame(frame); return; }
    /* wave 停手后还要补一道呼吸波：不排帧，用定时器睡到该出波的那一刻再唤醒 */
    if (MODE === 'wave' && W_IDLE && mx > -1e4) {
      var wait = W_IDLE - (performance.now() - lastEmit);
      idleTimer = setTimeout(wake, wait > 16 ? wait : 16);
    }
  }
  wake();
  /* 从后台切回来时定时器可能被浏览器推迟，补一次唤醒 */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) wake();
  });
})();
