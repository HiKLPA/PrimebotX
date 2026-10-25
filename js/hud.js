/* 电池液位跟随数字：读槽内的电量文本，按壳宽 30 等比换算液位宽
   （壳 x=1 起、宽 30，56 → 30 × .56 = 16.8）。接真实电量时更新
   text 与换档类后调一次 window.hudBatt() 即可；脚本没跑到时
   rect 上写死的 width 兜底 */
window.hudBatt = function () {
  var svg = document.querySelector('.hud__batt--ok, .hud__batt--low');
  var text = svg && svg.querySelector('text');
  var level = svg && svg.querySelector('[data-hud-batt-level]');
  if (!svg || !text || !level) return;
  var n = parseFloat(text.textContent);
  if (isNaN(n)) return;
  n = Math.max(0, Math.min(100, n));
  level.setAttribute('width', String(30 * n / 100));
};
window.hudBatt();
