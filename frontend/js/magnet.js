/* 悬浮磁吸（perspective 倾斜）：参考 Desktop/VC/Traingle 里面板跟着光标翻动的做法，
   为顶栏胶囊整体、账号胶囊、左右栏体加一层立体磁吸——
   光标压在哪一侧，那一侧就绕着面板中心朝观众翻过来，同时整块沿 z 轴从屏幕里朝外浮起，
   像被鼠标吸住；离场后缓缓落回原平面，进场与离场都走同一根阻尼弹簧，带一下轻微回弹。
   只做屏幕内外（z）的吸附：transform 里没有 translateX/translateY，面板在屏幕上的
   平面位置始终不动，只有 perspective + translateZ 的进深和 rotateX/rotateY 的倾斜。
   transform 只写在承载底色的大块上（.group / .user__surface / .rail__surface），
   .rail 本身不碰，避免和 translate 的居中、is-hidden 的位移打架。

   激活判定用「光标 vs 未变换的布局盒」而不是 pointerenter/pointerleave：
   倾斜会把渲染盒撑大，靠元素自身的进出事件会在边缘反复触发，这里用布局盒算，
   渲染盒怎么歪都不影响判定，从根上避免边缘抖动。 */
(function () {
  if (!window.matchMedia) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  /* 阻尼弹簧：光标一进面板就朝目标角度「弹」上去，冲过一点点再回落，
     像 Traingle 里那块面板被吸住的手感；离场时同一根弹簧把它送回去，
     所以收回也会轻轻过冲一下，不会僵在原地。
     OMEGA —— 角频率（rad/s），越大吸得越快越紧
     ZETA  —— 阻尼比，1 为临界阻尼不过冲；0.4 约 25% 过冲，回弹一下即停 */
  var OMEGA = 16;
  var ZETA  = 0.4;
  var EPS   = 0.02;    // 角度收敛阈值（deg）；z 另有 0.05px 阈值
  var VEL   = 0.6;     // 角速度落定阈值（deg/s）；z 另有 3px/s 阈值
  /* 吸住时整体放大到 1.02：卡片被吸起来的同时略略涨一圈，
     进深与体积一起变，才像真的从屏里被拎出来。
     只能给有明确边界的小块用；栏体那种贴边的长条一涨就会顶到视口边线，
     看起来是整页在缩放，所以栏体下面单独写 grow: 1 关掉。
     走独立的 scale 通道（与倾斜同一根弹簧），不和 transform 抢 */
  var HOVER_SCALE = 1.02;

  /* 每块面板的磁吸强度：
     persp —— 透视距离 px，越小立体感越强
     tiltX —— 上下倾斜上限 deg（光标在上/下边缘时的最大翻角）
     tiltY —— 左右倾斜上限 deg，长条栏体比胶囊略收一档，两端才不摆
     lift  —— 沿 z 轴朝观众浮起的距离 px
     grow  —— 吸住时的缩放倍数，写 1 就只翻不涨
     顶栏两块与左右栏体统一用 900 的透视，翻角按各自面积定：
     顶栏扁而宽，给 6；栏体高而窄，给 4
     栏体那条只在收起（图标列）时生效：展开后整块翻动会把卡片里的字整体
     重新采样、抖得厉害，立体感改由卡片自己给，见下面 .sc 的判定
     视角那枚眼睛与复位现在住进了一条 .group 托盘，就排在 Preference 左边，
     于是自动吃到上面这条配置 —— 它们不再是单独的浮块，跟着顶栏一起翻 */
  var CONF = [
    { sel: '.group',         persp: 900,  tiltX: 6, tiltY: 6, lift: 6,  grow: HOVER_SCALE },
    { sel: '.user__surface', persp: 900,  tiltX: 6, tiltY: 6, lift: 6,  grow: HOVER_SCALE },
    /* 栏体贴视口左右边，涨 2% 就是整根柱子往外顶、图标整体位移，
       像页面在缩放而不是那一列被吸住，所以只翻不涨 */
    { sel: '.rail__surface', persp: 900,  tiltX: 4, tiltY: 4, lift: 4,  grow: 1 },
    /* 卡片小、每条边都短，透视得拉近才看得出一块板子朝光标翻；
       面积小也压得住，倾斜和浮起都可以比大面板放开一档。
       右栏手势 / 表情卡比指令卡再小一号，透视相应拉近，
       倾斜收一档、浮起保留，抬起来时不至于翻出面板边界 */
    { sel: '.sc',            persp: 800,  tiltX: 6, tiltY: 6, lift: 10, grow: HOVER_SCALE },
    { sel: '.rail__card',    persp: 700,  tiltX: 5, tiltY: 5, lift: 8,  grow: HOVER_SCALE },
    /* 左栏角色卡与右栏动作卡同一档：两块卡的面积相当，翻角与浮起也照抄 */
    { sel: '.persona-card',  persp: 700,  tiltX: 5, tiltY: 5, lift: 8,  grow: HOVER_SCALE },
    /* 设置里的模型预设卡：改版后与 Persona 卡同尺寸同圆角，手感也照抄。
       inModal —— 弹窗默认整片停手（见 aim 里的判断），这几张卡要破例 */
    { sel: '.model-preset',  persp: 700,  tiltX: 5, tiltY: 5, lift: 8,  grow: HOVER_SCALE,
      inModal: true }
  ];

  var items = [];
  var raf = 0;
  var mx = -1, my = -1, needAim = false;

  /* 取「没被自己推歪」的布局盒：offsetParent 的 rect + offsetLeft/Top。
     直接读自身 getBoundingClientRect 拿到的是已经带上 transform 的投影盒，
     倾斜后长宽都会变大，拿它算归一化坐标会反过来推自己，形成自激振荡。
     卡片在滚动区里，offsetTop 是不含滚动的布局值，要把中间各层滚过的
     距离减掉，判定盒才和屏幕上看到的位置对得上 */
  function boxOf(el) {
    var p = el.offsetParent || document.body;
    var pr = p.getBoundingClientRect();
    var left = pr.left + el.offsetLeft;
    var top  = pr.top  + el.offsetTop;
    /* offsetParent 自己就是滚动容器时，要把它滚过的距离也减掉。
       offsetTop 是相对 offsetParent 的 padding box 量的，不含滚动；
       而下面那圈循环在 n === p 处就停了，p 自身的 scrollTop 谁也减不到。
       桌面端 .panel__body 恰好既是滚动区、又是绝对定位的（见 rail.css 里那条
       >641px 的规则），卡片的 offsetParent 正是它 —— 少这一项，判定盒就整段
       停在「没滚动」的位置，滚过多少就和屏幕错开多少：指针压在下面这张卡上，
       倾斜与浮起却落到上面那张（雾里的那张），看着像遮罩里的卡也在 hover。
       手机上 offsetParent 是栏体，p.scrollTop 为 0，这一项不起作用 */
    if (p.scrollTop)  top  -= p.scrollTop;
    if (p.scrollLeft) left -= p.scrollLeft;
    for (var n = el.parentElement; n && n !== p; n = n.parentElement) {
      if (n.scrollTop)  top  -= n.scrollTop;
      if (n.scrollLeft) left -= n.scrollLeft;
    }
    return {
      left:   left,
      top:    top,
      width:  el.offsetWidth,
      height: el.offsetHeight
    };
  }

  function aim(t) {
    /* 弹窗与登录页开着时整片停手：光标刚刚就停在顶栏胶囊上，而 .group / .user__surface
       背后挂着 backdrop-filter，那一层每倾斜一点，浏览器都要把它背后的画布
       重新模糊一次 —— 弹窗弹出那几帧的卡顿基本来自这里。
       两者盖在最上面，托盘也没必要继续跟着指针翻 */
    if ((document.body.classList.contains('is-modal') ||
        document.body.classList.contains('is-auth')) && !t.cfg.inModal) {
      t.RX = t.RY = t.Z = 0; t.S = 1; return;
    }

    /* 正拎着一张卡时整片停手：指针从别的卡上划过去，那套倾斜与浮起
       读起来像「这张也能拎」，而此刻手上已经有一张了。倾斜是按指针坐标算的、
       不看 :hover，所以光靠 CSS 关掉命中判定压不住它，这里单独拦一道 */
    if (document.body.classList.contains('is-card-drag')) { t.RX = t.RY = t.Z = 0; t.S = 1; return; }

    var b = boxOf(t.el);
    if (!b.width || !b.height) { t.RX = t.RY = t.Z = 0; t.S = 1; return; }

    /* 栏体收进屏外时不该再被吸，否则贴边划一下也会让它翻 */
    if (t.el.closest('.rail.is-hidden')) {
      t.RX = t.RY = t.Z = 0; t.S = 1; return;
    }

    /* 展开与收起的归属：展开时吸的是卡片，收起时吸的才是栏体。
       栏体整块翻动会让卡片里的字跟着重新采样、面积太大也像整页在晃；
       反过来收起时面板宽 0，卡片虽有布局宽度却已被裁没，光标扫过图标列
       旁边不该有东西翻起来 —— 两边互斥，同一时刻只有一层在动 */
    var rail = t.el.closest('.rail');
    if (rail) {
      var open = rail.classList.contains('is-open');
      /* 指令卡、右栏动作卡与左栏角色卡都算「卡片」：展开时吸它们、收起时吸栏体 */
      var isCard = t.el.classList.contains('sc') || t.el.classList.contains('rail__card') ||
        t.el.classList.contains('persona-card') || t.el.classList.contains('model-preset');
      if (isCard ? !open : open) { t.RX = t.RY = t.Z = 0; t.S = 1; return; }
      /* 开合动画（scale 胀开 + elastic 回弹）没走完之前，卡片不参与：
         父级的缩放与卡片的透视叠在一起，两层每帧各自重投影，边线会跳。
         等 --sx/--sy 稳在 1，is-popping 摘掉再吸 */
      if (isCard && rail.classList.contains('is-popping')) { t.RX = t.RY = t.Z = 0; t.S = 1; return; }
    }

    /* 命中留 1px 余量，避免贴边时在矩形内外反复抖 */
    var inside = mx >= b.left - 1 && mx <= b.left + b.width  + 1 &&
                 my >= b.top  - 1 && my <= b.top  + b.height + 1;
    if (!inside) { t.RX = t.RY = t.Z = 0; t.S = 1; return; }

    var dx = ((mx - b.left) / b.width)  * 2 - 1;
    var dy = ((my - b.top)  / b.height) * 2 - 1;
    dx = dx < -1 ? -1 : dx > 1 ? 1 : dx;
    dy = dy < -1 ? -1 : dy > 1 ? 1 : dy;

    /* 光标在上下哪一侧，面板就朝那一侧抬头：rotateX 取正时面板面朝上、下缘朝观众，
       所以光标在上方（dy<0）要给正的 rotateX，视觉上才是「往上吸」而不是往下沉；
       左右保持原方向：光标在哪侧，那一侧朝观众翻（rotateY 取负）。
       两轴符号相反，是这套坐标里 rotateX 与 rotateY 的观察方向不同导致的 */
    t.RY = -dx * t.cfg.tiltY;
    t.RX = -dy * t.cfg.tiltX;
    t.Z  =  t.cfg.lift;
    t.S  =  t.cfg.grow;
  }

  function r2(v) { return Math.round(v * 100) / 100; }
  function r3(v) { return Math.round(v * 1000) / 1000; }

  var last = 0;

  /* 一根弹簧的三个通道共用：a = ω²(目标 − 当前) − 2ζω·v */
  function spring(cur, target, vel, dt) {
    var a = OMEGA * OMEGA * (target - cur) - 2 * ZETA * OMEGA * vel;
    vel += a * dt;
    return [cur + vel * dt, vel];
  }

  function frame(ts) {
    raf = 0;
    var busy = false;

    /* 掉帧时按 32ms 封顶，避免一次积太多速度把面板甩歪；首帧按 60fps 起 */
    var dt = last ? Math.min((ts - last) / 1000, 0.032) : 1 / 60;
    last = ts;

    /* 栏体宽度过渡那段里，卡片是被裁着一起平移的：位置每帧都在变 */
    if (needAim) {
      needAim = false;
      for (var j = 0; j < items.length; j++) aim(items[j]);
    }

    for (var i = 0; i < items.length; i++) {
      var t = items[i];

      var rx = spring(t.rx, t.RX, t.vrx, dt); t.rx = rx[0]; t.vrx = rx[1];
      var ry = spring(t.ry, t.RY, t.vry, dt); t.ry = ry[0]; t.vry = ry[1];
      var z  = spring(t.z,  t.Z,  t.vz,  dt); t.z  = z[0];  t.vz  = z[1];
      var s  = spring(t.s,  t.S,  t.vs,  dt); t.s  = s[0];  t.vs  = s[1];

      var settled =
        Math.abs(t.RX - t.rx) < EPS && Math.abs(t.RY - t.ry) < EPS &&
        Math.abs(t.Z  - t.z)  < 0.05 && Math.abs(t.S - t.s) < 0.0005 &&
        Math.abs(t.vrx) < VEL && Math.abs(t.vry) < VEL && Math.abs(t.vz) < 3 &&
        Math.abs(t.vs) < 0.003;

      if (settled) {   // 落定后贴住目标并清零速度，避免循环空转
        t.rx = t.RX; t.ry = t.RY; t.z = t.Z; t.s = t.S;
        t.vrx = t.vry = t.vz = t.vs = 0;
      } else {
        busy = true;
      }

      /* 缩放走独立的 scale 属性，不并进下面那条 transform：
         那串一写就是整块覆盖，元素自己留在 transform 上的位移会被一起抹掉。
         两个通道浏览器最后再合成，互不干扰 */
      var sc = t.s === 1 ? '' : '' + r3(t.s);
      if (t.el.style.scale !== sc) t.el.style.scale = sc;

      if (!t.rx && !t.ry && !t.z) {
        if (t.el.style.transform) t.el.style.transform = '';
        continue;
      }

      t.el.style.transform =
        'perspective(' + t.cfg.persp + 'px)' +
        ' translateZ(' + r2(t.z) + 'px)' +
        ' rotateX(' + r2(t.rx) + 'deg) rotateY(' + r2(t.ry) + 'deg)';
    }

    if (busy) raf = requestAnimationFrame(frame);
  }

  function start() {
    if (raf) return;
    last = 0;   // 重开循环时重新计时，别拿上一次的旧时间戳算 dt
    raf = requestAnimationFrame(frame);
  }

  /* 收集带磁吸的块。编辑页新增的卡片是后来才插进 DOM 的，
     所以这件事得能重跑：已经收过的元素打上 __magnet 标记，
     重扫只补新的，不碰正在动的那些（它们的 rx/ry/z 停在半路，重建会跳） */
  function collect() {
    /* 角色卡每选一次就整组重绘，旧节点离开了文档却还挂在表里，
       弹簧照样每帧算一遍，白白拖着循环。收新块之前先清掉这些 */
    items = items.filter(function (t) { return t.el.isConnected; });
    CONF.forEach(function (cfg) {
      document.querySelectorAll(cfg.sel).forEach(function (el) {
        if (el.__magnet) return;
        el.__magnet = true;
        items.push({
          el: el, cfg: cfg,
          rx: 0, ry: 0, z: 0, s: 1,    // 当前值
          RX: 0, RY: 0, Z: 0, S: 1,    // 目标值
          vrx: 0, vry: 0, vz: 0, vs: 0 // 弹簧速度
        });
      });
    });
  }

  collect();

  /* 新增卡片后由 rails.js 调一次：补收新块，并按当前光标位置重新瞄目标 */
  window.magnetRescan = function () {
    collect();
    needAim = true;
    start();
  };

  document.addEventListener('pointermove', function (e) {
    if (e.pointerType && e.pointerType !== 'mouse') return;   // 触屏不做
    mx = e.clientX; my = e.clientY;
    needAim = true;
    start();
  }, { passive: true });

  /* 光标移出窗口 / 切标签页时 pointermove 断在半路，回来先全部归零 */
  function releaseAll() {
    mx = my = -1;
    items.forEach(function (t) { t.RX = t.RY = t.Z = 0; t.S = 1; });
    start();
  }
  document.addEventListener('pointerleave', releaseAll);
  window.addEventListener('blur', releaseAll);

  /* 栏体展开、账号面板长高、窗口缩放都会改变布局盒，而光标可能就停在原地不动：
     这些几何变化结束后补一次重算，倾斜角度才不会停在旧比例上 */
  function reaim() { needAim = true; start(); }
  document.addEventListener('transitionend', function (e) {
    if (e.propertyName === 'width' || e.propertyName === 'height') reaim();
  }, true);
  window.addEventListener('resize', reaim);

  /* 卡片在滚动区里会自己滑走：光标停着不动、判定盒却已经换了位置，
     不重算的话浮起的那张卡会停在旧坐标上。滚动即重算 */
  document.querySelectorAll('.panel__body').forEach(function (el) {
    el.addEventListener('scroll', reaim, { passive: true });
  });

  /* 栏体展开/收起的瞬间就该改判要不要吸（width 过渡走完才 transitionend 太晚，
     展开过程中面板会先歪一下再回正），class 一变就重算 */
  if (window.MutationObserver) {
    var mo = new MutationObserver(reaim);
    /* is-open 与 is-popping 一变，卡片该不该吸就跟着变 */
    document.querySelectorAll('.rail').forEach(function (el) {
      mo.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
  }
})();
