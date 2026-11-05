/**
 * 数据看板
 * KPI 总览 + 销售趋势与预测 + 平台占比 + 库存健康度 + 品类货值 + 紧急补货 + 实时事件流
 */
import { api } from '../api.js';
import {
  money, yuan, num, pct, fixed, healthBadge, urgencyBadge, esc, hms, clock,
  makeChart, chartBase, axisStyle, CHART_COLORS, toast, emptyState, skeleton, stockBar,
} from '../utils.js';
import { onRealtime } from '../bus.js';
import { openProductDrawer } from '../product-detail.js';

/* ==================== 智能问候面板 ==================== */

/** 核心功能快捷入口：与左侧导航保持一致，仅取业务主线 */
const QUICK_ACTIONS = [
  {
    href: '#/inventory', title: '商品库存', desc: '多平台库存明细',
    color: '#2563EB', bg: 'rgba(37, 99, 235, 0.10)',
    icon: '<path d="M21 8V6a2 2 0 00-1-1.7l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 6v12a2 2 0 001 1.7l7 4a2 2 0 002 0l7-4A2 2 0 0021 18V8z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>',
  },
  {
    href: '#/replenish', title: '智能补货', desc: 'AI 建议与核验',
    color: '#0F766E', bg: 'rgba(15, 118, 110, 0.10)',
    icon: '<path d="M21 12a9 9 0 11-2.64-6.36"/><path d="M21 3v6h-6"/><path d="M12 8v4l2.6 1.6"/>',
  },
  {
    href: '#/orders', title: '供应商订单', desc: '采购单与入库',
    color: '#B45309', bg: 'rgba(180, 83, 9, 0.10)',
    icon: '<path d="M9 3h6l1 3h3a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h3l1-3z"/><path d="M8 12h8M8 16h5"/>',
  },
  {
    href: '#/pricing', title: '价格监控', desc: '跨平台竞品比价',
    color: '#7C3AED', bg: 'rgba(124, 58, 237, 0.10)',
    icon: '<path d="M20.6 13.4L13.4 20.6a2 2 0 01-2.8 0l-7.2-7.2A2 2 0 013 12V5a2 2 0 012-2h7a2 2 0 011.4.6l7.2 7.2a2 2 0 010 2.6z"/><circle cx="8" cy="8" r="1.4"/>',
  },
  {
    href: '#/alerts', title: '预警中心', desc: '水位与异常告警',
    color: '#BE123C', bg: 'rgba(190, 18, 60, 0.10)',
    icon: '<path d="M10.3 3.9a2 2 0 013.4 0l7 12A2 2 0 0119 19H5a2 2 0 01-1.7-3.1l7-12z"/><path d="M12 9v4M12 16.5v.5"/>',
  },
  {
    href: '#/datasource', title: '数据源接入', desc: '仿真子系统联动',
    color: '#0E7490', bg: 'rgba(14, 116, 144, 0.10)',
    icon: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/><path d="M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  },
];

/** 按当前小时给问候语 */
function pickGreeting(h) {
  if (h < 5) return { text: '夜深了', emoji: '🌙' };
  if (h < 9) return { text: '早上好', emoji: '☀️' };
  if (h < 12) return { text: '上午好', emoji: '🌤️' };
  if (h < 14) return { text: '中午好', emoji: '🍱' };
  if (h < 18) return { text: '下午好', emoji: '🌤️' };
  if (h < 23) return { text: '晚上好', emoji: '🌆' };
  return { text: '夜深了', emoji: '🌙' };
}

/** 右侧 3D 立方体 + 环流轨道 + 浮动业务图标 */
const HERO_VISUAL = `
<div class="hero-visual" aria-hidden="true">
  <svg class="hero-svg" viewBox="0 0 360 250" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="hvTop" x1="130" y1="64" x2="262" y2="140" gradientUnits="userSpaceOnUse">
        <stop stop-color="#A5CDFE"/><stop offset="1" stop-color="#5EA7FA"/>
      </linearGradient>
      <linearGradient id="hvLeft" x1="130" y1="102" x2="196" y2="214" gradientUnits="userSpaceOnUse">
        <stop stop-color="#2563EB"/><stop offset="1" stop-color="#1E3A8A"/>
      </linearGradient>
      <linearGradient id="hvRight" x1="196" y1="140" x2="262" y2="176" gradientUnits="userSpaceOnUse">
        <stop stop-color="#3B82F6"/><stop offset="1" stop-color="#1D4ED8"/>
      </linearGradient>
      <radialGradient id="hvHalo" cx="50%" cy="50%" r="50%">
        <stop stop-color="#60A5FA" stop-opacity=".34"/>
        <stop offset="1" stop-color="#60A5FA" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="hvGround" cx="50%" cy="50%" r="50%">
        <stop stop-color="#2563EB" stop-opacity=".24"/>
        <stop offset="1" stop-color="#2563EB" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="hvRing" x1="40" y1="120" x2="320" y2="180" gradientUnits="userSpaceOnUse">
        <stop stop-color="#93C5FD" stop-opacity=".08"/>
        <stop offset=".45" stop-color="#3B82F6" stop-opacity=".85"/>
        <stop offset="1" stop-color="#93C5FD" stop-opacity=".08"/>
      </linearGradient>
    </defs>

    <!-- 中心光晕 -->
    <ellipse cx="196" cy="152" rx="172" ry="92" fill="url(#hvHalo)"/>

    <!-- 环绕轨道：宽描边做柔光带，细描边做轨迹线 -->
    <g class="hv-rings">
      <ellipse cx="196" cy="150" rx="150" ry="47" transform="rotate(-7 196 150)" stroke="rgba(96, 165, 250, 0.13)" stroke-width="10"/>
      <ellipse cx="196" cy="154" rx="126" ry="70" transform="rotate(12 196 154)" stroke="rgba(147, 197, 253, 0.15)" stroke-width="8"/>
      <ellipse cx="196" cy="148" rx="164" ry="86" transform="rotate(-16 196 148)" stroke="rgba(191, 219, 254, 0.20)" stroke-width="6"/>

      <ellipse cx="196" cy="150" rx="150" ry="47" transform="rotate(-7 196 150)" stroke="url(#hvRing)" stroke-width="1.3" opacity=".9" class="hv-dash"/>
      <ellipse cx="196" cy="154" rx="126" ry="70" transform="rotate(12 196 154)" stroke="rgba(59, 130, 246, 0.22)" stroke-width="1"/>
      <ellipse cx="196" cy="148" rx="164" ry="86" transform="rotate(-16 196 148)" stroke="rgba(147, 197, 253, 0.4)" stroke-width=".8"/>
    </g>

    <!-- 地面投影 -->
    <ellipse cx="196" cy="192" rx="54" ry="12" fill="url(#hvGround)"/>

    <!-- 等距立方体：外层缩放定位，内层挂浮动动画 -->
    <g transform="translate(196 128) scale(0.92) translate(-196 -138)">
      <g class="hv-cube">
        <polygon points="196,64 262,102 196,140 130,102" fill="url(#hvTop)"/>
        <polygon points="130,102 196,140 196,214 130,176" fill="url(#hvLeft)"/>
        <polygon points="262,102 196,140 196,214 262,176" fill="url(#hvRight)"/>
        <polygon points="196,76 240,101 196,126 152,101" fill="rgba(255, 255, 255, 0.18)"/>
        <path d="M196 64L262 102L196 140L130 102Z" stroke="rgba(255, 255, 255, 0.6)" stroke-width="1.2" stroke-linejoin="round"/>
        <path d="M196 140V214" stroke="rgba(255, 255, 255, 0.3)" stroke-width="1.2"/>
        <path d="M130 176L196 214L262 176" stroke="rgba(255, 255, 255, 0.22)" stroke-width="1.2" stroke-linejoin="round"/>
      </g>
    </g>

    <!-- 浮动业务图标 -->
    <g transform="translate(62, 92)"><g class="hv-float f1">
      <circle r="17" fill="#fff" opacity=".96"/>
      <circle r="17" stroke="rgba(37, 99, 235, 0.16)"/>
      <path d="M-6.5 6v-7M0 6v-12M6.5 6v-4" stroke="#2563EB" stroke-width="2.2" stroke-linecap="round"/>
    </g></g>

    <g transform="translate(298, 86)"><g class="hv-float f2">
      <circle r="16" fill="#fff" opacity=".96"/>
      <circle r="16" stroke="rgba(14, 165, 233, 0.18)"/>
      <path d="M0 -7l6.6 3.4v7.2L0 7l-6.6-3.4v-7.2z" stroke="#0EA5E9" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M-6.6 -3.6L0 0l6.6-3.6M0 0v7" stroke="#0EA5E9" stroke-width="1.5" stroke-linejoin="round"/>
    </g></g>

    <g transform="translate(310, 176)"><g class="hv-float f3">
      <circle r="17" fill="#fff" opacity=".96"/>
      <circle r="17" stroke="rgba(124, 58, 237, 0.18)"/>
      <path d="M-8 -6.5h2.2l2.4 8.4h9L8 -2.2H-4.8" stroke="#7C3AED" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="-1.8" cy="6" r="1.5" fill="#7C3AED"/>
      <circle cx="5.2" cy="6" r="1.5" fill="#7C3AED"/>
    </g></g>

    <g transform="translate(82, 176)"><g class="hv-float f4">
      <circle r="15" fill="#fff" opacity=".96"/>
      <circle r="15" stroke="rgba(16, 185, 129, 0.2)"/>
      <ellipse cx="0" cy="-4.4" rx="6.6" ry="2.4" stroke="#0F766E" stroke-width="1.4"/>
      <path d="M-6.6 -4.4v6.6c0 1.3 3 2.4 6.6 2.4s6.6-1.1 6.6-2.4v-6.6" stroke="#0F766E" stroke-width="1.4"/>
    </g></g>
  </svg>
</div>`;


/** 角落枝叶装饰：呼应浅绿主题的植物元素，纯装饰 */
const LEAF_ART = `
<svg class="hero-leaf lt" viewBox="0 0 160 160" fill="none" aria-hidden="true">
  <path d="M10 154C36 124 58 92 76 46" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55"/>
  <path d="M72 66c-14-2-24-12-27-26 14-2 25 6 29 18z" fill="currentColor" opacity=".5"/>
  <path d="M80 46c11-9 25-10 35-3-4 12-16 18-28 16z" fill="currentColor" opacity=".42"/>
  <path d="M58 96c-15 0-27-7-32-20 14-4 26 2 32 12z" fill="currentColor" opacity=".46"/>
  <path d="M64 86c10-9 23-12 34-7-3 12-14 19-26 18z" fill="currentColor" opacity=".38"/>
  <path d="M40 124c-14 3-26-1-33-12 11-7 24-4 32 5z" fill="currentColor" opacity=".44"/>
</svg>
<svg class="hero-leaf rb" viewBox="0 0 160 160" fill="none" aria-hidden="true">
  <path d="M10 154C36 124 58 92 76 46" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55"/>
  <path d="M72 66c-14-2-24-12-27-26 14-2 25 6 29 18z" fill="currentColor" opacity=".5"/>
  <path d="M80 46c11-9 25-10 35-3-4 12-16 18-28 16z" fill="currentColor" opacity=".42"/>
  <path d="M58 96c-15 0-27-7-32-20 14-4 26 2 32 12z" fill="currentColor" opacity=".46"/>
</svg>`;

/**
 * 面板骨架：问候语与快捷入口不依赖接口数据，先渲染；
 * 三项快照等 overview 返回后再填充，避免首屏空白。
 */
function heroHTML() {
  const g = pickGreeting(new Date().getHours());
  return `
  <section class="hero">
    ${LEAF_ART}
    <div class="hero-main">
      ${HERO_VISUAL}
      <div class="hero-text">
        <div class="hero-hello">
          <span>${esc(g.text)}，</span>
          <span class="hero-name">经理</span>
          <span class="hero-wave" aria-hidden="true">${g.emoji}</span>
        </div>
        <p class="hero-sub">
          欢迎使用 <strong>电商智能库存补货系统</strong>
          <i>· 全渠道库存同步与 AI 补货决策</i>
        </p>
        <div class="hero-metrics" id="hero-metrics">
          ${[0, 1, 2].map(() => `
            <div class="hero-metric">
              <div class="hm-label">&nbsp;</div>
              <div class="hm-value hm-skel"></div>
              <div class="hm-delta">&nbsp;</div>
            </div>`).join('')}
        </div>
      </div>
    </div>
    <nav class="hero-actions" aria-label="核心功能快捷入口">
      ${QUICK_ACTIONS.map((a) => `
        <a class="sc-item" href="${a.href}">
          <span class="sc-icon" style="background:${a.bg};color:${a.color}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" stroke-linejoin="round">${a.icon}</svg>
          </span>
          <span class="sc-text">
            <span class="sc-title">${a.title}</span>
            <span class="sc-desc">${a.desc}</span>
          </span>
        </a>`).join('')}
    </nav>
  </section>`;
}

/** 填充三项快照：今日销售额 / 今日出库 / 待处理任务 */
function renderHeroMetrics(data) {
  const box = document.getElementById('hero-metrics');
  if (!box || !data || !data.kpi) return;

  const { kpi, trend } = data;
  const sales = (trend && trend.sales) || [];
  const qty = (trend && trend.qty) || [];

  /**
   * 参照基准取「前 7 天均值」，不含今天。
   * 今日是进行中的半天数据，直接和昨日全天比会恒定显示大幅下跌（实测 -87%），
   * 属于误导性结论，因此只给客观参照，不做涨跌判断。
   */
  const avgPrev7 = (arr) => {
    const prev = arr.slice(-8, -1);
    if (!prev.length) return 0;
    return prev.reduce((s, v) => s + v, 0) / prev.length;
  };

  const avgSales = avgPrev7(sales);
  const avgQty = avgPrev7(qty);
  const pending = (kpi.pendingSuggestions || 0) + ((kpi.alerts && kpi.alerts.total) || 0);

  box.innerHTML = `
    <div class="hero-metric">
      <div class="hm-label">今日销售额</div>
      <div class="hm-value">¥ ${money(kpi.todaySales)}</div>
      <div class="hm-delta">近 7 日均 ¥${money(avgSales)}</div>
    </div>
    <div class="hero-metric">
      <div class="hm-label">今日出库</div>
      <div class="hm-value">${num(kpi.todayQty)}<small>件</small></div>
      <div class="hm-delta">近 7 日均 ${num(Math.round(avgQty))} 件</div>
    </div>
    <div class="hero-metric">
      <div class="hm-label">待处理任务</div>
      <div class="hm-value">${pending}<small>项</small></div>
      <div class="hm-delta">补货建议 ${kpi.pendingSuggestions || 0} · 预警 ${(kpi.alerts && kpi.alerts.total) || 0}</div>
    </div>`;
}

export async function mountDashboard(root) {
  root.innerHTML = `
    ${heroHTML()}
    <div class="kpi-grid" id="kpi-grid">${skeleton(2)}</div>
    <div class="grid grid-21 mb-14">
      <div class="card">
        <div class="card-head">
          <div class="card-title">销售趋势与需求预测 <span class="card-sub">近 30 天实际 · 未来 7 天预测</span></div>
          <div class="tabs" id="trend-tabs">
            <button class="tab active" data-k="sales">销售额</button>
            <button class="tab" data-k="qty">销量</button>
          </div>
        </div>
        <div class="chart" id="chart-trend"></div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">库存健康度</div></div>
        <div class="chart chart-sm" id="chart-health"></div>
        <div id="health-list" style="margin-top:6px"></div>
      </div>
    </div>
    <div class="grid grid-12 mb-14">
      <div class="card">
        <div class="card-head"><div class="card-title">平台销售占比 <span class="card-sub">近 30 天</span></div></div>
        <div class="chart chart-sm" id="chart-platform"></div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">紧急补货清单</div>
          <a href="#/replenish" style="font-size:11.5px;color:var(--cyan);text-decoration:none">前往审核 →</a>
        </div>
        <div id="urgent-list">${skeleton(3)}</div>
      </div>
    </div>
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><div class="card-title">品类库存货值分布</div></div>
        <div class="chart" id="chart-category"></div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">实时事件流 <span class="card-sub">平台订单 / 库存同步</span></div>
          <span class="badge badge-info" id="event-count">0</span>
        </div>
        <div class="event-feed" id="event-feed"></div>
      </div>
    </div>
  `;

  const data = await api.overview();
  renderHeroMetrics(data);
  renderKpi(data.kpi, data.trend);
  renderHealth(data.healthDist);
  renderUrgent(data.urgent);
  renderCharts(data);
  await seedEventFeed();

  // 趋势切换
  let trendKey = 'sales';
  const trendInst = window.__trendChart;
  root.querySelectorAll('#trend-tabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('#trend-tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
      trendKey = btn.dataset.k;
      if (trendInst) trendInst.setOption(buildTrendOption(data.trend, trendKey), true);
    });
  });

  // 紧急补货行点击 → 打开商品详情
  root.querySelector('#urgent-list').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-pid]');
    if (row) openProductDrawer(Number(row.dataset.pid));
  });

  /* ---------- 实时事件 ---------- */
  let eventCount = 0;
  const feed = root.querySelector('#event-feed');
  const addEvent = (row) => {
    eventCount += 1;
    root.querySelector('#event-count').textContent = eventCount;
    feed.prepend(row);
    while (feed.children.length > 24) feed.lastElementChild.remove();
  };

  const off = onRealtime((type, d) => {
    if (type === 'order.paid') {
      addEvent(buildEventRow({
        cls: 'success', time: clock(),
        title: `${d.sku} 订单出库`,
        desc: `${d.platformName} 成交 ${d.qty} 件 · 该平台余 ${d.stockAfter}`,
      }));
    } else if (type === 'sync.done') {
      addEvent(buildEventRow({
        cls: 'info', time: clock(),
        title: '全渠道库存同步完成',
        desc: `${d.platforms} 个平台，${d.changed} 条库存更新`,
      }));
    } else if (type === 'recomputed') {
      if (d.alerts > 0 || (d.suggestions && d.suggestions.created > 0)) {
        addEvent(buildEventRow({
          cls: 'warn', time: clock(),
          title: '库存健康复算',
          desc: `新增预警 ${d.alerts} 条${d.suggestions?.created ? `，新增补货建议 ${d.suggestions.created} 条` : ''}`,
        }));
      }
    }
  });

  return () => off();
}

/* ---------------- 渲染：KPI ---------------- */
function renderKpi(k, trend) {
  const growth = k.weekGrowth;
  const growthCls = growth >= 0 ? 'trend-up' : 'trend-down';
  const growthIcon = growth >= 0 ? '▲' : '▼';

  document.getElementById('kpi-grid').innerHTML = `
    <div class="kpi">
      <div class="kpi-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
        库存总货值
      </div>
      <div class="kpi-value">${money(k.stockValue)}<small>元</small></div>
      <div class="kpi-foot">零售市值 ${money(k.retailValue)} 元 · ${num(k.totalStock)} 件在库</div>
    </div>
    <div class="kpi ok">
      <div class="kpi-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l6-6 4 4 8-8"/><path d="M21 7v6h-6"/></svg>
        本周销售额
      </div>
      <div class="kpi-value">${money(k.weekSales)}<small>元</small></div>
      <div class="kpi-foot">
        <span class="${growthCls}">${growthIcon} ${Math.abs(growth).toFixed(1)}%</span> 较上周 · ${num(k.weekQty)} 件
      </div>
    </div>
    <div class="kpi ${k.needReplenish > 0 ? 'warn' : 'ok'}">
      <div class="kpi-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>
        待补货 SKU
      </div>
      <div class="kpi-value">${k.needReplenish}<small>/ ${k.skuCount}</small></div>
      <div class="kpi-foot">其中 ${k.outOfStock} 个已断货</div>
    </div>
    <div class="kpi ${k.pendingSuggestions > 0 ? 'purple' : ''}">
      <div class="kpi-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
        待审核建议
      </div>
      <div class="kpi-value">${k.pendingSuggestions}<small>条</small></div>
      <div class="kpi-foot">采购单在途 ${k.pendingOrders} 张 · ${money(k.pendingOrderAmount)} 元</div>
    </div>
    <div class="kpi ${k.avgTurnoverDays > 60 ? 'warn' : ''}">
      <div class="kpi-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
        平均周转天数
      </div>
      <div class="kpi-value">${fixed(k.avgTurnoverDays, 1)}<small>天</small></div>
      <div class="kpi-foot">预测未来 7 天销量 ${num(trend.forecastTotal)} 件</div>
    </div>
    <div class="kpi ${k.alerts.critical > 0 ? 'danger' : k.alerts.total > 0 ? 'warn' : 'ok'}">
      <div class="kpi-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.9a2 2 0 013.4 0l7 12A2 2 0 0119 19H5a2 2 0 01-1.7-3.1l7-12z"/><path d="M12 9v4"/></svg>
        未处理预警
      </div>
      <div class="kpi-value">${k.alerts.total}<small>条</small></div>
      <div class="kpi-foot">紧急 ${k.alerts.critical} · 警告 ${k.alerts.warning} · 提示 ${k.alerts.info}</div>
    </div>
  `;
}

/* ---------------- 渲染：健康度 ---------------- */
function renderHealth(dist) {
  const colors = {
    out_of_stock: '#E11D48', critical: '#F43F5E', warning: '#D97706',
    healthy: '#10B981', overstock: '#8B5CF6',
  };
  const total = dist.reduce((s, d) => s + d.count, 0);

  const chart = makeChart(document.getElementById('chart-health'), {
    ...chartBase,
    grid: { left: 0, right: 0, top: 6, bottom: 0 },
    tooltip: { ...chartBase.tooltip, trigger: 'item', formatter: '{b}<br/>数量 {c} 个（{d}%）' },
    series: [{
      type: 'pie',
      radius: ['54%', '80%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: '#FFFFFF', borderWidth: 3, borderRadius: 3 },
      label: {
        show: true, position: 'center',
        formatter: () => `{a|${total}}\n{b|SKU 总数}`,
        rich: {
          a: { fontSize: 24, fontWeight: 700, color: '#0F172A', fontFamily: 'monospace', lineHeight: 30 },
          b: { fontSize: 10.5, color: '#5F6F85' },
        },
      },
      emphasis: { label: { show: true }, scale: true, scaleSize: 4 },
      labelLine: { show: false },
      data: dist.filter((d) => d.count > 0).map((d) => ({
        name: d.label, value: d.count, itemStyle: { color: colors[d.status] },
      })),
    }],
  });
  if (chart) chart.setOption({ title: { show: false } });

  // 环形图中间的 label 需要 a/b 标记
  if (chart) {
    chart.setOption({
      series: [{
        label: {
          show: true, position: 'center',
          formatter: `{a|${total}}\n{b|SKU 总数}`,
          rich: {
            a: { fontSize: 24, fontWeight: 700, color: '#0F172A', fontFamily: 'monospace', lineHeight: 30 },
            b: { fontSize: 10.5, color: '#5F6F85' },
          },
        },
      }],
    });
  }

  const list = document.getElementById('health-list');
  list.innerHTML = dist.map((d) => `
    <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;padding:3px 0">
      <span class="plat-dot" style="background:${colors[d.status]}"></span>
      <span style="color:var(--text-2);flex:1">${d.label}</span>
      <span style="font-family:var(--mono);font-weight:600">${d.count}</span>
      <span style="color:var(--text-3);width:44px;text-align:right">${total ? ((d.count / total) * 100).toFixed(0) : 0}%</span>
    </div>
  `).join('');
}

/* ---------------- 渲染：紧急补货 ---------------- */
function renderUrgent(rows) {
  const box = document.getElementById('urgent-list');
  if (!rows || !rows.length) {
    box.innerHTML = emptyState('暂无待处理补货建议', '所有商品库存均处于健康水位');
    return;
  }

  box.innerHTML = `
    <div class="table-wrap">
      <table class="data">
        <thead><tr>
          <th>商品</th><th style="text-align:right">可售</th><th style="text-align:right">日均</th>
          <th style="text-align:right">建议</th><th>紧急度</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr class="clickable" data-pid="${r.product_id}">
              <td>
                <div class="pname">${esc(r.name.length > 15 ? r.name.slice(0, 15) + '…' : r.name)}</div>
                <div class="sku">${r.sku}</div>
              </td>
              <td class="num">${r.available_stock}<div style="margin-top:3px">${stockBar(r.avg_daily_sales > 0 ? r.available_stock / r.avg_daily_sales : 0)}</div></td>
              <td class="num">${fixed(r.avg_daily_sales, 1)}</td>
              <td class="num" style="color:var(--cyan);font-weight:600">${r.final_qty}</td>
              <td>${urgencyBadge(r.urgency)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

/* ---------------- 渲染：图表 ---------------- */
function renderCharts(data) {
  // 趋势图
  const trendDom = document.getElementById('chart-trend');
  const inst = makeChart(trendDom, buildTrendOption(data.trend, 'sales'));
  window.__trendChart = inst;

  // 平台占比
  makeChart(document.getElementById('chart-platform'), {
    ...chartBase,
    grid: { left: 0, right: 0, top: 8, bottom: 0 },
    tooltip: {
      ...chartBase.tooltip, trigger: 'item',
      formatter: (p) => `${p.name}<br/>销售额 ¥${num(p.value)}（${p.percent}%）`,
    },
    legend: {
      bottom: 0, left: 'center', icon: 'circle', itemWidth: 7, itemHeight: 7,
      textStyle: { color: '#475569', fontSize: 11 }, itemGap: 12,
    },
    series: [{
      type: 'pie',
      radius: ['46%', '70%'],
      center: ['50%', '44%'],
      itemStyle: { borderColor: '#FFFFFF', borderWidth: 3, borderRadius: 3 },
      label: { show: false },
      emphasis: { scale: true, scaleSize: 5 },
      data: data.platformShare.map((p, i) => ({
        name: p.name, value: p.sales,
        itemStyle: { color: p.color && p.color !== '#161823' ? p.color : CHART_COLORS[i % CHART_COLORS.length] },
      })),
    }],
  });

  // 品类货值
  const cats = [...data.categoryStock].sort((a, b) => a.value - b.value);
  makeChart(document.getElementById('chart-category'), {
    ...chartBase,
    grid: { left: 8, right: 30, top: 12, bottom: 6, containLabel: true },
    tooltip: {
      ...chartBase.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (ps) => {
        const p = ps[0];
        return `${p.name}<br/>货值 ¥${num(p.value)}（${money(p.value)}）`;
      },
    },
    xAxis: { type: 'value', ...axisStyle, axisLabel: { ...axisStyle.axisLabel, formatter: (v) => money(v) } },
    yAxis: { type: 'category', data: cats.map((c) => c.name), ...axisStyle, axisLine: { show: false }, splitLine: { show: false } },
    series: [{
      type: 'bar',
      data: cats.map((c) => c.value),
      barWidth: '52%',
      itemStyle: {
        borderRadius: [0, 5, 5, 0],
        color: {
          type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
          colorStops: [
            { offset: 0, color: 'rgba(47,158,98,.32)' },
            { offset: 1, color: '#34B37E' },
          ],
        },
      },
      label: {
        show: true, position: 'right', color: '#475569', fontSize: 10.5,
        formatter: (p) => money(p.value),
      },
    }],
  });
}

/** 构造趋势图配置（销售额 / 销量 双模式） */
function buildTrendOption(trend, key) {
  const isSales = key === 'sales';
  const actual = isSales ? trend.sales : trend.qty;
  const forecast = isSales ? trend.forecastSales : trend.forecastQty;
  const xData = [...trend.dates, ...trend.forecastDates];
  const pad = new Array(trend.dates.length - 1).fill(null);

  const actualSeries = [...actual, ...new Array(forecast.length).fill(null)];
  const forecastSeries = [...pad, actual[actual.length - 1], ...forecast];

  return {
    ...chartBase,
    grid: { left: 8, right: 18, top: 38, bottom: 6, containLabel: true },
    legend: {
      top: 0, right: 6, icon: 'roundRect', itemWidth: 12, itemHeight: 3, itemGap: 14,
      textStyle: { color: '#475569', fontSize: 11 },
      data: ['实际', '预测'],
    },
    tooltip: {
      ...chartBase.tooltip,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: 'rgba(47,158,98,.35)', type: 'dashed' } },
      formatter: (ps) => {
        const title = ps[0].axisValue;
        const lines = ps.filter((p) => p.value != null).map((p) => {
          const v = isSales ? `¥${num(p.value)}` : `${num(p.value)} 件`;
          return `${p.marker}${p.seriesName}：<b>${v}</b>`;
        });
        return `${title}<br/>${lines.join('<br/>')}`;
      },
    },
    xAxis: {
      type: 'category',
      data: xData,
      boundaryGap: false,
      ...axisStyle,
      axisLabel: {
        ...axisStyle.axisLabel,
        interval: Math.max(0, Math.floor(xData.length / 8)),
        color: (value, index) => (index >= trend.dates.length ? '#4FBB81' : '#5E7265'),
      },
    },
    yAxis: {
      type: 'value',
      ...axisStyle,
      axisLabel: { ...axisStyle.axisLabel, formatter: (v) => (isSales ? money(v) : v) },
    },
    series: [
      {
        name: '实际',
        type: 'line',
        data: actualSeries,
        smooth: 0.32,
        symbol: 'none',
        lineStyle: { width: 2.4, color: '#2F9E62' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(47,158,98,.26)' },
              { offset: 1, color: 'rgba(47,158,98,0)' },
            ],
          },
        },
      },
      {
        name: '预测',
        type: 'line',
        data: forecastSeries,
        smooth: 0.32,
        symbol: 'circle',
        symbolSize: 4,
        // 注意：预测段起点前为 null，ECharts 的 areaStyle 会从首个非空点向基线拉出
        // 一块矩形填充，视觉上很突兀，因此预测线只保留虚线不做面积填充
        lineStyle: { width: 2, color: '#D97706', type: 'dashed' },
        itemStyle: { color: '#D97706' },
      },
    ],
  };
}

/* ---------------- 事件流 ---------------- */
function buildEventRow({ cls, time, title, desc }) {
  const div = document.createElement('div');
  div.className = `event-row ${cls}`;
  div.innerHTML = `<time>${esc(time)}</time><div><strong>${esc(title)}</strong><p>${esc(desc)}</p></div>`;
  return div;
}

async function seedEventFeed() {
  const feed = document.getElementById('event-feed');
  if (!feed) return;
  try {
    const { list } = await api.syncLogs(12);
    const label = {
      order_paid: ['订单支付', 'success'],
      stock_update: ['库存变更', 'info'],
      price_change: ['价格变动', 'warn'],
      inventory_pull: ['库存拉取', 'info'],
    };
    feed.innerHTML = list.map((l) => {
      const [text, cls] = label[l.event_type] || ['事件', 'info'];
      return `<div class="event-row ${cls}">
        <time>${hms(l.created_at)}</time>
        <div><strong>${esc(l.platform_name || '系统')} · ${text}</strong>
        <p>延迟 ${l.latency_ms}ms · ${esc(l.payload || '').slice(0, 46)}</p></div>
      </div>`;
    }).join('');
    const cnt = document.getElementById('event-count');
    if (cnt) cnt.textContent = list.length;
  } catch (_) { /* 忽略 */ }
}
