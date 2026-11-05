/**
 * 通用工具：格式化、徽章、图表主题、DOM 辅助
 */

/** 金额格式化：大数自动转万/亿 */
export function money(n, digits = 0) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
  return v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 带 ¥ 前缀的完整金额 */
export function yuan(n, digits = 2) {
  return `¥${(Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function num(n) {
  return (Number(n) || 0).toLocaleString('zh-CN');
}

export function pct(n, digits = 1) {
  return `${(Number(n) || 0).toFixed(digits)}%`;
}

/** 数字补齐 */
export function fixed(n, d = 1) {
  return (Number(n) || 0).toFixed(d);
}

/** 健康状态 → 徽章 */
export const HEALTH_MAP = {
  out_of_stock: { text: '已断货', cls: 'badge-critical' },
  critical: { text: '低于安全库存', cls: 'badge-critical' },
  warning: { text: '达到补货线', cls: 'badge-warning' },
  healthy: { text: '库存健康', cls: 'badge-success' },
  overstock: { text: '库存积压', cls: 'badge-purple' },
};

export function healthBadge(status) {
  const m = HEALTH_MAP[status] || { text: status, cls: 'badge-muted' };
  return `<span class="badge ${m.cls}"><b></b>${m.text}</span>`;
}

export const URGENCY_MAP = {
  critical: { text: '紧急', cls: 'badge-critical' },
  high: { text: '偏高', cls: 'badge-warning' },
  normal: { text: '常规', cls: 'badge-info' },
  none: { text: '暂缓', cls: 'badge-muted' },
};

export function urgencyBadge(u) {
  const m = URGENCY_MAP[u] || { text: u, cls: 'badge-muted' };
  return `<span class="badge ${m.cls}">${m.text}</span>`;
}

export const ORDER_STATUS_MAP = {
  pending: { text: '待确认', cls: 'badge-warning' },
  confirmed: { text: '已确认', cls: 'badge-info' },
  shipped: { text: '已发货', cls: 'badge-purple' },
  received: { text: '已入库', cls: 'badge-success' },
  cancelled: { text: '已取消', cls: 'badge-muted' },
};

export function orderStatusBadge(s) {
  const m = ORDER_STATUS_MAP[s] || { text: s, cls: 'badge-muted' };
  return `<span class="badge ${m.cls}"><b></b>${m.text}</span>`;
}

export const SUG_STATUS_MAP = {
  pending: { text: '待审核', cls: 'badge-warning' },
  approved: { text: '已通过', cls: 'badge-info' },
  ordered: { text: '已下单', cls: 'badge-success' },
  rejected: { text: '已驳回', cls: 'badge-muted' },
};

/** 库存水位条：按可售天数着色 */
export function stockBar(days, threshold = 30) {
  const ratio = Math.max(0, Math.min(100, (days / (threshold * 1.6)) * 100));
  const cls = days < 7 ? 'bar-fill-danger' : days < threshold ? 'bar-fill-warn' : 'bar-fill-ok';
  return `<div class="bar"><i class="${cls}" style="width:${ratio}%"></i></div>`;
}

/** ESC 转义，防止商品名等文本破坏 HTML 结构 */
export function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 创建元素 */
export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

/** 千分位时间：只保留 时:分:秒 */
export function hms(dt) {
  if (!dt) return '—';
  const s = String(dt);
  const m = s.match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : s;
}

export function clock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function debounce(fn, wait = 260) {
  let t;
  return function debounced(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

/* ---------------- 图表主题 ---------------- */

export const CHART_COLORS = ['#2F9E62', '#4FBB81', '#0F766E', '#8AC48E', '#B45309', '#BE123C', '#7C3AED', '#17795B'];

/** ECharts 浅色玻璃主题统一配置 */
export const chartBase = {
  textStyle: { fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif', color: '#475569' },
  grid: { left: 8, right: 16, top: 34, bottom: 6, containLabel: true },
  tooltip: {
    backgroundColor: 'rgba(255, 255, 255, 0.96)',
    borderColor: 'rgba(148, 163, 184, 0.28)',
    borderWidth: 1,
    textStyle: { color: '#0F172A', fontSize: 12 },
    padding: [10, 14],
    extraCssText: 'border-radius:12px; box-shadow:0 12px 34px rgba(15,23,42,.14); backdrop-filter:blur(12px);',
  },
};

/** 通用坐标轴样式（浅色） */
export const axisStyle = {
  axisLine: { lineStyle: { color: 'rgba(148, 163, 184, 0.35)' } },
  axisTick: { show: false },
  axisLabel: { color: '#5F6F85', fontSize: 10.5 },
  splitLine: { lineStyle: { color: 'rgba(148, 163, 184, 0.16)' } },
};

/** 维护图表实例，切换视图时统一销毁 */
const charts = [];
export function makeChart(dom, option) {
  if (!dom) return null;
  /**
   * echarts 以 defer 方式加载，执行到这里说明脚本还没成功落地（弱网、被拦截、CDN 故障）。
   * 此时不能让整个视图跟着崩掉——降级成一句可读提示，页面其余部分照常可用。
   */
  if (typeof echarts === 'undefined') {
    dom.innerHTML = '<div class="chart-fallback">图表组件未加载成功，请刷新页面重试</div>';
    return null;
  }
  const inst = echarts.init(dom, null, { renderer: 'canvas' });
  inst.setOption(option);
  charts.push(inst);
  return inst;
}

export function disposeCharts() {
  while (charts.length) {
    const c = charts.pop();
    try { c.dispose(); } catch (_) { /* 已销毁 */ }
  }
}

/** 窗口尺寸变化时自适应 */
let resizeBound = false;
export function bindChartResize() {
  if (resizeBound) return;
  resizeBound = true;
  window.addEventListener('resize', () => {
    for (const c of charts) {
      try { c.resize(); } catch (_) { /* 忽略 */ }
    }
  });
}

/* ---------------- 交互反馈 ---------------- */

export function toast(message, type = 'info', title = '') {
  const stack = document.getElementById('toasts');
  if (!stack) return;
  const node = el(`
    <div class="toast ${type}">
      <i class="dot"></i>
      <div>${title ? `<b>${esc(title)}</b>` : ''}<span>${esc(message)}</span></div>
    </div>
  `);
  stack.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 240);
  }, 3600);
  // 最多保留 5 条
  while (stack.children.length > 5) stack.firstElementChild.remove();
}

/** 简易确认框，返回 Promise<boolean> */
export function confirmDialog(title, message, okText = '确认', danger = false) {
  return new Promise((resolve) => {
    const mask = document.getElementById('modal-mask');
    const mt = document.getElementById('modal-title');
    const mb = document.getElementById('modal-body');
    const mf = document.getElementById('modal-foot');
    mt.textContent = title;
    mb.innerHTML = `<p style="font-size:13px;line-height:1.7;color:var(--text-2)">${message}</p>`;
    mf.innerHTML = `
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(okText)}</button>
    `;
    mask.hidden = false;
    const close = (val) => {
      mask.hidden = true;
      mf.innerHTML = '';
      mf.removeEventListener('click', onClick);
      resolve(val);
    };
    const onClick = (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      close(btn.dataset.act === 'ok');
    };
    mf.addEventListener('click', onClick);
    document.getElementById('modal-close').onclick = () => close(false);
  });
}

/** 空态占位 */
export function emptyState(title, desc = '') {
  return `
    <div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 8V6a2 2 0 00-1-1.7l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 6v12a2 2 0 001 1.7l7 4a2 2 0 002 0l7-4A2 2 0 0021 18V8z"/>
        <path d="M3.3 7L12 12l8.7-5M12 22V12"/>
      </svg>
      <strong>${esc(title)}</strong>
      ${desc ? `<span>${esc(desc)}</span>` : ''}
    </div>
  `;
}

/** 简易骨架屏 */
export function skeleton(rows = 3) {
  return `<div style="display:flex;flex-direction:column;gap:10px;padding:8px 0">
    ${Array.from({ length: rows }).map(() => '<div class="skeleton" style="height:52px"></div>').join('')}
  </div>`;
}
