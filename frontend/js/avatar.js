/* 头像：点头像就地展开选择区 —— 四张默认图任选其一，也可以传本地图片。
   选中的结果写在 .avatar 的内联 background-image 上，同时存进 localStorage
   （primebot:avatar：a1 / a2 / a3 / a4 / dataURL），刷新后还是上次那张。
   上传的图先缩到 160 见方再转 dataURL：原图直接塞进去很容易把 5MB 的配额顶爆。
   --------------------------------------------------------------- */
(function () {
  var user = document.getElementById('account');
  if (!user) return;

  var avatar = user.querySelector('.avatar');
  var up = user.querySelector('.avatar__up');
  var file = user.querySelector('.avatar__file');
  var opts = Array.prototype.slice.call(user.querySelectorAll('.avatar__opt'));
  if (!avatar || !up || !file) return;

  var KEY = 'primebot:avatar';
  /* 文档在 frontend/ 根下，所以这里不能照抄 CSS 的 ../icon/ */
  var PRESET = {
    a1: 'icon/default_avatar.png',
    a2: 'icon/default_avatar2.png',
    a3: 'icon/default_avatar3.png',
    a4: 'icon/default_avatar4.png'
  };

  var saved = 'a1';
  try { saved = localStorage.getItem(KEY) || 'a1'; } catch (e) {}

  function isData(v) { return v.indexOf('data:') === 0; }
  function srcOf(v) { return isData(v) ? v : (PRESET[v] || PRESET.a1); }

  function paint(v) {
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

  function save(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }

  function pick(v) {
    paint(v);
    save(v);
  }

  /* 开合：只有胶囊已经展开时才有意义 —— 收起态那张头像是被 trigger 盖住的，
     那时候点什么都是在展开面板 */
  function setTray(on) {
    if (on && !user.classList.contains('is-open')) return;
    user.classList.toggle('is-picking', on);
    avatar.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  avatar.addEventListener('click', function () {
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

  paint(saved);
})();
