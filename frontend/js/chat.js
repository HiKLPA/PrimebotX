/* Chat 页：发送 / 预设回答 / 气泡时间
   ---------------------------------------------------------------
   用户内容靠右、AI 靠左，布局全在 CSS 里；脚本只做三件事：
   造一条消息节点、回一句预设文案、把滚动条压到底。
   空白内容不发送（trim 之后为空就什么也不做，也不拦键盘）。 */
(function () {
  var root  = document.querySelector('[data-chat]');
  if (!root) return;
  var log   = root.querySelector('[data-chat-log]');
  var input = root.querySelector('[data-chat-input]');

  /* 预设回答：Response Showcase. 重复 16 遍，句间一个空格 */
  var REPLY = (function () {
    var parts = [];
    for (var i = 0; i < 16; i++) parts.push('Response Showcase.');
    return parts.join(' ');
  })();

  /* 26/10/22 10:08 —— 年月日时分，两位补零 */
  function stamp(d) {
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return String(d.getFullYear()).slice(2) + '/' +
           p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' +
           p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function bottom() {
    /* 读 scrollHeight 会强制一次布局，这里拿到的已经是插入后的高度，
       所以先同步压到底；rAF 里再来一次，兜住字体加载、换行重排带来的高度变化 */
    log.scrollTop = log.scrollHeight;
    requestAnimationFrame(function () { log.scrollTop = log.scrollHeight; });
  }

  function add(role, text) {
    var now = new Date();
    var wrap = document.createElement('div');
    wrap.className = 'msg msg--' + role;

    var bubble = document.createElement('div');
    bubble.className = 'msg__bubble';
    bubble.textContent = text;

    var time = document.createElement('time');
    time.className = 'msg__time';
    time.dateTime = now.toISOString();
    time.textContent = stamp(now);

    /* 时间挂在气泡里，而不是 .msg 下：.msg 是整行满宽，时间若挂在它上面，
       left/right:0 指的是整行边缘（面板边），而不是气泡自己的边 */
    bubble.appendChild(time);

    wrap.appendChild(bubble);
    log.appendChild(wrap);
    bottom();
    return wrap;
  }

  function submit() {
    var text = input.value.trim();
    if (!text) return;           /* 空白不发送 */
    add('user', text);
    input.value = '';
    /* 预设回答稍晚一拍落下来，读起来像「对方在想」 */
    setTimeout(function () { add('ai', REPLY); }, 320);
  }

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
})();
