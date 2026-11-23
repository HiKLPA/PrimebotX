/* 登录页左栏那三枚色块角色（主题色 / 粉 / Dialog 蓝）的三段情绪。
   结构在 PrimebotX.html 的 .auth__aside 里，形状与配色在 css/auth.css；
   这里只做三件事：

   1) 眼睛跟着指针走：每只瞳孔按它自己那档幅度（data-pupil）平移，
      幅度小于眼球与瞳孔的半径差，所以永远转不出眼眶；
   2) 密码框获得焦点时集体看向左边、橙色眯眼、紫色撇出波浪嘴，
      整组像别过头吹口哨 —— 这层状态由 .auth__aside[data-mood="whistle"] 画；
   3) 登录成功时换成笑眼并喷一次彩带，粒子从角色背后向上窜；
      被规则挡下时换成震惊：眉毛抬起、瞳孔收紧、嘴张成小圆。

   状态由 js/auth.js 在「打开面板 / 提交成功 / 提交失败 / 关闭」几个时机调用，
   本文件不认识登录接口，也不碰表单数据。 */
(function () {
  const aside = document.querySelector('.auth__aside');
  if (!aside) return;

  const root = document.getElementById('auth');
  const canvas = aside.querySelector('[data-confetti]');
  const passwordEl = document.getElementById('auth-password');
  const pupils = Array.prototype.slice.call(aside.querySelectorAll('[data-pupil]'));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const COLORS = ['#7a5cfa', '#ff7a2f', '#ffd028', '#91d2c3', '#fafafa'];

  let mood = 'idle';
  let pointer = null;
  let followFrame = 0;
  let moodTimer = 0;

  /* ---------- 眼睛 ---------- */

  function clampUnit(value) {
    return value < -1 ? -1 : value > 1 ? 1 : value;
  }

  /* 吹口哨时那一眼要比跟着指针走时明显得多：跟手只是「余光瞟一下」，
     别过头看左边是主动动作，位移得看得出来。
     蓝块那颗例外 —— 瞳孔被白眼球框着（球半径 9.5、瞳 4.6，偏到 4.9 就
     滑出眼眶），所以它封在 4.4 上，不够的那一截由白眼球整体左移补
     （见 css/auth.css 里 whistle 那条），两段加起来和另一枚差不多 */
  const WHISTLE_GAIN = 2.6;
  const WHISTLE_DOT_MAX = 4.4;

  function nudge(dx, dy, gain) {
    const k = gain || 1;
    for (let i = 0; i < pupils.length; i += 1) {
      const node = pupils[i];
      const range = parseFloat(node.dataset.pupil) || 3.2;
      /* 包在 .cast__eye 里的是白眼球内的瞳孔，要守住眼眶；
         直接挂在色块上的圆点本身就是整只眼，走多远都还在块面里 */
      const framed = node.parentNode && node.parentNode.classList.contains('cast__eye');
      let x = dx * range * k;
      let y = dy * range * k;
      if (framed) {
        if (x < -WHISTLE_DOT_MAX) x = -WHISTLE_DOT_MAX;
        else if (x > WHISTLE_DOT_MAX) x = WHISTLE_DOT_MAX;
        if (y < -WHISTLE_DOT_MAX) y = -WHISTLE_DOT_MAX;
        else if (y > WHISTLE_DOT_MAX) y = WHISTLE_DOT_MAX;
      }
      node.style.transform =
        'translate(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px)';
    }
  }

  /* 以整块左栏的中心为准，而不是每只眼睛自己的中心：
     四个角色看的是同一点，画面里才有「一起看过来」的联动感 */
  function follow() {
    if (!pointer) return;
    const rect = aside.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = clampUnit((pointer.clientX - (rect.left + rect.width / 2)) / (rect.width * 0.42));
    const dy = clampUnit((pointer.clientY - (rect.top + rect.height / 2)) / (rect.height * 0.42));
    /* 身子跟指针一起晃，眼睛只在常态里跟：吹口哨是「别过头去」、
       震惊是「僵住」，这两层各演各的，但身体一直活着 */
    setSway(dx, dy);
    if (mood === 'idle') nudge(dx, dy);
  }

  /* ---------- 身子 ---------- */

  /* 幅度：顶端最多平移 6px、斜切 2.4°、纵向伸缩 2%。
     数字压在「看得出在动、但不像果冻玩具」这一档；
     矮的那枚与高的那枚再按 --cast-gain 各自收放（见 css/auth.css） */
  const SWAY_X = 6;
  const SWAY_LEAN = 2.4;
  const SWAY_STRETCH = 0.02;

  function setSway(dx, dy) {
    if (reduce.matches) return;
    aside.style.setProperty('--cast-x', (dx * SWAY_X).toFixed(2));
    /* skewX 正角把上半身推向左边（转轴落在脚底，脚尖以上 y 为负），
       所以往右看要给负角，斜过去的方向才和指针一致 */
    aside.style.setProperty('--cast-lean', (-dx * SWAY_LEAN).toFixed(2));
    /* 指针抬高就往上抻一点、压低就往下坐一点，只当呼吸感用 */
    aside.style.setProperty('--cast-squash', (-dy * SWAY_STRETCH).toFixed(4));
  }

  function clearSway() {
    aside.style.setProperty('--cast-x', '0');
    aside.style.setProperty('--cast-lean', '0');
    aside.style.setProperty('--cast-squash', '0');
  }

  /* ---------- 状态 ---------- */

  function setMood(next) {
    if (mood === next) return;
    mood = next;
    if (next === 'idle') aside.removeAttribute('data-mood');
    else aside.setAttribute('data-mood', next);
    /* 吹口哨时瞳孔统一偏到左下方；这批偏移与指针位置无关，
       所以只在这里写一次，之后指针再动也不跟（否则「看左边」会被拖走）。
       震惊时瞳孔回到正中 —— 直勾勾盯着你才是被吓到 */
    if (next === 'whistle') nudge(-1, 0.24, WHISTLE_GAIN);
    else if (next === 'shock') nudge(0, 0);
    /* 指针位置还记着就照它看过去；没有（卡片刚开、或光标刚从密码框里出来）
       就先归中，否则眼睛会停在左边等下一次鼠标动 */
    else if (next === 'idle') {
      if (pointer) follow();
      else nudge(0, 0);
    }
  }

  function idle() {
    if (moodTimer) { clearTimeout(moodTimer); moodTimer = 0; }
    stopConfetti();
    /* 卡片收起时把身子也扶正：下次浮出来是站直的，
       不会带着上一次的倾斜，也不会拿旧指针位置先甩一下 */
    pointer = null;
    clearSway();
    setMood('idle');
  }

  /* ---------- 彩带 ---------- */

  const ctx = canvas ? canvas.getContext('2d') : null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let parts = [];
  let confettiFrame = 0;
  let confettiLast = 0;
  let boxW = 0;
  let boxH = 0;

  function sizeCanvas() {
    const w = aside.clientWidth;
    const h = aside.clientHeight;
    if (!w || !h) return false;
    boxW = w;
    boxH = h;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function step(now) {
    const dt = Math.min((now - confettiLast) / 1000, 0.05);
    confettiLast = now;
    ctx.clearRect(0, 0, boxW, boxH);
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const p = parts[i];
      p.age += dt;
      p.vy += 1250 * dt;          /* 重力：升到顶之后自己落回来 */
      p.vx *= 1 - 0.55 * dt;      /* 横向阻尼：越飞越收，不会一直往外散 */
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      p.flip += p.flipSpeed * dt;
      if (p.age >= p.life || p.y > boxH + 60) { parts.splice(i, 1); continue; }
      /* 末段三成淡出，落地前先透明，不会硬生生消失在半空 */
      const left = p.age > p.life * 0.7 ? 1 - (p.age - p.life * 0.7) / (p.life * 0.3) : 1;
      ctx.save();
      ctx.globalAlpha = Math.max(0, left);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      /* 用纵向压扁模拟纸片翻面：只压 y，不换色，薄片感最接近真彩带 */
      ctx.scale(1, Math.max(0.16, Math.abs(Math.cos(p.flip))));
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (parts.length) {
      confettiFrame = requestAnimationFrame(step);
    } else {
      confettiFrame = 0;
      ctx.clearRect(0, 0, boxW, boxH);
    }
  }

  function burst() {
    if (!ctx || reduce.matches) return;
    if (!sizeCanvas()) return;
    /* 速度与尺寸都按画布宽度缩放：左栏在窄一点的窗口里只有三百来像素，
       写死像素值会让彩带在那儿一闪就飞出去 */
    const unit = Math.max(0.62, boxW / 480);
    const cx = boxW * 0.52;
    const cy = boxH * 0.95;
    for (let i = 0; i < 150; i += 1) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.5;
      const speed = (520 + Math.random() * 620) * unit;
      parts.push({
        x: cx + (Math.random() - 0.5) * boxW * 0.2,
        y: cy - Math.random() * boxH * 0.05,
        vx: Math.cos(angle) * speed * 0.85,
        vy: Math.sin(angle) * speed,
        w: (4 + Math.random() * 6) * unit,
        h: (3 + Math.random() * 4) * unit,
        rot: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 14,
        flip: Math.random() * Math.PI * 2,
        flipSpeed: 6 + Math.random() * 8,
        color: COLORS[i % COLORS.length],
        life: 1.5 + Math.random() * 1.1,
        age: 0
      });
    }
    if (!confettiFrame) {
      confettiLast = performance.now();
      confettiFrame = requestAnimationFrame(step);
    }
  }

  function stopConfetti() {
    parts.length = 0;
    if (confettiFrame) cancelAnimationFrame(confettiFrame);
    confettiFrame = 0;
    if (ctx && boxW) ctx.clearRect(0, 0, boxW, boxH);
  }

  /* ---------- 对外的两个动作 ---------- */

  /* 收尾：密码框里还留着光标就接着吹口哨，否则回常态 */
  function settle() {
    setMood(document.activeElement === passwordEl ? 'whistle' : 'idle');
  }

  /* 登录 / 注册成功：先笑，再喷彩带，1.55 秒后自己收回来 */
  function celebrate() {
    if (moodTimer) clearTimeout(moodTimer);
    setMood('happy');
    burst();
    moodTimer = setTimeout(function () {
      moodTimer = 0;
      if (mood !== 'happy') return;
      settle();
    }, 1550);
  }

  /* 被规则挡下（格式不对、账号或密码不匹配）：眉毛抬起、瞳孔收紧、嘴张成 O，
     身子往上惊跳一下。比笑脸收得早一点，1.3 秒就回常态，
     提示行这时还亮着，表情先退场不抢戏；彩带若刚喷过也一并掐掉 */
  function shock() {
    if (moodTimer) clearTimeout(moodTimer);
    stopConfetti();
    setMood('shock');
    moodTimer = setTimeout(function () {
      moodTimer = 0;
      if (mood !== 'shock') return;
      settle();
    }, 1300);
  }

  /* ---------- 装配 ---------- */

  document.addEventListener('pointermove', function (event) {
    pointer = event;
    /* 只要卡片开着就跟：表情那几层各自有主，但身子一直是活的 */
    if (!root || !root.classList.contains('is-open')) return;
    if (followFrame) return;
    followFrame = requestAnimationFrame(function () {
      followFrame = 0;
      follow();
    });
  }, { passive: true });

  if (passwordEl) {
    passwordEl.addEventListener('focus', function () {
      /* 笑脸与震惊都还没收完时别被聚焦抢走：这两段表情本身就是对刚才那一下的回应 */
      if (mood === 'happy' || mood === 'shock') return;
      setMood('whistle');
    });
    passwordEl.addEventListener('blur', function () {
      if (mood === 'whistle') setMood('idle');
    });
  }

  window.primebotxAuthFaces = {
    idle: idle,
    celebrate: celebrate,
    shock: shock
  };
})();
