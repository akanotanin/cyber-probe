// 在 monitor hub 公开页顶栏「扳手（登录）旁边」插一个 cyber-probe 入口。
//
// 做法：克隆现有的 <a href="/admin/">（Lucide wrench 那枚），继承它的全部 class / 尺寸 / hover /
// 焦点样式，只换掉 href、title 和里头的 SVG —— 这样画风、尺寸、间距自动与相邻图标一致。
// 通过主题目录的 dist/index.html 里追加一个 <script> 加载（见 tools/deploy_hub_entry.sh），
// 不改 nginx、不动 hub 二进制。
//
// 坑：顶栏是 React 管的，重渲染会把我插的元素删掉 → 用 MutationObserver 反复补齐，
// 并用 requestAnimationFrame 限频，避免自己触发自己。
(function () {
  var HREF = '/chicken/';
  var LABEL = 'cyber-probe';

  // 与 Lucide 同源的 24×24 线性图标：鸟身轮廓 + 鸡冠（描边/端点由被克隆的 svg 自身决定）
  var ICON =
    '<path d="M16 7h.01"/>' +
    '<path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/>' +
    '<path d="m20 7 2 .5-2 .5"/>' +
    '<path d="M10 18v3"/>' +
    '<path d="M14 17.75V21"/>' +
    '<path d="M7 18a6 6 0 0 0 3.84-10.61"/>' +
    '<path d="M13.6 3.4c.3-1.2 1-1.9 2-1.9.9 0 1.6.7 1.9 1.8"/>';

  var scheduled = false;
  function sync() {
    var host = document.querySelector('header') || document.body;
    if (!host) return;
    var anchor = host.querySelector('a[href="/admin/"]');
    if (!anchor) return;                       // 后台入口不在（例如窄屏折叠）就先不插
    if (host.querySelector('a[href="' + HREF + '"]')) return;

    var a = anchor.cloneNode(true);
    a.setAttribute('href', HREF);
    a.setAttribute('title', LABEL);
    a.setAttribute('aria-label', LABEL);
    a.removeAttribute('target');
    a.removeAttribute('rel');
    var svg = a.querySelector('svg');
    if (svg) svg.innerHTML = ICON;
    anchor.insertAdjacentElement('afterend', a);
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; sync(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }
  try {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* 老浏览器就算了 */ }
})();
