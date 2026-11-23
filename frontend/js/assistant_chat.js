(function () {
  'use strict';

  var composer = document.querySelector('.composer');
  if (composer && composer.parentElement !== document.body) {
    document.body.appendChild(composer);
  }
  var panel = document.querySelector('[data-assistant-chat]') ||
    (composer && composer.querySelector('[data-assistant-chat]'));
  if (!composer || !panel) return;
  function findInPanel(selector) {
    return typeof panel.querySelector === 'function'
      ? panel.querySelector(selector)
      : composer.querySelector(selector);
  }
  var log = findInPanel('[data-assistant-log]');
  var input = composer.querySelector('[data-assistant-input]');
  var sendButton = composer.querySelector('[data-assistant-send]');
  /* 面板底部那条输入：与页面底部的主输入条共用下面的 send()，
     各自保留自己的草稿和按钮态。取不到就只是少一条入口 */
  var dockInput = document.querySelector('[data-chat-dock-input]');
  var dockSend = document.querySelector('[data-chat-dock-send]');
  var settingsButton = document.querySelector('[data-chat-settings]');
  var historyMenu = document.querySelector('[data-chat-history-menu]');
  /* 齿轮所在的那块 dock：开合时给它挂 is-open，panels.js 的 pop 与
     CSS 的宽高过渡都认这个类。取不到（老页面 / 单测里的假 DOM）就只切
     hidden，不影响下面任何一条逻辑 */
  var historyDock = document.querySelector('[data-chat-dock]');
  var exportButton = document.querySelector('[data-chat-export]');
  var clearButton = document.querySelector('[data-chat-clear]');
  /* 停止动作那枚按钮挂在聊天视图的头部动作区，是 [data-assistant-chat] 的
     兄弟节点，findInPanel 抓不到；只按面板找会拿到 null，下面的守卫直接把
     整个脚本退掉，快捷胶囊、发送、清空就全没反应。这里补一层文档兜底 */
  var stopButton = findInPanel('[data-assistant-stop]') ||
    document.querySelector('[data-assistant-stop]');
  var voiceButton = composer.querySelector('[data-assistant-voice]');
  var speechToggle = composer.querySelector('[data-assistant-speech-toggle]');
  var speechStop = findInPanel('[data-assistant-speech-stop]') ||
    document.querySelector('[data-assistant-speech-stop]');
  var suggestions = document.querySelector('[data-chat-suggestions]');
  var historyButton = composer.querySelector('[data-chat-history]');
  var stage = document.querySelector('[data-stage-chat]');
  if (!log || !input || !sendButton || !settingsButton || !historyMenu ||
      !clearButton || !stopButton) return;

  /* 发送钮里那两枚箭头叠在同一个格子上（见 chat.css 尾部的 composer-send-*），
     is-flying 一挂就是一次「发出去」的动画，收尾在 animationend。
     测试里的假按钮没有 querySelector，所以先问一句有没有 */
  var sendIcon = typeof sendButton.querySelector === 'function'
    ? sendButton.querySelector('.composer__send-icon')
    : null;
  var dockIcon = dockSend && typeof dockSend.querySelector === 'function'
    ? dockSend.querySelector('.composer__send-icon')
    : null;
  /* 最后一次把光标落在哪条输入里：发送完要还回同一处，
     顺带决定是哪一枚发送钮做飞箭头的动作 */
  var dockFocus = false;

  var queryApi = new URLSearchParams(location.search).get('api');
  var api = queryApi ? queryApi.replace(/\/+$/, '') : '/api/v1';
  var history = [];
  var records = [];
  var restoring = false;
  var pending = false;
  var sequenceToken = 0;
  var STARTED_KEY = 'primebotx.chat.started';
  /* 清空的二次确认：与账号面板的退出登录同一条时间常量（auth.js 的
     LOGOUT_HOLD 3s）。这段时间里指针进出都不算信号，只有「再点一次」才执行 */
  var CLEAR_HOLD = 3000;
  var clearArmed = false;
  var clearTimer = 0;
  var welcomeShown = false;
  var welcomeMotionPlayed = false;
  var SPEECH_KEY = 'primebotx.chat.speech.enabled';
  var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var recognition = null;
  var listening = false;
  var voiceStarting = false;
  var voiceBaseText = '';
  var activeUtterance = null;
  var activeAudio = null;
  var activeAudioUrl = '';
  var speechRequestToken = 0;
  var speechAbort = null;
  var browserSpeechSupported = !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
  var speechSupported = !!window.Audio || browserSpeechSupported;
  var speechEnabled = true;
  try {
    if (localStorage.getItem(SPEECH_KEY) === '0') speechEnabled = false;
  } catch (_error) {}

  function stateDirty() {
    if (!restoring && window.dispatchEvent && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('primebotx-state-dirty'));
    }
  }

  function tr(key, fallback) {
    var value = typeof window.t === 'function' ? window.t(key) : '';
    return value && value !== key ? value : fallback;
  }

  function scrollBottom() {
    log.scrollTop = log.scrollHeight;
    syncChatScrollState();
    requestAnimationFrame(function () {
      log.scrollTop = log.scrollHeight;
      syncChatScrollState();
    });
  }

  /* 只有真的可滚时才显示首尾渐隐，短对话不会被无端压暗。 */
  function syncChatScrollState() {
    var max = Math.max(0, (log.scrollHeight || 0) - (log.clientHeight || 0));
    log.setAttribute('data-scroll', max > 1 ? 'on' : 'off');
  }

  /* 舞台只有一条流：问答按顺序落在同一根时间轴上，靠哪边由角色决定。
     行容器负责对齐与透视，气泡挂在行里（见 css/chat.css 的 .stage-chat__row） */
  function stageStream() {
    return stage && stage.querySelector('[data-stage-stream]');
  }

  function decorateBubble(node, role, recordId) {
    if (!node || !node.dataset) return;
    var salt = role === 'user' ? 1 : 0;
    var variant = (Number(recordId || 0) + salt) % 4;
    node.dataset.bubbleVariant = String(variant);
    node.dataset.author = role === 'user' ? tr('chat.you', '你') : 'PrimebotX';
  }

  /* 舞台不再滚动：一屏只留最近三组（一问一答算一组），更早的一条在
     第 7 条落位时缩小淡出，把占位让出来。
     退场拆成两条互不拖累的通道，都交给 GSAP 的一条时间线：
     ① 那条气泡当场脱离文档流，一路往上飘、收到 0.78 时带一点回弹、透明度
        慢慢减到 0。它的盒子不再参与排版，缩放就不会被「收高」碾成一条线，
        rotateY 的倾角也不会被改写 transform 拍平 —— 全程只动三个 CSS 变量；
     ② 原地留一枚同高的空占位，高度连同下面那 12 的缝一起折回 0，后面的
        气泡顺着排版平滑顶上来。这条也只在占位上改高度，气泡本身不做逐帧
        变换，两层动画各走各的，不会互相抢帧。

     一次要退两条时不能同时开场：两条都被钉在原来的位置上，下面那一批又会
     一起被顶上来，第二条就正好被后来的气泡压在下面（它自己还在原地淡出）。
     所以退场排成队列，前一条连同占位收完，才让下一条走 —— 每一条都走完整
     的「上浮 + 缩到 0.78 + 淡出 + 占位收高」，一屏仍是三组，只是逐条让位。
     排队的那条不等在原地：一入队就从满格匀速淡到一半，等前面让位演完、轮到
     它时再从一半接着淡到 0 —— 淡出跟着让位一起走，接缝处不空一拍 */
  var STAGE_GROUPS = 3;
  var STAGE_LIMIT = STAGE_GROUPS * 2;
  /* 上浮与收量 0.62s，占位收高 0.68s，透明度在后半段走完。
     旧版是 0.42 / 0.3 两条 CSS 过渡，收得比读起来还快 */
  var STAGE_LEAVE_S = 0.62;
  var STAGE_COLLAPSE_S = 0.68;
  var STAGE_LEAVE_Y = -20;
  var STAGE_LEAVE_SCALE = 0.78;
  var STAGE_REDUCE = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)');

  /* 已经在退场、或者排着队等退场的气泡都不算「在流里」：计数、取最旧一条、
     按 id 复用都只认还留在台上的那些 */
  var STAGE_ALIVE = '.stage-chat__bubble:not(.is-leaving):not([data-stage-exit])';

  function stageLive(stream) {
    return stream.querySelectorAll(STAGE_ALIVE).length;
  }

  function stageOldest(stream) {
    return stream.querySelector(STAGE_ALIVE);
  }

  /* 退场队列：同一批里排第二、第三条的，等前一条把占位收完再走 —— 两条同时
     钉在原地，下面顶上来的一头就会撞进它身上。走位排队，淡出不排队：等在
     后面的那条一入队就先淡下去，轮到自己时接着往下走 */
  var stageExitQueue = [];
  var stageExitBusy = false;
  /* 排队那条先淡到这里：前一条把占位收完要 0.68s，这段时间它匀速走到一半，
     轮到它时后半段再从一半匀速走到 0 —— 两段斜率一样，接缝处看不出停顿 */
  var STAGE_QUEUE_DIM = 0.5;

  /* 排队期间的预淡：只动 --exit-o，不动位置。它还在流里，被前一条的占位
     顶着往上走的那一段，同时就在变淡 —— 让位与淡出是同一段时间里的两件事，
     不会出现「先站着不动，轮到了才开始淡」的空档 */
  function preDimStage(node) {
    if (!node || !window.gsap) return;
    if (STAGE_REDUCE && STAGE_REDUCE.matches) return;
    var from = parseFloat(
      window.getComputedStyle(node).getPropertyValue('--exit-o')
    );
    if (!isFinite(from)) from = 1;
    if (from <= STAGE_QUEUE_DIM) return;
    node.style.setProperty('--exit-o', String(from));
    window.gsap.to(node, {
      '--exit-o': STAGE_QUEUE_DIM,
      duration: STAGE_COLLAPSE_S,
      ease: 'none'
    });
  }

  function stageDiscard(node) {
    if (!node) return;
    if (bubbleWatcher) bubbleWatcher.unobserve(node);
    if (node.parentNode) node.parentNode.removeChild(node);
  }

  function pumpStageExit() {
    if (stageExitBusy) return;
    while (stageExitQueue.length) {
      var next = stageExitQueue.shift();
      if (!next || !next.parentNode || next.classList.contains('is-leaving')) continue;
      stageExitBusy = true;
      leaveStage(next, function () {
        stageExitBusy = false;
        pumpStageExit();
      });
      return;
    }
  }

  function queueStageExit(node) {
    if (!node || node.dataset.stageExit) return;
    /* 回放历史时一次灌进来几十条：这时候不排队做动画，直接把早的摘掉，
       否则光让位就要演上一分多钟 */
    if (restoring) {
      stageDiscard(node);
      return;
    }
    node.dataset.stageExit = '1';
    stageExitQueue.push(node);
    /* 前面还有一条在退：这条从此刻起就开始淡，而不是等轮到自己才动 */
    if (stageExitBusy) preDimStage(node);
    pumpStageExit();
  }

  function leaveStage(node, done) {
    if (!node || node.classList.contains('is-leaving')) {
      if (done) done();
      return;
    }
    var stream = node.parentNode;
    if (!stream) {
      if (done) done();
      return;
    }

    /* 量的是排版值，不是投影后的外框：气泡还挂着 rotateY + 父级的透视，
       getBoundingClientRect 拿到的是被透视压过的那一圈，宽度会偏窄。
       宽高取 computed（带小数，写回去不会让文字重排），位置取 offset*
       （相对这一列的内边距边，正好是绝对定位的参照） */
    var style = window.getComputedStyle(node);
    var height = parseFloat(style.height) || node.offsetHeight;
    var width = parseFloat(style.width) || node.offsetWidth;
    var left = node.offsetLeft;
    var top = node.offsetTop;
    var gap = parseFloat(
      window.getComputedStyle(stream).getPropertyValue('--stage-gap')
    ) || 12;

    /* 排过队的那条已经淡了一截：记下当下的不透明度，散场时从这里接着走。
       写回 1 会让前面那段淡出白演，还会在接缝处亮跳一下 */
    var fromO = parseFloat(style.opacity);
    if (!isFinite(fromO) || fromO > 1) fromO = 1;
    if (fromO < 0) fromO = 0;
    /* 位移同理：它可能正被上一条顶上去（--exit-y 还是正数），钉成绝对定位
       时若不认这段，会当场往上跳一截再开始退场 */
    var fromY = parseFloat(node.style.getPropertyValue('--exit-y'));
    if (!isFinite(fromY)) fromY = 0;

    node.classList.add('is-leaving');
    node.setAttribute('aria-hidden', 'true');
    if (bubbleWatcher) bubbleWatcher.unobserve(node);

    /* 占位先顶上，再让气泡离场。两步在同一帧里走完、中间不落一次绘制，
       后面的气泡就不会先塌一下再补回来 */
    var spacer = document.createElement('div');
    spacer.className = 'stage-chat__spacer';
    spacer.style.height = height + 'px';
    stream.insertBefore(spacer, node);

    node.style.position = 'absolute';
    node.style.left = left + 'px';
    node.style.top = top + 'px';
    node.style.width = width + 'px';
    node.style.margin = '0';

    var removed = false;
    var drop = function () {
      if (removed) return;
      removed = true;
      if (window.gsap) {
        window.gsap.killTweensOf(node);
        window.gsap.killTweensOf(spacer);
      }
      if (spacer.parentNode) spacer.remove();
      node.remove();
      /* 摘干净了才放行下一条：队列靠这一声回调往下走 */
      if (done) done();
    };

    /* 没有动画库、或者系统要求减少动态：不留中间态，直接让位 */
    if (!window.gsap || (STAGE_REDUCE && STAGE_REDUCE.matches)) {
      drop();
      return;
    }

    var engine = window.gsap;
    /* 排队时那段淡出还挂在元素上，先收掉；下面这条时间线接管同一批变量 */
    engine.killTweensOf(node);
    /* 起点先落到内联样式上，补间读到的就是确定的数，不去猜样式表里的初值 */
    node.style.setProperty('--exit-y', fromY + 'px');
    node.style.setProperty('--exit-s', '1');
    node.style.setProperty('--exit-o', String(fromO));

    var tl = engine.timeline({ onComplete: drop });

    /* 上浮距离按位置收敛：这条要是已经贴在列顶，就不能再往上顶，
       否则会被列的 overflow 切掉一截。缩放会把上沿往下带
       (1 - 0.78) × 高 / 2，这段余量也算进去 */
    var room = top + (1 - STAGE_LEAVE_SCALE) * height / 2 - 2;
    var rise = Math.max(0, Math.min(Math.abs(STAGE_LEAVE_Y), room));

    /* 往上飘：两头慢、中间快，一路走满 0.62s；不要那种一上来就冲到底的收法 */
    tl.to(node, {
      '--exit-y': -rise + 'px',
      duration: STAGE_LEAVE_S,
      ease: 'power2.inOut'
    }, 0);
    /* 弹性缩小：一路匀匀收进来，末了过一点点再回位 —— 像被轻轻压了一下。
       elastic 的前段太快（头 0.1 秒就把八成的量走完），和「上移一段距离」对不上，
       所以这里用 back 的单次过冲顶替 */
    tl.to(node, {
      '--exit-s': STAGE_LEAVE_SCALE,
      duration: STAGE_LEAVE_S,
      ease: 'back.out(1.6)'
    }, 0);
    if (fromO < 0.999) {
      /* 排队时已经在淡的那条：剩下的量按占位收高的节奏匀速走完，占位落到
         底时正好归零 —— 接得上前面那半段，也不会在下一条顶到它位置时留影子 */
      tl.to(node, {
        '--exit-o': 0,
        duration: STAGE_COLLAPSE_S,
        ease: 'none'
      }, 0);
    } else {
      /* 透明度：慢起、后段加速，飘到一半才明显变淡，不会一上来就发虚 */
      tl.to(node, {
        '--exit-o': 0,
        duration: STAGE_LEAVE_S * 0.8,
        ease: 'power1.in'
      }, STAGE_LEAVE_S * 0.15);
    }
    /* 占位收高：高度与那 12 的缝一起折回 0，下面的气泡匀速顶上来 */
    tl.to(spacer, {
      height: 0,
      marginBottom: -gap,
      duration: STAGE_COLLAPSE_S,
      ease: 'power2.inOut'
    }, 0);

    /* 标签页被挂起时补间停摆：这条兜底把占位收掉，别让它一直留在流里 */
    setTimeout(drop, (STAGE_COLLAPSE_S + 0.5) * 1000);
  }

  function trimStage(stream) {
    var live = stageLive(stream);
    if (live <= STAGE_LIMIT) return;
    /* 一次退一整组：只多出一条时也带走两条，否则裁掉半组、
       留下一开头就是机器人的半截问答，读起来像丢了问题 */
    var drop = Math.ceil((live - STAGE_LIMIT) / 2) * 2;
    /* 进队列而不是当场开演：同一批里第二条要等第一条收完占位再走，
       两条同时钉在原地会让下面顶上来的一头撞进它身上 */
    for (var i = 0; i < drop; i += 1) {
      var oldest = stageOldest(stream);
      if (!oldest) return;
      queueStageExit(oldest);
    }
  }

  /* 相机跟着视口走，不写死：镜头架在屏幕中轴与视口中线上，距离取视口高度的
     1.25 倍（窄屏 0.95 倍，画面更小、透视更近），再换算成相对这一列的百分比
     交给 CSS。列的尺寸一变（断点、旋屏、软键盘）重算一次就够 ——
     气泡自身的位置不用重算，透视原点钉在列上，滚动与增删会让投影自己变化 */
  function syncStagePerspective() {
    var flow = stageStream();
    if (!flow) return;
    var box = flow.getBoundingClientRect();
    if (!box.width || !box.height) return;
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var narrow = vw <= 900;
    flow.style.setProperty('--stage-ox',
      ((vw / 2 - box.left) / box.width * 100).toFixed(2) + '%');
    flow.style.setProperty('--stage-oy',
      ((vh / 2 - box.top) / box.height * 100).toFixed(2) + '%');
    flow.style.setProperty('--stage-d', Math.round(vh * (narrow ? 0.95 : 1.25)) + 'px');
  }

  /* 倾角按气泡自己的宽度算：内缘退进去的深度是 宽 × sinθ，宽气泡把角度收一点，
     免得长句子的内侧退得太狠；窄屏整体放缓。内容回填把气泡撑宽时由
     ResizeObserver 再调一次，所以这一项也随内容大小实时变。
     上限 18°（窄屏 9°）是观感值：再大读起来就像侧着的字幕，太小又退回平板 */
  function syncBubbleTilt(node) {
    if (!node || !node.offsetWidth) return;
    var user = node.classList.contains('stage-chat__bubble--user');
    var narrow = (window.innerWidth || 0) <= 900;
    var limit = narrow ? 9 : 18;
    var tilt = limit - (node.offsetWidth - 200) / 100 * (narrow ? 0.6 : 1.4);
    tilt = Math.max(narrow ? 5 : 9, Math.min(limit, tilt));
    node.style.setProperty('--tilt', (user ? -tilt : tilt).toFixed(2) + 'deg');
  }

  var bubbleWatcher = window.ResizeObserver ? new window.ResizeObserver(function (entries) {
    for (var i = 0; i < entries.length; i += 1) syncBubbleTilt(entries[i].target);
  }) : null;

  /* ---------- 落位：老的气泡往上让，新的从底边升上来 ---------- */

  /* 排版是一帧跳过去的：新气泡一插进来，前面几条的位置立刻少了一截。
     这里把那一截换成补间 —— 插入前量一遍位置，插完再量一遍，差多少就先按
     差量把它们推回去、再用一段缓动放回 0，看上去就是整列被新的一条顶上去。
     新的一条自己从底边滑上来，同一个方向，两段动作读起来是一件事 */
  var STAGE_SHIFT_S = 0.42;
  var STAGE_ENTER_S = 0.46;
  var STAGE_ENTER_Y = 18;

  function stageRecall(stream) {
    var out = [];
    if (!stream) return out;
    for (var i = 0; i < stream.children.length; i += 1) {
      var child = stream.children[i];
      if (!child.classList || !child.classList.contains('stage-chat__bubble')) continue;
      if (child.classList.contains('is-leaving') || child.dataset.stageExit) continue;
      out.push({
        node: child,
        top: child.offsetTop,
        /* 可能还挂着上一段位移：连着来两条时，第一条的让位还没走完就量了，
           起点得把这段算进去，否则它会被拽回排版位置再重走一遍 */
        shift: parseFloat(child.style.getPropertyValue('--exit-y')) || 0
      });
    }
    return out;
  }

  /* 入场走独立的一条通道 --in-y，与让位用的 --exit-y 分开：
     发一条消息会连着落两条，前一条还在往上浮的时候后一条就到了，
     两条补间若写同一个变量，后者会把前者打断在半路 */
  function enterStage(node) {
    var engine = window.gsap;
    if (!engine || (STAGE_REDUCE && STAGE_REDUCE.matches)) return;
    node.classList.add('is-entering');
    node.style.setProperty('--in-y', STAGE_ENTER_Y + 'px');
    node.style.setProperty('--exit-o', '0');
    engine.timeline({
      onComplete: function () { node.classList.remove('is-entering'); }
    })
      .to(node, {
        '--in-y': '0px',
        duration: STAGE_ENTER_S,
        ease: 'power3.out'
      }, 0)
      /* 淡入比位移短一点：位移先走掉大半、颜色再补满，两条糊在一起会发闷 */
      .to(node, {
        '--exit-o': 1,
        duration: STAGE_ENTER_S * 0.7,
        ease: 'power2.out'
      }, 0);
  }

  function stageShiftIn(before, fresh) {
    var engine = window.gsap;
    if (!engine || (STAGE_REDUCE && STAGE_REDUCE.matches)) return;
    var i, item, delta, node;
    for (i = 0; i < (before ? before.length : 0); i += 1) {
      item = before[i];
      node = item.node;
      if (!node.parentNode || node.classList.contains('is-leaving')) continue;
      delta = item.top + item.shift - node.offsetTop;
      /* 只处理被顶上去的那几条；没挪动的就不必补一段零位移 */
      if (!(delta > 0.5)) continue;
      node.classList.add('is-shifting');
      node.style.setProperty('--exit-y', delta.toFixed(1) + 'px');
      engine.to(node, {
        '--exit-y': '0px',
        duration: STAGE_SHIFT_S,
        ease: 'power3.out',
        /* 连着来两条时这条上还挂着上一段让位，只顶掉同为 --exit-y 的那条，
           别整条收掉 —— 它可能同时在跑自己的入场 */
        overwrite: 'auto',
        onComplete: (function (target) {
          return function () { target.classList.remove('is-shifting'); };
        })(node)
      });
    }
    if (fresh) enterStage(fresh);
  }

  /* 舞台只有一列：已有的气泡按 recordId 复用，新的追加到末尾 —— 时间怎么走，
     气泡就怎么往下排（流自己向上滚，最新一条总在底边），问答因此自然错位。
     同一条记录会走两遍 —— 先「正在思考…」再回填正文，所以复用优先于新建 */
  function showStage(role, text, recordId) {
    var stream = stageStream();
    if (!stream) return;
    var key = String(recordId || '');
    var node = key
      ? stream.querySelector(STAGE_ALIVE + '[data-record-id="' + key + '"]')
      : null;
    /* 新插一条时才记位置、才演入场；回放历史时一次灌几十条，既不量也不演 */
    var before = null;
    var fresh = null;
    if (!node) {
      before = restoring ? null : stageRecall(stream);
      node = document.createElement('button');
      node.type = 'button';
      node.className = 'stage-chat__bubble stage-chat__bubble--' + role;
      node.dataset.stageMessage = role;
      node.setAttribute('aria-label', tr('chat.openHistory', '打开完整聊天记录'));
      var label = node.appendChild(document.createElement('span'));
      label.setAttribute('data-stage-text', '');
      decorateBubble(node, role, recordId);
      stream.appendChild(node);
      syncBubbleTilt(node);
      if (bubbleWatcher) bubbleWatcher.observe(node);
      /* 只留最近三组：超出的那条就地缩小淡出，不再靠滚动翻旧账 */
      trimStage(stream);
      fresh = node;
    }
    var textNode = node.querySelector('[data-stage-text]');
    if (textNode) textNode.textContent = text;
    else node.textContent = text;
    node.dataset.recordId = key;
    /* 等文字写完再演：这一条的高度是写完才定的，早一步量出来的差值会偏小，
       整列会先跳半截再补上剩下的 */
    if (fresh && !restoring) stageShiftIn(before, fresh);
  }

  function hideStage() {
    var stream = stageStream();
    if (!stream) return;
    /* 队列里还没走的那些跟着一起作废，否则清空后它们会挨个空转一遍 */
    stageExitQueue.length = 0;
    if (bubbleWatcher) {
      for (var i = 0; i < stream.children.length; i += 1) {
        bubbleWatcher.unobserve(stream.children[i]);
      }
    }
    stream.replaceChildren();
  }

  /* 待机时的自言自语：往舞台上追一条就够，不做定时清理——
     记录留在同一列滚动流里，由用户自己翻看。
     同一条刚说过就不再说：换成另一种，两种都刚说过就整轮跳过 */
  function stageLastText(role) {
    var stream = stageStream();
    if (!stream) return '';
    var bubbles = stream.querySelectorAll('[data-stage-message="' + role + '"]');
    var last = bubbles.length ? bubbles[bubbles.length - 1] : null;
    return last ? last.textContent.trim() : '';
  }
  function showIdleReaction(kind) {
    if (pending) return;
    var texts = {
      look: tr('idle.look.prompt', '我在看看周围。你想让我做点什么？'),
      settle: tr('idle.settle.prompt', '站久了，活动一下。要不要看个动作？'),
    };
    if (!texts[kind]) kind = 'look';
    var last = stageLastText('assistant');
    if (last && last === texts[kind]) {
      var other = kind === 'look' ? 'settle' : 'look';
      if (last === texts[other]) return;
      kind = other;
    }
    showStage('assistant', texts[kind]);
  }

  /* 悬停时间戳：年.月.日 时:分，两位补零 */
  function stampTime(ms) {
    var d = new Date(ms);
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function addRecord(role, text, modifier, saved) {
    var record = {
      id: records.length + 1,
      role: role,
      content: text,
      time: saved && Number.isFinite(saved.time) ? saved.time : Date.now(),
    };
    records.push(record);
    var node = document.createElement('div');
    node.className = 'assistant-chat__message assistant-chat__message--' + role;
    if (modifier) node.classList.add('assistant-chat__message--' + modifier);
    decorateBubble(node, role, record.id);
    node.dataset.recordId = String(record.id);
    node.dataset.time = stampTime(record.time);
    node.textContent = text;
    log.appendChild(node);
    scrollBottom();
    showStage(role === 'ai' ? 'assistant' : role, text, record.id);
    syncHistoryActions();
    stateDirty();
    return {node: node, record: record};
  }

  function updateRecord(entry, text, modifier) {
    entry.record.content = text;
    entry.node.textContent = text;
    entry.node.classList.remove('assistant-chat__message--pending', 'assistant-chat__message--error');
    if (modifier) entry.node.classList.add('assistant-chat__message--' + modifier);
    showStage('assistant', text, entry.record.id);
    scrollBottom();
    stateDirty();
  }

  function note(text) {
    var node = document.createElement('div');
    node.className = 'assistant-chat__note';
    node.textContent = text;
    log.appendChild(node);
    scrollBottom();
  }

  function speechLanguage() {
    var lang = document.documentElement.lang || navigator.language || 'en';
    return lang.toLowerCase().indexOf('zh') === 0 ? 'zh-CN' : 'en';
  }

  function updateVoiceButton() {
    var active = listening || voiceStarting;
    if (composer) composer.classList.toggle('is-recording', active);
    if (input) {
      input.placeholder = active
        ? tr('chat.voice.listening', '正在聆听…')
        : tr('chat.placeholder', '问问 PrimebotX…');
    }
    if (!voiceButton) return;
    var key = active ? 'chat.voice.stop' : 'chat.voice.start';
    var fallback = active ? '停止语音输入' : '开始语音输入';
    voiceButton.classList.toggle('is-listening', active);
    voiceButton.setAttribute('aria-pressed', String(active));
    voiceButton.setAttribute('data-i18n-aria', key);
    voiceButton.setAttribute('aria-label', tr(key, fallback));
    voiceButton.disabled = pending;
  }

  function refreshSpeechControls() {
    if (voiceButton) voiceButton.hidden = !SpeechRecognitionCtor;
    if (speechToggle) {
      speechToggle.hidden = !speechSupported;
      speechToggle.classList.toggle('is-muted', !speechEnabled);
      speechToggle.setAttribute('aria-pressed', String(speechEnabled));
      var key = speechEnabled ? 'chat.speech.on' : 'chat.speech.off';
      var fallback = speechEnabled ? '关闭自动朗读' : '开启自动朗读';
      speechToggle.setAttribute('data-i18n-aria', key);
      speechToggle.setAttribute('aria-label', tr(key, fallback));
    }
    if (speechStop && !speechSupported) speechStop.hidden = true;
    updateVoiceButton();
  }

  function stopSpeaking() {
    speechRequestToken += 1;
    if (speechAbort) {
      try { speechAbort.abort(); } catch (_error) {}
      speechAbort = null;
    }
    if (activeAudio) {
      try { activeAudio.pause(); } catch (_error) {}
      activeAudio = null;
    }
    if (activeAudioUrl) {
      try { URL.revokeObjectURL(activeAudioUrl); } catch (_error) {}
      activeAudioUrl = '';
    }
    activeUtterance = null;
    if (browserSpeechSupported) {
      try { window.speechSynthesis.cancel(); } catch (_error) {}
    }
    if (speechStop) speechStop.hidden = true;
  }

  function chooseSpeechVoice(language) {
    if (!browserSpeechSupported || typeof window.speechSynthesis.getVoices !== 'function') return null;
    var voices = [];
    try { voices = window.speechSynthesis.getVoices() || []; } catch (_error) {}
    var target = language.toLowerCase();
    var prefix = target.split('-')[0];
    var fallback = null;
    for (var i = 0; i < voices.length; i += 1) {
      var code = String(voices[i].lang || '').replace('_', '-').toLowerCase();
      if (code === target) return voices[i];
      if (!fallback && code.indexOf(prefix) === 0) fallback = voices[i];
    }
    return fallback;
  }

  function hideSpeechStop(token) {
    if (token !== speechRequestToken || activeAudio || activeUtterance) return;
    if (speechStop) speechStop.hidden = true;
  }

  function speakWithBrowser(text, token) {
    if (!browserSpeechSupported || token !== speechRequestToken || !speechEnabled) return false;
    if (activeUtterance) return true;
    var language = speechLanguage();
    var utterance = new window.SpeechSynthesisUtterance(text);
    var voice = chooseSpeechVoice(language);
    utterance.lang = language;
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    if (voice) utterance.voice = voice;
    activeUtterance = utterance;
    if (speechStop) speechStop.hidden = false;
    function finish() {
      if (activeUtterance !== utterance) return;
      activeUtterance = null;
      hideSpeechStop(token);
    }
    utterance.onend = finish;
    utterance.onerror = finish;
    try {
      window.speechSynthesis.speak(utterance);
      return true;
    } catch (_error) {
      finish();
      return false;
    }
  }

  function speakReply(text) {
    text = String(text || '').trim();
    if (!speechSupported || !speechEnabled || !text) return false;
    stopSpeaking();
    var token = speechRequestToken;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    speechAbort = controller;
    if (speechStop) speechStop.hidden = false;
    var voice = speechLanguage() === 'zh-CN' ? 'zh-CN-XiaoxiaoNeural' : 'en-US-AriaNeural';
    var headers = {'Content-Type': 'application/json'};
    var authToken = sessionStorage.getItem('primebotx.auth.token');
    if (authToken) headers.Authorization = 'Bearer ' + authToken;
    fetch(api + '/ai/speech', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({text: text, voice: voice}),
      signal: controller.signal,
    }).then(function (response) {
      if (!response.ok) throw new Error('natural speech unavailable');
      return response.blob();
    }).then(function (blob) {
      if (!blob.size) throw new Error('empty speech');
      if (token !== speechRequestToken || !speechEnabled) return;
      activeAudioUrl = URL.createObjectURL(blob);
      activeAudio = new Audio(activeAudioUrl);
      activeAudio.onended = function () {
        if (activeAudioUrl) URL.revokeObjectURL(activeAudioUrl);
        activeAudioUrl = '';
        activeAudio = null;
        hideSpeechStop(token);
      };
      activeAudio.onerror = function () {
        if (activeAudioUrl) URL.revokeObjectURL(activeAudioUrl);
        activeAudioUrl = '';
        activeAudio = null;
        if (!speakWithBrowser(text, token)) hideSpeechStop(token);
      };
      return activeAudio.play().catch(function () {
        if (activeAudioUrl) URL.revokeObjectURL(activeAudioUrl);
        activeAudioUrl = '';
        activeAudio = null;
        if (!speakWithBrowser(text, token)) hideSpeechStop(token);
      });
    }).catch(function () {
      if (token === speechRequestToken && speechEnabled && !speakWithBrowser(text, token)) {
        hideSpeechStop(token);
      }
    }).finally(function () {
      clearTimeout(timer);
      if (speechAbort === controller) speechAbort = null;
    });
    return true;
  }

  function setVoiceListening(value) {
    listening = value;
    if (input) input.readOnly = value;
    updateVoiceButton();
    paintSend();
  }

  function applyVoiceTranscript(finalText, interimText) {
    var spoken = String(finalText || '').trim();
    var interim = String(interimText || '').trim();
    if (interim) spoken = spoken ? spoken + ' ' + interim : interim;
    if (!spoken) return;
    var joined = voiceBaseText && spoken ? voiceBaseText + ' ' + spoken : spoken;
    var limit = input.maxLength > 0 ? input.maxLength : 500;
    input.value = joined.slice(0, limit);
    input.dispatchEvent(new Event('input'));
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (_error) {}
  }

  if (SpeechRecognitionCtor) {
    try {
      recognition = new SpeechRecognitionCtor();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onstart = function () {
        voiceStarting = false;
        voiceBaseText = input.value.trimEnd();
        setVoiceListening(true);
      };
      recognition.onresult = function (event) {
        var finalText = '';
        var interimText = '';
        for (var i = 0; i < event.results.length; i += 1) {
          var result = event.results[i];
          var transcript = result[0] && result[0].transcript ? result[0].transcript : '';
          if (result.isFinal) finalText += transcript;
          else interimText += transcript;
        }
        applyVoiceTranscript(finalText, interimText);
      };
      recognition.onerror = function (event) {
        voiceStarting = false;
        if (event.error === 'aborted') {
          setVoiceListening(false);
          return;
        }
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed' ||
            event.error === 'audio-capture') {
          note(tr('chat.voice.denied', '麦克风权限被拒绝，请在浏览器中允许麦克风后重试。'));
        } else if (event.error === 'no-speech') {
          note(tr('chat.voice.noSpeech', '没有识别到语音，请重试。'));
        } else {
          note(tr('chat.voice.error', '语音识别失败，请重试。'));
        }
        setVoiceListening(false);
      };
      recognition.onend = function () {
        voiceStarting = false;
        setVoiceListening(false);
      };
    } catch (_error) {
      SpeechRecognitionCtor = null;
      recognition = null;
    }
  }

  function startVoiceInput() {
    if (!recognition || pending) return false;
    if (listening || voiceStarting) {
      stopVoiceInput();
      return true;
    }
    stopSpeaking();
    recognition.lang = speechLanguage();
    voiceStarting = true;
    updateVoiceButton();
    paintSend();
    try {
      recognition.start();
      return true;
    } catch (_error) {
      voiceStarting = false;
      updateVoiceButton();
      paintSend();
      note(tr('chat.voice.error', '语音识别失败，请重试。'));
      return false;
    }
  }

  function stopVoiceInput() {
    if (!recognition || (!listening && !voiceStarting)) return;
    voiceStarting = false;
    try { recognition.stop(); } catch (_error) {}
    setVoiceListening(false);
  }

  function setStarted() {
    try { sessionStorage.setItem(STARTED_KEY, '1'); } catch (_error) {}
    if (suggestions) suggestions.hidden = true;
  }

  function paintSuggestions() {
    if (!suggestions) return;
    var started = false;
    try { started = sessionStorage.getItem(STARTED_KEY) === '1'; } catch (_error) {}
    suggestions.hidden = started && records.length > 0;
  }

  function paintSend() {
    /* 飞行途中不换态：提交那一刻输入框已经被清空，但按钮还得保持实心，
       等箭头从下方落回来（animationend）再退回空心，否则它是在半路换的衣服 */
    if (sendIcon && sendIcon.classList.contains('is-flying')) return;
    var hasText = input.value.trim().length > 0;
    sendButton.classList.toggle('is-filled', hasText);
    if (!pending) sendButton.disabled = listening || !hasText;
  }

  /* 面板底部那枚发送钮的同一套判定：有字才实心、才可点 */
  function paintDock() {
    if (!dockInput || !dockSend) return;
    if (dockIcon && dockIcon.classList.contains('is-flying')) return;
    var hasText = dockInput.value.trim().length > 0;
    dockSend.classList.toggle('is-filled', hasText);
    if (!pending) dockSend.disabled = !hasText;
  }

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var flyTimer = 0;

  /* 收尾：摘掉 is-flying，再按当前输入框重新判一次实心/空心 */
  function endFly() {
    if (flyTimer) { clearTimeout(flyTimer); flyTimer = 0; }
    var alive = false;
    if (sendIcon && sendIcon.classList.contains('is-flying')) {
      sendIcon.classList.remove('is-flying');
      alive = true;
    }
    if (dockIcon && dockIcon.classList.contains('is-flying')) {
      dockIcon.classList.remove('is-flying');
      alive = true;
    }
    if (!alive) return;
    paintSend();
    paintDock();
  }

  function flySendIcon() {
    /* 关掉动效的人不发这一帧：CSS 那边 animation:none 之后
       animationend 不会触发，is-flying 会一直挂着，按钮就再也不会换态了 */
    if (reduceMotion.matches) return;
    /* 只让「刚才在打字的那条」飞：两条输入共用发送逻辑，
       但两枚按钮同时做动作会看成两处都在发 */
    var icon = (dockFocus && dockIcon) ? dockIcon : sendIcon;
    if (!icon) return;
    /* 连按时把动画重头放一遍：先摘类、强制一次回流再挂上，
       不然类名没变，浏览器不会重启同一条 animation */
    icon.classList.remove('is-flying');
    void icon.offsetWidth;
    icon.classList.add('is-flying');
    /* animationend 是主路径，这条 700 的定时器只是兜底（动画 .62s）：
       标签页被挂起时动画会被取消、不派发 end，少了这一手按钮会永远停在实心态 */
    clearTimeout(flyTimer);
    flyTimer = setTimeout(endFly, 700);
  }

  if (sendIcon) sendIcon.addEventListener('animationend', endFly);
  if (dockIcon) dockIcon.addEventListener('animationend', endFly);

  function setPending(value) {
    pending = value;
    if (value) stopVoiceInput();
    input.disabled = value;
    sendButton.disabled = value || listening || !input.value.trim();
    if (dockInput && dockSend) {
      dockInput.disabled = value;
      dockSend.disabled = value || !dockInput.value.trim();
    }
    if (voiceButton) voiceButton.disabled = value;
    composer.setAttribute('aria-busy', value ? 'true' : 'false');
    /* 光标还回上一条在打字的那格：从面板里发完一句，
       焦点不该突然跳到底部那条输入上 */
    if (!value) (dockFocus && dockInput ? dockInput : input).focus();
  }

  async function requestReply(text, previous) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 35000);
    try {
      var headers = {'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID()};
      var token = window.primebotxAuth ? window.primebotxAuth.token : '';
      if (token) headers.Authorization = 'Bearer ' + token;
      var body = {message: text, history: previous};
      var persona = window.primebotxPersona && window.primebotxPersona.active;
      if (persona && persona.prompt) body.persona = persona.prompt;
      var response = await fetch(api + '/chat', {
        method: 'POST', headers: headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      var payload = await response.json().catch(function () { throw new Error('AI 服务返回了无法解析的响应'); });
      if (response.status === 401) {
        try { localStorage.removeItem('primebotx.auth.token'); } catch (_error) {}
        stopActions();
        window.dispatchEvent(new CustomEvent('primebotx-auth-required'));
      }
      if (!response.ok || payload.error) {
        throw new Error(payload.error && payload.error.message ? payload.error.message : '请求失败');
      }
      return payload.data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('模型响应超时，请稍后重试');
      throw error;
    } finally { clearTimeout(timer); }
  }

  /* 状态胶囊已从界面上撤掉，停止动作只剩两件事：作废正在跑的序列、收起停止钮 */
  function stopActions() {
    sequenceToken += 1;
    if (window.robot3d && window.robot3d.ready) window.robot3d.stopGesture();
    stopButton.hidden = true;
    stopSpeaking();
  }

  function wait(milliseconds) { return new Promise(function (resolve) { setTimeout(resolve, milliseconds); }); }

  var VIEW_PRESETS = {
    front: {azimuth: 0, elevation: 0},
    left: {azimuth: -90, elevation: 0},
    right: {azimuth: 90, elevation: 0},
    back: {azimuth: 180, elevation: 0},
    up: {azimuth: 0, elevation: 89},
    level: {azimuth: 0, elevation: 0},
    down: {azimuth: 0, elevation: -89},
  };
  var POSE_LOOPS = {idle: true, standby: true, raisehand: false, apose: false};

  function commandsFromResponse(data) {
    if (Array.isArray(data.commands)) return data.commands.slice(0, 6);
    var actions = Array.isArray(data.actions) ? data.actions : (data.action_id ? [data.action_id] : []);
    return actions.slice(0, 4).map(function (id) { return {type: 'motion', id: id}; });
  }

  function applyPoseCommand(robot, poseId) {
    if (!Object.prototype.hasOwnProperty.call(POSE_LOOPS, poseId)) return false;
    if (typeof robot.stopGesture === 'function') robot.stopGesture();
    if (poseId === 'idle' && typeof robot.resetPose === 'function') robot.resetPose();
    if (poseId === 'idle' && typeof robot.setMood === 'function') robot.setMood('calm');
    if (typeof robot.playClip !== 'function' || robot.playClip(poseId, POSE_LOOPS[poseId]) === false) {
      return false;
    }
    window.dispatchEvent(new CustomEvent('robot-pose-change', {detail: {clip: poseId}}));
    return true;
  }

  function executeCommand(command) {
    var robot = window.robot3d;
    if (!command || typeof command.type !== 'string') return {ok: false, label: '无效命令'};
    if (command.type === 'motion') {
      var info = robot && robot.getGestureInfo ? robot.getGestureInfo(command.id) : null;
      if (!info || !robot.playGesture(command.id, {source: 'chat'})) {
        return {ok: false, label: '动作 ' + command.id, duration: 0};
      }
      return {ok: true, label: info.label, duration: info.duration};
    }
    if (command.type === 'pose') {
      return {ok: !!robot && applyPoseCommand(robot, command.id), label: '姿态 ' + command.id, duration: 0};
    }
    if (command.type === 'reset_pose') {
      return {ok: !!robot && applyPoseCommand(robot, 'idle'), label: '复位姿态', duration: 0};
    }
    if (command.type === 'emotion') {
      if (!robot || typeof robot.setMood !== 'function') return {ok: false, label: '表情 ' + command.id};
      robot.setMood(command.id);
      return {ok: true, label: '表情 ' + command.id, duration: 0};
    }
    var viewControl = window.viewControl;
    if (command.type === 'reset_view') {
      if (!viewControl || typeof viewControl.resetView !== 'function') return {ok: false, label: '复位视角'};
      viewControl.resetView();
      return {ok: true, label: '复位视角', duration: 0};
    }
    if (command.type === 'view') {
      var preset = VIEW_PRESETS[command.preset];
      var current = viewControl && viewControl.view;
      if (!preset || !current || typeof viewControl.setView !== 'function') {
        return {ok: false, label: '视角 ' + command.preset};
      }
      var applied = viewControl.setView({
        azimuth: preset.azimuth,
        elevation: preset.elevation,
        distance: current.distance,
      });
      return {ok: applied !== false, label: '视角 ' + command.preset, duration: 0};
    }
    return {ok: false, label: command.type};
  }

  async function playCommands(commands) {
    if (!Array.isArray(commands) || !commands.length) return;
    var robot = window.robot3d;
    var needsRobot = commands.some(function (command) {
      return command && ['motion', 'pose', 'reset_pose', 'emotion'].includes(command.type);
    });
    if (needsRobot && (!robot || !robot.ready)) {
      note('命令未执行：主页机器人尚未加载完成');
      return;
    }
    var token = ++sequenceToken;
    if (robot && typeof robot.stopGesture === 'function') robot.stopGesture();
    stopButton.hidden = !commands.some(function (command) { return command && command.type === 'motion'; });
    for (var index = 0; index < commands.length; index += 1) {
      if (token !== sequenceToken) return;
      var result = executeCommand(commands[index]);
      if (!result.ok) {
        note('命令未执行：' + result.label);
        continue;
      }
      if (commands[index].type === 'motion') {
        await wait(Math.max(300, result.duration * 1000 + 250));
      }
    }
    if (token === sequenceToken) stopButton.hidden = true;
  }

  async function send(text) {
    text = String(text || '').trim();
    if (!text || pending) return false;
    stopVoiceInput();
    stopSpeaking();
    /* 空框与「正在等回复」都退到上面去了，所以箭头只在真的发出东西时才飞 */
    flySendIcon();
    setStarted();
    var previous = history.slice(-10);
    addRecord('user', text);
    input.value = '';
    input.dispatchEvent(new Event('input'));
    /* 面板那条也清掉：两条输入各自存草稿，发出去的那句同步收起 */
    if (dockInput) { dockInput.value = ''; paintDock(); }
    var thinking = addRecord('ai', tr('chat.thinking', '正在思考…'), 'pending');
    setPending(true);
    try {
      var data = await requestReply(text, previous);
      updateRecord(thinking, data.reply);
      speakReply(data.reply);
      var commands = commandsFromResponse(data);
      var commandRecord = commands.map(function (command) {
        return command.type + ':' + (command.id || command.preset || '');
      }).join(', ');
      var actionRecord = data.stop ? ' [动作记录：已停止]' : (commands.length ? ' [动作记录：' + commandRecord + ']' : '');
      history = history.concat([
        {role: 'user', content: text},
        {role: 'assistant', content: data.reply.slice(0, 500 - actionRecord.length) + actionRecord},
      ]).slice(-10);
      stateDirty();
      if (data.stop) stopActions();
      else if (commands.length) playCommands(commands);
      return true;
    } catch (error) {
      updateRecord(thinking, error.message || '对话失败，请稍后重试', 'error');
      return false;
    } finally { setPending(false); }
  }

  function openChat(recordId) {
    var tab = document.querySelector('.rail--left .item[data-panel="Chat"]');
    if (tab && tab.getAttribute('aria-expanded') !== 'true') tab.click();
    requestAnimationFrame(function () {
      var target = recordId && log.querySelector('[data-record-id="' + recordId + '"]');
      if (target) target.scrollIntoView({block: 'nearest'});
      else scrollBottom();
    });
  }

  function syncHistoryButton() {
    if (!historyButton) return;
    var tab = document.querySelector('.rail--left .item[data-panel="Chat"]');
    var expanded = !!tab && tab.getAttribute('aria-expanded') === 'true';
    var key = expanded ? 'chat.closeHistory' : 'chat.openHistory';
    var fallback = expanded ? '关闭完整聊天记录' : '打开完整聊天记录';
    historyButton.classList.toggle('is-open', expanded);
    historyButton.setAttribute('aria-expanded', String(expanded));
    historyButton.setAttribute('data-i18n-aria', key);
    historyButton.setAttribute('aria-label', tr(key, fallback));
  }

  function toggleChat() {
    var tab = document.querySelector('.rail--left .item[data-panel="Chat"]');
    if (!tab) return;
    if (tab.getAttribute('aria-expanded') === 'true') tab.click();
    else openChat();
  }

  /* ---------- 清空的确认态 ---------- */

  /* 文案只有两态：平时 chat.clear（清空 / Clear），armed 时 chat.clear.confirm
     （确认 / Confirm）。确认态由 is-arm 这一个类承载，与账号面板的退出登录同款；
     组内单选那套会在点击时抢先挂 is-active，这里一并收回 —— 亮不亮只该由
     确认态决定 */
  function paintClear() {
    var label = clearButton.querySelector('.pill__label');
    clearButton.classList.remove('is-active');
    clearButton.classList.toggle('is-arm', clearArmed);
    clearButton.setAttribute('aria-pressed', String(clearArmed));
    if (!label) return;
    if (clearArmed) {
      /* 摘掉 data-i18n：切语言时别把「确认」顺手覆盖回「清空」 */
      label.removeAttribute('data-i18n');
      label.textContent = tr('chat.clear.confirm', '确认');
    } else {
      label.setAttribute('data-i18n', 'chat.clear');
      label.textContent = tr('chat.clear', '清空');
    }
  }

  function disarmClear() {
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = 0; }
    if (!clearArmed) return;
    clearArmed = false;
    paintClear();
  }

  function armClear() {
    if (clearArmed) return;
    clearArmed = true;
    paintClear();
    /* 固定 3 秒，不因指针移开而提前收回：这一下的确认是「再点一次」，
       停不停在按钮上都不是信号 */
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(disarmClear, CLEAR_HOLD);
  }

  function onClearClick() {
    if (!clearArmed) { armClear(); return; }
    disarmClear();
    clear();
  }

  function setHistoryMenu(open) {
    historyMenu.hidden = !open;
    if (historyDock) historyDock.classList.toggle('is-open', open);
    settingsButton.setAttribute('aria-expanded', String(open));
    /* 菜单一收就退回未确认态：下次点开时不该还是「确认」 */
    if (!open) disarmClear();
  }

  function syncHistoryActions() {
    var empty = records.length === 0;
    if (exportButton) exportButton.disabled = empty;
    clearButton.disabled = empty;
    /* 记录被清空（含别处触发）之后，确认态没有对象了，顺手收回 */
    if (empty) disarmClear();
  }

  function toggleHistoryMenu() {
    setHistoryMenu(historyMenu.hidden);
  }

  function exportHistory() {
    if (!records.length) return;
    var text = records.map(function (record) {
      var author = record.role === 'user' ? tr('chat.you', '你') : 'PrimebotX';
      return author + ': ' + record.content;
    }).join('\n\n');
    var blob = new Blob([text], {type: 'text/markdown;charset=utf-8'});
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'primebotx-chat-' + new Date().toISOString().slice(0, 10) + '.md';
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    setHistoryMenu(false);
  }

  function clear() {
    stopVoiceInput();
    stopSpeaking();
    history = [];
    records = [];
    log.replaceChildren();
    hideStage();
    try { sessionStorage.removeItem(STARTED_KEY); } catch (_error) {}
    if (suggestions) suggestions.hidden = false;
    setHistoryMenu(false);
    syncHistoryActions();
    stateDirty();
    input.focus();
  }

  function exportState() {
    return {
      history: history.slice(-10).map(function (item) {
        return {role: item.role, content: String(item.content || '').slice(0, 500)};
      }),
      records: records.slice(-50).map(function (item) {
        return {
          role: item.role,
          content: String(item.content || '').slice(0, 1000),
          time: item.time,
        };
      }),
    };
  }

  function restoreState(state) {
    if (!state || !Array.isArray(state.records) || !Array.isArray(state.history)) return false;
    restoring = true;
    history = state.history.filter(function (item) {
      return item && (item.role === 'user' || item.role === 'assistant') &&
        typeof item.content === 'string';
    }).slice(-10).map(function (item) {
      return {role: item.role, content: item.content.slice(0, 500)};
    });
    records = [];
    log.replaceChildren();
    hideStage();
    state.records.filter(function (item) {
      return item && (item.role === 'user' || item.role === 'ai') &&
        typeof item.content === 'string';
    }).slice(-50).forEach(function (item) {
      addRecord(item.role, item.content.slice(0, 1000), '', {time: Number(item.time) || Date.now()});
    });
    restoring = false;
    welcomeShown = records.length > 0;
    if (records.length) setStarted();
    paintSuggestions();
    syncHistoryActions();
    scrollBottom();
    return true;
  }

  function welcome(playMotion) {
    if (!welcomeShown) {
      welcomeShown = true;
      addRecord('ai', tr('chat.welcome', '你好，我是 PrimebotX，很高兴见到你！想看看我能做什么吗？'));
    }
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (playMotion && !welcomeMotionPlayed && !reduced &&
        window.robot3d && window.robot3d.ready) {
      welcomeMotionPlayed = true;
      window.robot3d.playGesture('wave', {source: 'welcome'});
    }
  }

  input.addEventListener('input', paintSend);
  input.addEventListener('focus', function () { dockFocus = false; });
  if (window.ResizeObserver) {
    var chatResizeObserver = new window.ResizeObserver(syncChatScrollState);
    chatResizeObserver.observe(log);
  }
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(input.value); }
  });
  sendButton.addEventListener('click', function () { dockFocus = false; send(input.value); });
  /* 面板底部那条：回车与点击都走同一个 send()，与主输入条不分叉 */
  if (dockInput && dockSend) {
    dockInput.addEventListener('input', paintDock);
    dockInput.addEventListener('focus', function () { dockFocus = true; });
    dockInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send(dockInput.value);
      }
    });
    dockSend.addEventListener('click', function () {
      dockFocus = true;
      send(dockInput.value);
    });
  }
  stopButton.addEventListener('click', function () { stopActions(); });
  if (voiceButton) {
    voiceButton.addEventListener('click', function () { startVoiceInput(); });
  }
  if (speechToggle) {
    speechToggle.addEventListener('click', function () {
      if (!speechSupported) return;
      speechEnabled = !speechEnabled;
      try { localStorage.setItem(SPEECH_KEY, speechEnabled ? '1' : '0'); } catch (_error) {}
      if (!speechEnabled) stopSpeaking();
      refreshSpeechControls();
    });
  }
  if (speechStop) speechStop.addEventListener('click', stopSpeaking);
  settingsButton.addEventListener('click', toggleHistoryMenu);
  clearButton.addEventListener('click', onClearClick);
  if (exportButton) exportButton.addEventListener('click', exportHistory);
  if (suggestions) suggestions.addEventListener('click', function (event) {
    var button = event.target.closest('[data-chat-example]');
    if (button) send(button.dataset.chatPrompt || button.textContent.trim());
  });
  if (stage) stage.addEventListener('click', function (event) {
    var bubble = event.target.closest('[data-stage-message]');
    if (bubble) openChat(bubble.dataset.recordId);
  });

  /* 相机参数先摆好，再等字体落位重摆一次 —— 字体换了行高、列的位置也可能挪 */
  if (stage) {
    syncStagePerspective();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(syncStagePerspective);
    }
  }
  if (historyButton) {
    var chatTab = document.querySelector('.rail--left .item[data-panel="Chat"]');
    historyButton.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
    historyButton.addEventListener('click', toggleChat);
    if (chatTab && window.MutationObserver) {
      new MutationObserver(syncHistoryButton).observe(chatTab, {
        attributes: true,
        attributeFilter: ['aria-expanded'],
      });
    }
    document.addEventListener('langchange', syncHistoryButton);
    syncHistoryButton();
  }
  document.addEventListener('langchange', function () {
    stopVoiceInput();
    stopSpeaking();
    refreshSpeechControls();
  });
  if (window.addEventListener) {
    window.addEventListener('robot-manual-motion', function () {
      sequenceToken += 1; stopButton.hidden = true;
    });
    window.addEventListener('resize', function () {
      syncStagePerspective();
    });
    window.addEventListener('primebotx-idle-reaction', function (event) {
      showIdleReaction(event.detail && event.detail.kind);
    });
    window.addEventListener('robot-ready', function () { welcome(true); }, {once: true});
    setTimeout(function () { welcome(false); }, 5000);
  }
  document.addEventListener('pointerdown', function (event) {
    if (historyMenu.hidden || event.target.closest('.chat-view__actions')) return;
    setHistoryMenu(false);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !historyMenu.hidden) {
      setHistoryMenu(false);
      settingsButton.focus();
    }
  });
  paintSuggestions();
  paintSend();
  syncHistoryActions();
  refreshSpeechControls();

  window.primebotxChat = {
    send: send,
    submit: function () { return send(input.value); },
    clear: clear,
    stopActions: stopActions,
    startVoiceInput: startVoiceInput,
    stopVoiceInput: stopVoiceInput,
    stopSpeaking: stopSpeaking,
    getHistory: function () { return history.slice(); },
    exportState: exportState,
    restoreState: restoreState,
    get history() { return history.slice(); },
    get speechEnabled() { return speechEnabled; },
    get listening() { return listening; },
  };
})();
