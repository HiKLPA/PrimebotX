/* 组标题吸顶 + 交接淡出
   ---------------------------------------------------------------
   位置交给 CSS 的 position:sticky：标题钉在雾化遮罩的中线上（.sc-group__title 的 top），
   所属 .sc-group 的卡片区底边一旦压到这条线，标题就被顶上去，
   下一组的标题顺着滚上来占住同一个位置 —— 这一半浏览器算，脚本不插手。
   脚本只做「淡出」：每条标题挂一个 scrub 补间，起止点是两个像素值，
     start = 卡片区底边压到吸顶线（标题开始被顶出去）的那一刻
     end   = 下一条标题走到吸顶线（它接手）的那一刻
   所以当前标题淡到 0 的瞬间，下一条正好落到同一个位置，中间不留空档；
   往回滚时补间原路倒放，透明度自己回来，没有状态残留。
   --------------------------------------------------------------- */
gsap.registerPlugin(ScrollTrigger);

(function () {
  function setup(body) {
    var titles = Array.prototype.slice.call(body.querySelectorAll('.sc-group__title'));
    if (!titles.length) return;

    /* 标题盒顶边离面板顶端的距离，与 CSS 的 --title-top 同源；
       改标题位置只动那一个变量，这里量一次就同步，不用两处对齐。
       缺省 12 是顶部遮罩 (16 + 32) / 2 再减半个标题盒 */
    var titleTop = 12;

    function measure() {
      var v = parseFloat(getComputedStyle(body).getPropertyValue('--title-top'));
      titleTop = isNaN(v) ? 12 : v;
    }

    /* 内容撑不满时没有可滚的距离，顶上那条雾带压在空白上只是一块灰，收掉更好看。
       判定结果写成属性交给 CSS —— 雾带是 body 的兄弟节点，得从面板往下选。
       留 1px 容差：分数高度取整后 scrollHeight 与 clientHeight 常差半像素 */
    function fit() {
      var next = body.scrollHeight - body.clientHeight > 1 ? 'on' : 'off';
      if (body.getAttribute('data-scroll') !== next) body.setAttribute('data-scroll', next);
    }

    /* 内容坐标：元素顶边到滚动内容起点的距离。滚到哪儿它都不变，
       所以 start / end 只在 refresh 时算一次，滚动过程中不读布局 */
    function groupTop(g) {
      return g.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    }
    /* 标题吸顶后，标题盒顶边离面板顶端的距离 */
    function pinTop() { return titleTop; }

    function startOf(t) {
      var g = t.parentElement;
      return groupTop(g) + g.offsetHeight - pinTop() - t.offsetHeight;
    }
    function endOf(t, i) {
      var g = t.parentElement;
      var next = titles[i + 1];
      var end = next ? groupTop(next.parentElement) : groupTop(g) + g.offsetHeight;
      var s = startOf(t);
      /* 保险：至少留 1px 行程，避免布局抖动时 start ≥ end 让补间变成硬切 */
      return Math.max(end - pinTop(), s + 1);
    }

    titles.forEach(function (t, i) {
      gsap.fromTo(t, { opacity: 1 }, {
        opacity: 0,
        ease: 'none',
        immediateRender: false,
        scrollTrigger: {
          scroller: body,                    // 滚动发生在这个容器里，不是窗口
          trigger: t.parentElement,
          start: function () { return startOf(t); },
          end: function () { return endOf(t, i); },
          scrub: true,                       // 与滚动严格 1:1，不留跟随延迟
          invalidateOnRefresh: true
        }
      });
    });

    /* 面板开合会改宽高、切视图会换掉显示的组、窗口缩放会改换行，
       三者都要重新量一次起止点。统一防抖，避免宽度过渡那 0.3s 里刷上百次 */
    var timer = 0;
    function relayout() {
      clearTimeout(timer);
      timer = setTimeout(function () { measure(); fit(); ScrollTrigger.refresh(); }, 160);
    }

    measure();
    fit();
    /* 面板开合时高度一路在变，雾带要不要显示得跟着走。这里不进防抖：
       量一次 scrollHeight 很便宜，进防抖反而会让动画里多出几百毫秒的错档 */
    if (window.ResizeObserver) new ResizeObserver(function () { fit(); relayout(); }).observe(body);
    if (window.MutationObserver) {
      /* 切视图是瞬时换显示，得当场重算。走 160ms 防抖的话，这段空窗里标题还按
         上一套 start/end 的进度挂在 opacity 0 上 —— 卡片已经出来了、标题却要等
         防抖结束才浮出来，看着就是「标题比卡片晚出现」 */
      new MutationObserver(function () {
        clearTimeout(timer);
        measure();
        fit();
        ScrollTrigger.refresh();
      }).observe(body, { attributes: true, attributeFilter: ['data-view'] });

      /* 图钉会藏掉整组/整张卡片，内容高度当场就变，同样不能等防抖 */
      body.addEventListener('pinchange', function () {
        clearTimeout(timer);
        measure();
        fit();
        ScrollTrigger.refresh();
      });
    }
    window.addEventListener('resize', relayout);
    relayout();
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-panel-body]'), setup);
})();
