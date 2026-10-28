/* Connect 弹窗里的机型列表：行由 MODELS 生成，暂时是一份固定占位表。
   胶囊点选是单选；钉住、编辑各自独立，不影响选中。
   对外只派三个事件：model:select / model:edit，以及已有的 modal:confirm。 */
(function () {
  var list = document.querySelector('[data-model-list]');
  if (!list) return;

  var FALLBACK = [];
  for (var i = 1; i <= 12; i++) FALLBACK.push('Q1_RandomName_' + (i < 10 ? '0' + i : i));
  var MODELS = FALLBACK.slice();

  /* 图标各自带自己的 viewBox：编辑是 24 网格的画法，
     置顶直接用 icon/arrow.svg 的路径（32 网格），绕中心转 -90° 让它朝上。
     转完的形状宽 21.75、高 16，仍在 32 的框里，不改动原图的圆角与笔画粗细 */
  var ICON = {
    edit: {
      vb: '0 0 24 24',
      body: '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>'
    },
    top: {
      vb: '0 0 32 32',
      body: '<path transform="rotate(-90 16 16)" d="M23.78,16.54c.3-.3.3-.79,0-1.09l-4.35-4.35c-.3-.3-.79-.79-1.09-1.09l-4.35-4.35c-.3-.3-.89-.54-1.31-.54h-3.9c-.42,0-.77.35-.77.77v3.9c0,.42.24,1.01.54,1.31l4.35,4.35c.3.3.3.79,0,1.09l-4.35,4.35c-.3.3-.54.89-.54,1.31v3.9c0,.42.35.77.77.77h3.9c.42,0,1.01-.24,1.31-.54l4.35-4.35c.3-.3.79-.79,1.09-1.09l4.35-4.35Z"/>'
    },
    /* 工具条三个：放大镜（按 SDN 搜索）、加号（按 SDN 新增，取自 icon/add.svg）、
       环形箭头（刷新附近机型识别） */
    find: {
      vb: '0 0 24 24',
      body: '<path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5Zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14Z"/>'
    },
    add: {
      vb: '0 0 32 32',
      body: '<path d="M24.5,13.17h-5.67v-5.67c0-1.57-1.27-2.83-2.83-2.83h0c-1.57,0-2.83,1.27-2.83,2.83v5.67h-5.67c-1.57,0-2.83,1.27-2.83,2.83h0c0,1.57,1.27,2.83,2.83,2.83h5.67v5.67c0,1.57,1.27,2.83,2.83,2.83h0c1.57,0,2.83-1.27,2.83-2.83v-5.67h5.67c1.57,0,2.83-1.27,2.83-2.83h0c0-1.57-1.27-2.83-2.83-2.83Z"/>'
    },
    scan: {
      vb: '0 0 24 24',
      body: '<path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z"/>'
    }
  };

  function btn(act, label, icon) {
    var ic = ICON[icon];
    return '<button class="mrow__btn" type="button" data-act="' + act + '" aria-label="' + label + '">' +
      '<svg viewBox="' + ic.vb + '" aria-hidden="true">' + ic.body + '</svg></button>';
  }

  /* 标题区左列的工具条：搜索（按 SDN）、新增（按 SDN）、刷新（重新识别附近机型）。
     三个 32 方形无间隔贴着标题左基线，这一组不铺底片，只有图标换色；
     find / add 先就地收一个 SDN，scan 直接触发。后端接口未接，
     目前只把动作与参数打到控制台 */
  var tools = document.querySelector('[data-model-tools]');
  var TOOL_LIST = [
    ['find', 'Search by SDN', 'find'],
    ['add', 'Add by SDN', 'add'],
    ['scan', 'Refresh nearby devices', 'scan']
  ];

  function renderTools() {
    if (!tools) return;
    tools.classList.remove('is-input');
    tools.innerHTML = TOOL_LIST.map(function (t) {
      return btn(t[0], t[1], t[2]);
    }).join('');
  }
  renderTools();

  function runTool(act, sdn) {
    console.info('[models]', act, sdn || '');
  }

  /* SDN 就地输入：整条工具条让给一个输入框，Enter 提交、Esc 放弃、
     失焦也算放弃（与就地改名同一套手感，不弹系统对话框） */
  function askSdn(act) {
    if (!tools) return;
    tools.classList.add('is-input');
    tools.innerHTML = '<input class="mrow__input modal__sdn" type="text" placeholder="SDN" ' +
      'aria-label="Device SDN" autocomplete="off" spellcheck="false">';
    var input = tools.firstChild;
    input.focus();
    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      var sdn = (input.value || '').trim();
      renderTools();
      if (commit && sdn) runTool(act, sdn);
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(false); });
  }

  if (tools) {
    tools.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var act = b.dataset.act;
      if (act === 'scan') runTool('scan', '');
      else askSdn(act);
    });
  }

  function render() {
    list.innerHTML = MODELS.map(function (name, i) {
      return '<div class="mrow' + (i === 0 ? ' is-sel' : '') + '" data-model="' + name + '">' +
        '<button class="mrow__pill" type="button" aria-pressed="' + (i === 0) + '">' +
          '<span class="mrow__label">' + name + '</span>' +
        '</button>' +
        '<div class="mrow__acts">' + btn('edit', 'Rename', 'edit') + btn('top', 'Move to top', 'top') + '</div>' +
        '</div>';
    }).join('');

    /* 首帧对齐：connect 还没打开过时它的 confirmed 尚未落定，
       「当前设备」就是列表此刻选中的行 —— HUD 与 connect 右上一起写上，
       别让左下角停在写死的占位名上 */
    var sel0 = list.querySelector('.mrow.is-sel');
    if (!sel0 || !sel0.dataset.model) return;
    var right = document.querySelectorAll('[data-modal-title]')[1];
    /* Advance 的右上角留给「连接仿真」，不写机型名：这时列表可能刚好被
       api:devices 重画，若不拦一下就会把那行名字又写回标题区 */
    var panel = document.querySelector('.modal__panel');
    var onAdvance = panel && panel.getAttribute('aria-label') === 'Advance';
    if (window.hudName) window.hudName(sel0.dataset.model);
    else {
      var hud = document.querySelector('[data-hud-device]');
      if (hud) hud.textContent = sel0.dataset.model;
    }
    if (right && !onAdvance) right.textContent = sel0.dataset.model;
  }
  render();

  /* 机型名原本由 js/integration.js 从 /api/v1/robots 拉回来之后派 api:devices，
     那套 mock 联调已停用，现在没人派这个事件，列表就停在 FALLBACK 那份占位名上。
     监听留着：以后接真机型列表时，照旧发 api:devices 就能整列换掉 */
  document.addEventListener('api:devices', function (e) {
    var names = e.detail;
    if (!names || !names.length) return;
    MODELS = names.slice();
    render();
  });

  function select(row) {
    Array.prototype.forEach.call(list.querySelectorAll('.mrow'), function (r) {
      var on = r === row;
      r.classList.toggle('is-sel', on);
      r.querySelector('.mrow__pill').setAttribute('aria-pressed', String(on));
    });
    /* 只改行内高亮，不动右上的标题：那一个要等 Confirm 才落定 */
    list.dispatchEvent(new CustomEvent('model:select', {
      bubbles: true, detail: { name: row.dataset.model }
    }));
  }

  /* 就地改名：把胶囊里的 .mrow__label 换成一个同样字面的 input，
     Enter / 失焦提交，Esc 放弃。提交后把名字写回 data-model 与标签 */
  function startEdit(row) {
    if (row.classList.contains('is-edit')) return;
    var pill = row.querySelector('.mrow__pill');
    var label = row.querySelector('.mrow__label');
    if (!pill || !label) return;

    var old = label.textContent;
    var input = document.createElement('input');
    input.className = 'mrow__input';
    input.type = 'text';
    input.value = old;
    input.setAttribute('aria-label', 'Model name');
    row.classList.add('is-edit');
    pill.replaceChild(input, label);
    input.focus();
    input.select();

    var settled = false;
    function finish(save) {
      if (settled) return;
      settled = true;
      var next = save ? ((input.value || '').trim() || old) : old;   /* 清空视作放弃，不产生空名字 */
      var span = document.createElement('span');
      span.className = 'mrow__label';
      span.textContent = next;
      if (input.parentNode === pill) pill.replaceChild(span, input);
      row.classList.remove('is-edit');
      row.dataset.model = next;
      if (next !== old) {
        list.dispatchEvent(new CustomEvent('model:rename', {
          bubbles: true, detail: { from: old, to: next }
        }));
      }
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }   /* 走 blur → 提交 */
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });
  }

  list.addEventListener('click', function (e) {
    var row = e.target.closest('.mrow');
    if (!row) return;

    var top = e.target.closest('[data-act="top"]');
    if (top) {
      var on = !top.classList.contains('is-on');
      top.classList.toggle('is-on', on);
      top.setAttribute('aria-pressed', String(on));
      if (on) {
        /* 记住原来跟着谁后面，取消置顶时按这一条插回去 */
        row.__home = row.nextElementSibling;
        list.insertBefore(row, list.firstElementChild);
      } else {
        var home = row.__home;
        if (home && home.parentNode === list) list.insertBefore(row, home);
        else list.appendChild(row);
        row.__home = null;
      }
      return;
    }

    var edit = e.target.closest('[data-act="edit"]');
    if (edit) {
      startEdit(row);
      return;
    }

    /* 编辑中点到输入框只是挪光标，不改选中 */
    if (e.target.closest('.mrow__input')) return;
    if (e.target.closest('.mrow__pill')) select(row);
  });
})();
