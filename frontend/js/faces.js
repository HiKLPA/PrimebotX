/* 机器人的表情屏。

   一条数据同时喂两处：3D 面罩上的发光图案（robot3d.js 把它当 emissiveMap），
   和底栏 Emotions 那排缩略图。所以每张表情只写一遍，两边长得一模一样。

   画法统一在 100 × 114 的虚拟画布里 —— 面罩本体 0.082 × 0.096，宽高比 0.86，
   目标画布按这个比例缩放后再调 draw()，缩略图缩小也不会走形。
   底色一律涂黑：对 emissiveMap 来说黑就是「不发光」，正好只剩图形在亮。

   结构分两层，参考 github.com/jeremy-prt/bloub（x.ai 头像的 SVG 复刻）的做法：

     表情层 —— 只写「静态时的形状」：每只眼的宽高与倾角、视线落在哪、嘴的形状。
       眼睛是胶囊，倾角按左右镜像给，所以愤怒（上端往中间压）与难过（上端往
       两边散）只用一对正负号就能分开，不用另画眉毛。
     生命层 —— 所有表情共用：不规则的眨眼、缓慢的视线漂移、偶尔的小扫视。
       bloub 那句话是对的 —— 静止时不飘不晃，活气全在 gaze drift 和 blink 上。
       所以这一层不写进各个表情里，往下叠。

   两层都只吃时间 t，不存中间状态：3D 那张大图和十六个缩略图各用各的帧率，
   图案也不会错位。 */

const VW = 100;
const VH = 114;

const EYE_Y = 46;       /* 眼睛中线 */
const EYE_DX = 15;      /* 眼睛离中轴的距离 */
const MOUTH_Y = 79;     /* 嘴的中线 */

const STORE = 'primebotx.mood';
const STILL = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* —— 生命层：眨眼 —— */

/* 眨眼不按固定节拍走：真人的间隔在 1.9–4.6 秒之间乱跳，偶尔还连眨两下。
   表在模块加载时按固定种子抽好，之后是纯查表，不引入状态，
   所以画面可以随时跳到任意时刻、也可以被两处同时读取而不会不同步 */
const SPAN = 600;
const BLINKS = (() => {
  let s = 0x5eed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out = [];
  let t = 1.5;
  while (t < SPAN) {
    out.push(t);
    if (rnd() < 0.17) out.push(t + 0.34);   /* 连眨 */
    t += 1.9 + rnd() * 2.9;
  }
  return out;
})();

const smooth = (k) => k * k * (3 - 2 * k);

/* 一次眨眼的包络：合得比开得快，中间留一瞬闭紧 —— 这就是「有重量」的关键 */
function lidCurve(q) {
  const close = 0.055;
  const hold = 0.03;
  const open = 0.085;
  if (q < close) return smooth(q / close);
  if (q < close + hold) return 1;
  if (q < close + hold + open) return 1 - smooth((q - close - hold) / open);
  return 0;
}

/* 1 = 睁满，0 = 闭合。rate 是各表情的眨眼频率倍数 */
function lidAt(t, rate) {
  const p = (((t * rate) % SPAN) + SPAN) % SPAN;
  for (let i = BLINKS.length - 1; i >= 0; i--) {
    const q = p - BLINKS[i];
    if (q < 0) continue;
    if (q < 0.2) return 1 - lidCurve(q);
    break;   /* 更早的都结束了 */
  }
  return 1;
}

/* —— 生命层：视线 —— */

const hash = (n) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
};

/* 扫视：人的眼球不是匀速游动，而是「跳一下、停一会儿」。
   把时间切成段，每段一个随机目标，段首 22% 内快速过去，剩下停住 */
function saccade(t, seed) {
  const span = 1.7;
  const n = Math.floor(t / span);
  const f = t / span - n;
  const a = hash(n + seed);
  const b = hash(n + 1 + seed);
  return a + (b - a) * (f < 0.22 ? smooth(f / 0.22) : 1);
}

/* 漂移：两条不同周期的慢正弦，假装视线一直在极缓地游 */
const driftX = (t) => Math.sin(t * 0.37) * 0.6 + Math.sin(t * 0.19 + 1.7) * 0.4;
const driftY = (t) => Math.sin(t * 0.29 + 0.9) * 0.5 + Math.sin(t * 0.13 + 2.6) * 0.5;

/* 每个表情都从这里拿「此刻的眼睛状态」：
   lid 眼皮开合、g 视线的屏上偏移（虚拟单位，100 宽 ≈ 6 个像素） */
function alive(t, drift, rate) {
  return {
    lid: lidAt(t, rate),
    gx: (driftX(t) * 1.1 + saccade(t * 0.9, 3) * 1.5) * drift,
    gy: (driftY(t) * 0.9 + saccade(t * 0.9, 11) * 1.0) * drift,
  };
}

/* —— 画笔 —— */

function ink(ctx, w) {
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = inkColor;
  ctx.fillStyle = inkColor;
}

/* 眨眼就是把整只眼沿水平线压扁。压在眼睛自己身上而不是缩放到脸上，
   线宽也会跟着变薄 —— 看起来才像上眼皮落下来盖住，而不是眼睛缩小了 */
function withLid(ctx, cy, lid, fn) {
  ctx.save();
  ctx.translate(0, cy);
  ctx.scale(1, Math.max(0.05, lid));
  ctx.translate(0, -cy);
  fn();
  ctx.restore();
}

/* 胶囊眼：倾斜角为正时上端偏向右侧（画布 y 轴向下，正角即顺时针） */
function capsule(ctx, cx, cy, w, h, tilt) {
  ctx.save();
  ctx.translate(cx, cy);
  if (tilt) ctx.rotate((tilt * Math.PI) / 180);
  if (h < 1) {
    ctx.beginPath();
    ctx.moveTo(-w / 2, 0);
    ctx.lineTo(w / 2, 0);
    ctx.stroke();
  } else {
    const r = Math.min(h / 2, w / 2);
    const hw = w / 2;
    const hh = h / 2;
    ctx.beginPath();
    ctx.moveTo(-hw + r, -hh);
    ctx.lineTo(hw - r, -hh);
    ctx.arc(hw - r, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(-hw + r, hh);
    ctx.arc(-hw + r, 0, r, Math.PI / 2, Math.PI * 1.5);
    ctx.stroke();
  }
  ctx.restore();
}

/* 拱形眼：lift 为正向上拱（笑眼），为负向下垂（困眼） */
function arch(ctx, cx, cy, w, lift) {
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, cy);
  ctx.quadraticCurveTo(cx, cy - lift, cx + w / 2, cy);
  ctx.stroke();
}

function ring(ctx, cx, cy, r, px, py, pupil) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  if (!pupil) return;
  ctx.beginPath();
  ctx.arc(cx + px, cy + py, Math.max(1.3, r * 0.34), 0, Math.PI * 2);
  ctx.fill();
}

/* 嘴：curve 为正向下弯（笑），为负向上弯（撇嘴） */
function mouth(ctx, cx, cy, w, curve) {
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, cy);
  ctx.quadraticCurveTo(cx, cy + curve, cx + w / 2, cy);
  ctx.stroke();
}

/* 一对胶囊眼：tilt 只给一边，另一边自动取反 —— 愤怒与难过就差这个符号 */
function pairEyes(ctx, y, w, h, tilt, lid, dx = EYE_DX) {
  withLid(ctx, y, lid, () => {
    capsule(ctx, 50 - dx, y, w, h, tilt);
    capsule(ctx, 50 + dx, y, w, h, -tilt);
  });
}

/* —— 表情层 ——
   roll 是整张屏的倾斜：面罩是硬的，屏幕里转一个小角度读起来就是头歪了一下，
   bloub 里「好奇」「害羞」这些味道也主要是靠这个倾角带出来的。 */

export const MOODS = [
  /* 静：两条短横线，几乎不动。默认态，看久了不闹 */
  {
    id: 'calm',
    label: 'Calm',
    roll: 0,
    draw(ctx, t) {
      const L = alive(t, 1, 1);
      const y = EYE_Y + L.gy * 0.5;
      ink(ctx, 7);
      pairEyes(ctx, y, 16, 7, 0, L.lid);
      ink(ctx, 4);
      mouth(ctx, 50, MOUTH_Y, 13, 3);
    },
  },

  /* 喜：眼睛拱成 ^ ^，整体轻轻上下浮 */
  {
    id: 'happy',
    label: 'Happy',
    roll: 0,
    draw(ctx, t) {
      const L = alive(t, 1.2, 0.8);
      const bob = Math.sin(t * 2.1) * 1.4;
      const y = EYE_Y + bob + L.gy * 0.4;
      ink(ctx, 7);
      withLid(ctx, y, L.lid, () => {
        arch(ctx, 50 - EYE_DX, y, 17, 8);
        arch(ctx, 50 + EYE_DX, y, 17, 8);
      });
      ink(ctx, 5);
      mouth(ctx, 50, MOUTH_Y - 2 + bob, 20, 9);
    },
  },

  /* 疑：脑袋歪着，眼珠慢慢游，左眉抬起来一撇 */
  {
    id: 'curious',
    label: 'Curious',
    roll: -8,
    draw(ctx, t) {
      const L = alive(t, 1.7, 1.1);
      const y = EYE_Y + L.gy;
      ink(ctx, 5.5);
      withLid(ctx, y, L.lid, () => {
        ring(ctx, 50 - EYE_DX + L.gx * 0.5, y, 7, L.gx, L.gy * 0.4, true);
        ring(ctx, 50 + EYE_DX + L.gx * 0.5, y, 7, L.gx, L.gy * 0.4, true);
      });
      ink(ctx, 3.6);
      ctx.beginPath();
      ctx.moveTo(24, EYE_Y - 19);
      ctx.quadraticCurveTo(33, EYE_Y - 25, 43, EYE_Y - 18);
      ctx.stroke();
      ink(ctx, 4);
      ctx.beginPath();
      ctx.arc(50, MOUTH_Y + 1, 3.4, 0, Math.PI * 2);
      ctx.stroke();
    },
  },

  /* 眨：左眼一直笑闭，右眼睁着偶眨，嘴歪一下 */
  {
    id: 'wink',
    label: 'Wink',
    roll: 3,
    draw(ctx, t) {
      const L = alive(t, 1, 1);
      const y = EYE_Y + L.gy * 0.5;
      ink(ctx, 7);
      arch(ctx, 50 - EYE_DX - 1, y + 1, 17, 8);
      withLid(ctx, y, L.lid, () => {
        ring(ctx, 50 + EYE_DX + 1, y, 7, 0, 0, true);
      });
      ink(ctx, 4.6);
      ctx.beginPath();
      ctx.moveTo(41, MOUTH_Y + 1);
      ctx.quadraticCurveTo(50, MOUTH_Y + 6, 61, MOUTH_Y - 2);
      ctx.stroke();
    },
  },

  /* 聚：内外压低的锐角眼，眉线收紧，偶尔一道扫描线扫过整张屏 */
  {
    id: 'focus',
    label: 'Focus',
    roll: 0,
    draw(ctx, t) {
      const L = alive(t, 0.35, 1.3);
      const q = 0.5 + 0.5 * Math.sin(t * 1.6);
      const y = EYE_Y + L.gy * 0.3;
      ink(ctx, 7);
      withLid(ctx, y, Math.max(0.35, L.lid), () => {
        ctx.beginPath();
        ctx.moveTo(26, y - 4 * q);
        ctx.lineTo(42, y + 3);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(74, y - 4 * q);
        ctx.lineTo(58, y + 3);
        ctx.stroke();
      });
      ink(ctx, 3.2);
      ctx.beginPath();
      ctx.moveTo(43, EYE_Y - 18);
      ctx.lineTo(57, EYE_Y - 18);
      ctx.stroke();

      const p = (t % 4.6) / 4.6;
      if (p < 0.32) {
        const sy = 8 + (p / 0.32) * 98;
        ctx.globalAlpha = 0.3 * Math.sin((p / 0.32) * Math.PI);
        ink(ctx, 1.8);
        ctx.beginPath();
        ctx.moveTo(12, sy);
        ctx.lineTo(88, sy);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ink(ctx, 4.4);
      mouth(ctx, 50, MOUTH_Y, 16, 0);
    },
  },

  /* 惊：眼睛撑到最大，瞳孔细颤，嘴张成小圆 */
  {
    id: 'alert',
    label: 'Alert',
    roll: 0,
    draw(ctx, t) {
      const L = alive(t, 0.6, 0.9);
      const j = Math.sin(t * 24) * 0.7;
      const r = 8 + Math.sin(t * 5) * 0.7;
      ink(ctx, 5);
      withLid(ctx, EYE_Y, L.lid, () => {
        ring(ctx, 50 - EYE_DX, EYE_Y, r, j + L.gx * 0.4, 0, true);
        ring(ctx, 50 + EYE_DX, EYE_Y, r, -j + L.gx * 0.4, 0, true);
      });
      ink(ctx, 4);
      ctx.beginPath();
      ctx.arc(50, MOUTH_Y, 4.6 + Math.sin(t * 5) * 0.5, 0, Math.PI * 2);
      ctx.stroke();
    },
  },

  /* 思：一只眼半眯，另一只眨眼，下面三个点按波浪推进 */
  {
    id: 'think',
    label: 'Think',
    roll: 4,
    draw(ctx, t) {
      const L = alive(t, 0.7, 1);
      const y = EYE_Y + L.gy * 0.4;
      ink(ctx, 6);
      capsule(ctx, 50 - EYE_DX, y + 1, 15, 4.4, 0);
      withLid(ctx, y, L.lid, () => {
        ring(ctx, 50 + EYE_DX, y, 6, L.gx * 0.8, 0, false);
      });
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = 0.3 + 0.7 * Math.max(0, Math.sin(t * 3 - i * 0.9));
        ctx.beginPath();
        ctx.arc(42 + i * 8, MOUTH_Y + 1, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
  },

  /* 眠：两只眼下垂闭着，右侧三个 z 往上飘 */
  {
    id: 'sleep',
    label: 'Sleep',
    roll: -3,
    draw(ctx, t) {
      ink(ctx, 6);
      arch(ctx, 50 - EYE_DX, EYE_Y, 17, -5);
      arch(ctx, 50 + EYE_DX, EYE_Y, 17, -5);
      for (let i = 0; i < 3; i++) {
        const p = (t * 0.42 + i / 3) % 1;
        const x = 60 + p * 15;
        const y = 92 - p * 56;
        ctx.globalAlpha = Math.sin(p * Math.PI) * 0.85;
        ctx.lineWidth = 2 + p * 2.4;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 9, y);
        ctx.lineTo(x, y + 9);
        ctx.lineTo(x + 9, y + 9);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
  },

  /* 怒：上端往中间压（眯成两道斜口），眉骨再压一层，嘴是短促的下弯。
     每隔两秒多攥紧一次，眼睛更窄、斜得更狠 */
  {
    id: 'angry',
    label: 'Angry',
    roll: 0,
    draw(ctx, t) {
      const L = alive(t, 0.35, 0.9);
      const clench = 0.5 + 0.5 * Math.sin(t * 1.7);
      const tilt = 24 + clench * 9;
      const y = EYE_Y + L.gy * 0.3;
      ink(ctx, 7);
      withLid(ctx, y, Math.max(0.3, L.lid), () => {
        capsule(ctx, 50 - EYE_DX, y, 16, 4.4 + clench * 1.4, tilt);
        capsule(ctx, 50 + EYE_DX, y, 16, 4.4 + clench * 1.4, -tilt);
      });
      /* 眉：比眼睛更陡，两撇朝中间收 */
      ink(ctx, 3.6);
      ctx.beginPath();
      ctx.moveTo(27, y - 15);
      ctx.lineTo(42, y - 9);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(73, y - 15);
      ctx.lineTo(58, y - 9);
      ctx.stroke();
      ink(ctx, 4.4);
      mouth(ctx, 50, MOUTH_Y + 2, 14, -4);
    },
  },

  /* 哀：上端往两边散、视线往下掉，眉跟着塌 */
  {
    id: 'sad',
    label: 'Sad',
    roll: 0,
    draw(ctx, t) {
      const L = alive(t, 0.7, 0.8);
      const y = EYE_Y + 1 + L.gy * 0.6 + 1;
      ink(ctx, 6.4);
      withLid(ctx, y, Math.max(0.25, L.lid), () => {
        capsule(ctx, 50 - EYE_DX, y, 13, 9, -24);
        capsule(ctx, 50 + EYE_DX, y, 13, 9, 24);
      });
      ink(ctx, 3.4);
      ctx.beginPath();
      ctx.moveTo(27, y - 13);
      ctx.quadraticCurveTo(34, y - 11, 41, y - 16);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(73, y - 13);
      ctx.quadraticCurveTo(66, y - 11, 59, y - 16);
      ctx.stroke();
      ink(ctx, 4.2);
      mouth(ctx, 50, MOUTH_Y + 1, 15, -5);
    },
  },

  /* 惧：眼睛最大、瞳孔缩得很小，视线往下躲，整张屏有一点点抖 */
  {
    id: 'scared',
    label: 'Scared',
    roll: 0,
    draw(ctx, t) {
      const L = alive(t, 0.5, 1.8);
      const tr = hash(Math.floor(t * 22)) * 0.7;
      const y = EYE_Y + 2 + L.gy * 0.5 + tr;
      ink(ctx, 4.6);
      withLid(ctx, y, L.lid, () => {
        ring(ctx, 50 - EYE_DX + tr * 0.6, y, 9.5, L.gx * 0.5, 2.2, true);
        ring(ctx, 50 + EYE_DX + tr * 0.6, y, 9.5, L.gx * 0.5, 2.2, true);
      });
      ink(ctx, 4);
      ctx.beginPath();
      ctx.arc(50, MOUTH_Y + 1, 5, 0, Math.PI * 2);
      ctx.stroke();
    },
  },

  /* 疑心：一只眼眯成缝、一只睁着，视线往一边斜看，斜到某侧时停住 */
  {
    id: 'suspicious',
    label: 'Suspicious',
    roll: 0,
    draw(ctx, t) {
      const L = alive(t, 0.3, 1.1);
      const side = Math.tanh(Math.sin(t * 0.45) * 2.4);   /* 大部分时间停在一侧 */
      const gx = side * 3.4;
      const y = EYE_Y + L.gy * 0.3;
      ink(ctx, 6.4);
      withLid(ctx, y, Math.max(0.3, L.lid), () => {
        capsule(ctx, 50 - EYE_DX, y, 15, 3.4, -8);
        capsule(ctx, 50 + EYE_DX, y, 13, 9, 8);
      });
      /* 只抬一边的眉 */
      ink(ctx, 3.4);
      ctx.beginPath();
      ctx.moveTo(57, y - 17);
      ctx.quadraticCurveTo(65, y - 20, 73, y - 14);
      ctx.stroke();
      ink(ctx, 4.2);
      ctx.beginPath();
      ctx.moveTo(44 + gx, MOUTH_Y + 1);
      ctx.lineTo(58 + gx, MOUTH_Y - 1);
      ctx.stroke();
    },
  },

  /* 惑：两只眼大小倾斜都不一样，嘴是一道歪的波浪，头微微歪着 */
  {
    id: 'confused',
    label: 'Confused',
    roll: 7,
    draw(ctx, t) {
      const L = alive(t, 1.8, 1.2);
      const wob = Math.sin(t * 0.8) * 2.2;
      const y = EYE_Y + L.gy;
      ink(ctx, 5.4);
      withLid(ctx, y, L.lid, () => {
        capsule(ctx, 50 - EYE_DX, y, 10, 13, -16);
        capsule(ctx, 50 + EYE_DX, y + 1, 15, 5, 14);
      });
      ink(ctx, 4);
      ctx.beginPath();
      ctx.moveTo(39, MOUTH_Y + 1);
      ctx.quadraticCurveTo(45, MOUTH_Y - 4, 50, MOUTH_Y + 1);
      ctx.quadraticCurveTo(55, MOUTH_Y + 6, 61, MOUTH_Y);
      ctx.stroke();
      ink(ctx, 3.4);
      ctx.beginPath();
      ctx.moveTo(74, EYE_Y - 24 + wob * 0.2);
      ctx.lineTo(80, EYE_Y - 29 + wob * 0.2);
      ctx.stroke();
    },
  },

  /* 傲：眼睛窄而斜、视线上抬，嘴一边翘起来，偶尔抬一下下巴 */
  {
    id: 'proud',
    label: 'Proud',
    roll: -5,
    draw(ctx, t) {
      const L = alive(t, 0.6, 0.8);
      const chin = Math.sin(t * 0.9) * 0.9;
      const y = EYE_Y - 2 + L.gy * 0.4 - chin;
      ink(ctx, 6.2);
      withLid(ctx, y, L.lid, () => {
        capsule(ctx, 50 - EYE_DX, y, 15, 4.6, 16);
        capsule(ctx, 50 + EYE_DX, y, 15, 4.6, -16);
      });
      ink(ctx, 4.2);
      ctx.beginPath();
      ctx.moveTo(43, MOUTH_Y - 2 + chin);
      ctx.quadraticCurveTo(52, MOUTH_Y + 4 + chin, 60, MOUTH_Y - 4 + chin);
      ctx.stroke();
    },
  },

  /* 怯：眼睛小小的、往下躲，头低着；隔一阵飞快抬眼偷看一眼再收回去 */
  {
    id: 'shy',
    label: 'Shy',
    roll: -7,
    draw(ctx, t) {
      const L = alive(t, 0.9, 1.2);
      const peek = Math.pow(Math.max(0, Math.sin(t * 0.62)), 6);   /* 一下一下地抬眼 */
      const y = EYE_Y + 3 + L.gy * 0.6 - peek * 4;
      ink(ctx, 6);
      withLid(ctx, y, Math.max(0.2, L.lid * (1 - peek * 0.15)), () => {
        capsule(ctx, 50 - EYE_DX, y, 11, 8, -6);
        capsule(ctx, 50 + EYE_DX, y, 11, 8, 6);
      });
      ink(ctx, 3.8);
      mouth(ctx, 52, MOUTH_Y + 3, 9, 2.4);
      /* 两颊各一道淡弧，抬眼看人时亮一点 —— 别画成整圆，整圆会读成眼镜 */
      ink(ctx, 2.6);
      ctx.globalAlpha = 0.16 + peek * 0.22;
      ctx.beginPath();
      ctx.arc(31, MOUTH_Y - 2, 4, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(69, MOUTH_Y - 2, 4, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
      ctx.globalAlpha = 1;
    },
  },

  /* 厌：两条细缝、视线扫到一边，眨得很慢，每隔几秒整张脸往下沉一口气 */
  {
    id: 'bored',
    label: 'Bored',
    roll: 2,
    draw(ctx, t) {
      const L = alive(t, 0.8, 0.55);
      const sigh = Math.pow(Math.max(0, Math.sin(t * 0.42)), 3);
      const y = EYE_Y + sigh * 2.4 + L.gy * 0.25;
      ink(ctx, 6.6);
      withLid(ctx, y, Math.max(0.12, L.lid), () => {
        capsule(ctx, 50 - EYE_DX, y, 15, 2.6, 0);
        capsule(ctx, 50 + EYE_DX, y, 15, 2.6, 0);
      });
      ink(ctx, 4);
      mouth(ctx, 52, MOUTH_Y + 2, 14, -1.5);
    },
  },
];

const byId = (id) => MOODS.find((m) => m.id === id) || MOODS[0];

/* 底色：默认清成透明 —— 缩略图不画自己的底，要透出卡里那块矩形底色；
   传 bg 才铺一层。3D 面罩吃的是 emissiveMap，必须铺黑，
   黑色对自发光就是「不发光」 */
function frame(ctx, w, h, bg) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, w, h);
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.setTransform(w / VW, 0, 0, h / VH, 0, 0);
}

/* 墨色：五官默认白（面罩上只能是白，别的颜色都会暗一档）。
   缩略图另给两支 —— 平时取 --text-secondary 与左栏图标同色，
   选中时取 --panel 与卡片填充同色，见下面的 thumbInk / thumbInkOn */
let inkColor = '#fff';

/* 把某个表情画到任意尺寸的画布上，再按虚拟画布比例落笔 */
export function paint(ctx, w, h, id, t, opts) {
  const o = opts || {};
  inkColor = o.ink || '#fff';
  const mood = byId(id);
  frame(ctx, w, h, o.bg);
  if (mood.roll) {
    ctx.translate(VW / 2, VH / 2);
    ctx.rotate((mood.roll * Math.PI) / 180);
    ctx.translate(-VW / 2, -VH / 2);
  }
  mood.draw(ctx, t);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/* —— 一次性的覆盖表情 ——
   不进 MOODS、也不出现在右栏缩略图里，只接管 3D 面罩一小会儿。
   到点自己失效，draw 每帧查一次表，不需要额外的定时器；
   这样即使中间切换了语言、切了表情，也不会留下一个卡住的图案。 */
let flash = null;

export function flashFace(draw, ms) {
  const now = performance.now();
  flash = {draw, t0: now, until: now + (ms || 900)};
}

export function clearFlash() {
  flash = null;
}

/* 主题色：面罩吃的是 emissiveMap，画什么颜色就发什么光 */
function themeColor() {
  const root = getComputedStyle(document.documentElement);
  const dark = document.documentElement.dataset.theme === 'dark';
  return root.getPropertyValue(dark ? '--theme-dark' : '--theme').trim() || '#91d2c3';
}

/* 勾：一笔画出来。起笔 0.2s 走完，之后停住，退场按剩余时间淡掉 */
export function flashCheck(ms) {
  const color = themeColor();
  flashFace((ctx, e, fade) => {
    const k = Math.min(1, e / 0.2);
    const grow = 0.88 + 0.12 * (1 - Math.pow(1 - k, 3));
    const A = {x: 27, y: 57};
    const B = {x: 43, y: 74};
    const C = {x: 73, y: 33};
    const s1 = Math.hypot(B.x - A.x, B.y - A.y);
    const s2 = Math.hypot(C.x - B.x, C.y - B.y);
    const len = (s1 + s2) * k;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.translate(50, 57);
    ctx.scale(grow, grow);
    ctx.translate(-50, -57);

    const stroke = (width, alpha) => {
      ctx.globalAlpha = alpha * fade;
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      if (len <= s1) {
        const q = len / s1;
        ctx.lineTo(A.x + (B.x - A.x) * q, A.y + (B.y - A.y) * q);
      } else {
        ctx.lineTo(B.x, B.y);
        const q = Math.min(1, (len - s1) / s2);
        ctx.lineTo(B.x + (C.x - B.x) * q, B.y + (C.y - B.y) * q);
      }
      ctx.stroke();
    };

    stroke(17, 0.22);   /* 外面先罩一层淡的，屏上看着像自己会亮 */
    stroke(9.5, 1);
    ctx.globalAlpha = 1;
  }, ms || 820);
}

/* 下载：一支箭头落进托盘。拖动卡片时一直挂在屏上（until 给到无穷，
   由调用方 clearFlash 收尾），松手接住的那一刻换成思考脸 */
export function flashDownload() {
  const color = themeColor();
  flashFace((ctx, e) => {
    /* 箭头轻轻往下探一点，屏上就不是一张死图；托盘不动 */
    const bob = Math.sin(e * 2.2) * 1.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const paint = (width, alpha, fn) => {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.beginPath();
      fn();
      ctx.stroke();
    };

    const arrow = () => {
      ctx.moveTo(50, 26 + bob);
      ctx.lineTo(50, 60 + bob);
      ctx.moveTo(37, 47 + bob);
      ctx.lineTo(50, 60 + bob);
      ctx.lineTo(63, 47 + bob);
    };
    const tray = () => {
      ctx.moveTo(32, 70);
      ctx.lineTo(32, 78);
      ctx.lineTo(68, 78);
      ctx.lineTo(68, 70);
    };

    paint(17, 0.22, () => { arrow(); tray(); });   /* 外面罩一层淡的，看着像自己在发光 */
    paint(9.5, 1, arrow);
    paint(9.5, 1, tray);
    ctx.globalAlpha = 1;
  }, Infinity);
}

/* 给 3D 那张贴图用：一块固定尺寸的画布 + 一个按当前表情重绘的入口 */
export function createScreen(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const t0 = performance.now();

  function render(seconds) {
    if (flash && performance.now() < flash.until) {
      frame(ctx, w, h, '#000');
      const left = (flash.until - performance.now()) / 1000;
      /* 最后 0.16s 淡出，勾消失时不会硬切回眼睛 */
      flash.draw(ctx, seconds, left < 0.16 ? Math.max(0, left / 0.16) : 1);
      ctx.globalAlpha = 1;
      return;
    }
    if (flash) flash = null;
    /* 面罩要黑底白脸：底色不黑，emissiveMap 上整块都会发光 */
    paint(ctx, w, h, current, seconds, {bg: '#000', ink: '#fff'});
  }

  return {
    canvas,
    draw(seconds) { render(seconds); },
    /* 按「从建屏到现在」算时间，切换表情时图案从同一相位重新开始 */
    drawNow() { render((performance.now() - t0) / 1000); },
  };
}

/* —— 选择状态 —— */

let current = 'calm';
try {
  const saved = localStorage.getItem(STORE);
  if (saved && MOODS.some((m) => m.id === saved)) current = saved;
} catch (e) {}

const listeners = [];
const cards = [];

export const moodId = () => current;

export function onMood(fn) {
  listeners.push(fn);
}

export function setMood(id, options = {}) {
  if (!MOODS.some((m) => m.id === id) || id === current) return;
  current = id;
  if (options.persist !== false) { try { localStorage.setItem(STORE, id); } catch (e) {} }
  cards.forEach((c) => {
    const on = c.dataset.mood === id;
    c.classList.toggle('is-on', on);
    c.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  /* 选中态换的是墨色，不用等下一轮 70ms 的重绘：这里立刻把这几张重画一遍，
     点下去那一拍就变色 */
  const now = performance.now() / 1000;
  cards.forEach((c) => { if (c.ctx) paintThumb(c, now); });
  listeners.forEach((fn) => fn(id, options.source || 'user'));
}

/* —— 缩略图：底栏 Emotions 那一列的卡 —— */

const THUMB_W = 96;     /* 两倍于 48 的显示尺寸，缩放屏上不发毛 */
const THUMB_H = 112;

/* 缩略图的墨色：屏上不铺底，五官直接用 --text-secondary，
   和左栏那排图标一个色，深浅两套主题自动跟着翻。
   选中时卡底铺满 theme，墨改画 --panel —— 也就是卡片自己的填充色，
   五官看起来像从卡面上镂出来的一块，跟面板、胶囊是同一支底色。
   这里要的是不透明的那份：--panel 本身带 .75 / .80 的透明度，
   原样画上去五官会透出 theme 的绿、边缘发虚，所以读出来先把 alpha 抹掉。
   颜色在这里算、不靠 CSS 的 invert 滤镜：滤镜翻的是当前这支墨（text-secondary），
   翻出来对不上 panel 的色相 */
let thumbInk = '#2d2d2d';
let thumbInkOn = '#fafafa';
let themeSeen = '';

/* 只取颜色的前三个通道，丢掉透明度：#rrggbbaa / #rgba / rgba() 都收成不透明形式。
   canvas 的 fillStyle 不做这层折算，直接喂进去会按 alpha 混合 */
function opaque(color) {
  const c = color.trim();
  const fn = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) return 'rgb(' + parts.slice(0, 3).join(',') + ')';
    return c;
  }
  const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(c);
  if (hex) {
    const h = hex[1];
    /* #RGBA 的每一位都要展开成两位，#RRGGBBAA 只需砍掉尾巴 */
    return h.length === 4
      ? '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
      : '#' + h.slice(0, 6);
  }
  return c;
}

function readThumbInk() {
  const root = document.documentElement;
  const now = root.dataset.theme === 'dark' ? 'dark' : 'light';
  if (now === themeSeen) return;
  themeSeen = now;
  const cs = getComputedStyle(root);
  const v = cs.getPropertyValue('--text-secondary').trim();
  if (v) thumbInk = v;
  const p = cs.getPropertyValue('--panel').trim();
  if (p) thumbInkOn = opaque(p);
}

function paintThumb(card, seconds) {
  paint(card.ctx, THUMB_W, THUMB_H, card.dataset.mood, seconds, {
    ink: card.classList.contains('is-on') ? thumbInkOn : thumbInk,
  });
}

let running = false;
let lastPaint = 0;

function loop(ts) {
  requestAnimationFrame(loop);
  if (document.hidden || ts - lastPaint < 70) return;
  /* 右栏收着的时候屏根本没露出来，画了也白画 */
  const rail = document.getElementById('rail-tools');
  if (rail && !rail.classList.contains('is-open')) return;
  lastPaint = ts;
  readThumbInk();
  const t = ts / 1000;
  for (const c of cards) paintThumb(c, t);
}

function mount() {
  const grid = document.querySelector('[data-rail-grid="emotions"]');
  if (!grid) return;
  readThumbInk();

  /* 卡片是 rails.js 先铺的空白占位，这里只往里面塞屏，不换节点 ——
     磁吸脚本已经把这些卡收进自己的列表，换掉 DOM 就得重扫一遍 */
  Array.prototype.slice.call(grid.children, 0, MOODS.length).forEach((card, i) => {
    const mood = MOODS[i];

    /* 屏是「矩形 + 画布」两层：
       .mood__scr 只负责量出那块 96:112 的区域，底色和描边一概没有，
       画布透明，五官压在最后 —— 脸就这么浮在卡面上。
       hover / 选中时亮起的是卡的边框（CSS 那侧），跟这块屏无关 */
    const scr = document.createElement('span');
    scr.className = 'mood__scr';
    const cv = document.createElement('canvas');
    cv.className = 'mood__cv';
    cv.width = THUMB_W;
    cv.height = THUMB_H;
    scr.appendChild(cv);
    card.appendChild(scr);

    card.classList.add('is-mood');
    card.classList.toggle('is-on', mood.id === current);
    card.dataset.mood = mood.id;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-pressed', mood.id === current ? 'true' : 'false');
    /* 只留 aria-label 给读屏；不写 title —— 那会在 hover 时弹一个黑底名字框，
       和底栏这套磨砂面板的气质不搭，名字本身也是英文，不如不显示 */
    card.setAttribute('aria-label', mood.label);
    card.removeAttribute('aria-hidden');

    card.addEventListener('click', () => setMood(mood.id));
    card.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      setMood(mood.id);
    });

    card.ctx = cv.getContext('2d');
    cards.push(card);
    /* 先落一帧静止的脸：静止帧模式下循环压根不跑，这一帧就是全部；
       描边那圈是 CSS 的活，不需要在这里跟着状态重画 */
    paintThumb(card, 0.5);
  });

  /* 系统里开了「减少动态效果」就只画一帧静态的，不跑循环 */
  if (cards.length && !running && !STILL) {
    running = true;
    requestAnimationFrame(loop);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
