/* 头像：点头像就地展开选择区 —— 四张默认图任选其一，也可以传本地图片。
   选中的结果写在 .avatar 的内联 background-image 上，同时存进 localStorage
   （primebotx:avatar：a1 / a2 / a3 / a4 / dataURL），刷新后还是上次那张。
   上传的图先缩到 160 见方再转 dataURL：原图直接塞进去很容易把 5MB 的配额顶爆。
   --------------------------------------------------------------- */
(function () {
  var user = document.getElementById('account');
  if (!user) return;

  var avatar = user.querySelector('.avatar');
  var up = user.querySelector('.avatar__up');
  var file = user.querySelector('.avatar__file');
  var opts = Array.prototype.slice.call(user.querySelectorAll('.avatar__opt'));
  var nameNode = user.querySelector('.user__name');
  if (!avatar || !up || !file) return;

  var KEY = 'primebotx:avatar';
  /* 文档在 frontend/ 根下，所以这里不能照抄 CSS 的 ../icon/ */
  var PRESET = {
    a1: 'icon/default_avatar.png',
    a2: 'icon/default_avatar2.png',
    a3: 'icon/default_avatar3.png',
    a4: 'icon/default_avatar4.png'
  };

  var saved = 'a1';
  try { saved = localStorage.getItem(KEY) || 'a1'; } catch (e) {}

  /* 当前选中的那张；未登录时照样记着，登录回来直接画上 */
  var current = saved;
  /* 未登录：用固定默认头像占位，但仍不开放头像选择。
     登录状态由 js/auth.js 的 authchange 广播带来，这里不自己读 token。 */
  var guest = false;

  function isData(v) { return v.indexOf('data:') === 0; }
  function srcOf(v) { return isData(v) ? v : (PRESET[v] || PRESET.a1); }

  function paint(v) {
    current = v;
    /* 未登录固定显示第一张默认头像；用户已保存的自定义头像只在登录后恢复。 */
    if (guest) {
      avatar.style.backgroundImage = 'url("' + PRESET.a1 + '")';
      return;
    }
    var custom = isData(v);
    avatar.style.backgroundImage = 'url("' + srcOf(v) + '")';
    opts.forEach(function (o) {
      var on = o.dataset.avatar === v;
      o.classList.toggle('is-sel', on);
      o.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    /* 上传钮兼作自定义头像的预览位：传过图就把它贴在框里 */
    up.style.backgroundImage = custom ? 'url("' + v + '")' : '';
    up.classList.toggle('has-img', custom);
    up.classList.toggle('is-sel', custom);
    up.setAttribute('aria-pressed', custom ? 'true' : 'false');
  }

  /* 账号胶囊的宽度跟着名字走，但保留头像、间距和右侧留白。
     用 Canvas 量的是最终字体下的自然宽度，不受当前 max-width 与省略号影响。 */
  function fitName() {
    if (!nameNode) return;
    var text = nameNode.textContent.trim();
    if (!text) return;
    var style = window.getComputedStyle(nameNode);
    var canvas = fitName.canvas || (fitName.canvas = document.createElement('canvas'));
    var context = canvas.getContext('2d');
    if (!context) return;
    context.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
    var width = Math.ceil(context.measureText(text).width) + 2;
    user.style.setProperty('--user-name-width', width + 'px');
  }

  function save(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
    window.dispatchEvent(new CustomEvent('primebotx-state-dirty'));
  }

  function pick(v) {
    paint(v);
    save(v);
  }

  /* 开合：只有胶囊已经展开时才有意义 —— 收起态那张头像是被 trigger 盖住的，
     那时候点什么都是在展开面板。未登录时这张选择条压根不开 */
  function setTray(on) {
    if (on && guest) return;
    if (on && !user.classList.contains('is-open')) return;
    user.classList.toggle('is-picking', on);
    avatar.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  /* 登录态切换：未登录显示默认头像、收起选择条，并改成「点了去登录」 */
  function setGuestState(on) {
    guest = on;
    user.classList.toggle('is-guest', on);
    if (on) {
      setTray(false);
      paint(current);
      avatar.setAttribute('aria-disabled', 'true');
      avatar.setAttribute('aria-label', window.t ? window.t('auth.entry') : '注册/登录');
      avatar.removeAttribute('aria-expanded');
    } else {
      avatar.removeAttribute('aria-disabled');
      avatar.setAttribute('aria-label', '更改头像');
      paint(current);
    }
  }

  avatar.addEventListener('click', function () {
    /* 未登录时这一下不是挑头像，是回到登录页 —— 跳过登录之后唯一的重开入口 */
    if (guest) {
      if (window.primebotxAuth) window.primebotxAuth.open();
      return;
    }
    setTray(!user.classList.contains('is-picking'));
  });

  opts.forEach(function (opt) {
    opt.addEventListener('click', function () {
      pick(opt.dataset.avatar);
      setTray(false);
    });
  });

  up.addEventListener('click', function () { file.click(); });

  file.addEventListener('change', function () {
    var f = file.files && file.files[0];
    file.value = '';                 /* 清掉，同一张图再选一次也能触发 change */
    if (!f || !/^image\//.test(f.type)) return;
    shrink(f, function (data) {
      if (!data) return;
      pick(data);
      setTray(false);
    });
  });

  /* 缩到 160×160 的方图：先按短边居中裁方形，再画进画布，
     横图竖图都不会被压扁。jpeg 0.9 之后一般十几 KB */
  function shrink(f, done) {
    var url = URL.createObjectURL(f);
    var img = new Image();
    img.onload = function () {
      var size = 160;
      var c = document.createElement('canvas');
      c.width = c.height = size;
      var s = Math.min(img.width, img.height);
      var ctx = c.getContext('2d');
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      done(c.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      done(null);
    };
    img.src = url;
  }

  /* 点托盘以外的地方就收起（点名字、点菜单项都算离开这块选择区）；
     点面板外面由 rails.js 关整个胶囊，那边会顺手摘掉 is-picking */
  document.addEventListener('pointerdown', function (e) {
    if (!user.classList.contains('is-picking')) return;
    if (e.target.closest('.avatar__tray') || e.target.closest('.avatar')) return;
    setTray(false);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setTray(false);
  });

  document.addEventListener('authchange', function (e) {
    var signedIn = !!(e.detail && e.detail.user);
    if (signedIn) {
      try { current = localStorage.getItem(KEY) || 'a1'; } catch (_error) { current = 'a1'; }
    }
    setGuestState(!signedIn);
  });

  /* 初始态跟着标记走：#account 默认带 is-guest，登录后由 auth.js 摘掉 */
  guest = user.classList.contains('is-guest');
  if (guest) {
    avatar.setAttribute('aria-disabled', 'true');
    avatar.setAttribute('aria-label', window.t ? window.t('auth.entry') : '注册/登录');
  }
  paint(saved);
  requestAnimationFrame(fitName);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(fitName).catch(function () {});
  }
  var fitTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitName, 80);
  });
})();
