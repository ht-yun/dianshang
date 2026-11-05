/**
 * 价格监控：跨平台售价采集、竞品比价与毛利结构
 * 核心价值：把「进货价 vs 各渠道售价」摆在一起，补货决策不只看库存还要看钱
 */
import { api } from '../api.js';
import { num, yuan, pct, esc, debounce, toast, emptyState, makeChart, chartBase, axisStyle, CHART_COLORS } from '../utils.js';
import { openDrawer } from '../ui.js';

export async function mountPricing(root) {
  let rows = [];
  let keyword = '';
  let onlyAnomaly = false;

  root.innerHTML = `
    <div class="kpi-grid" id="price-kpi"></div>
    <div class="toolbar">
      <div class="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input class="input" id="pq" placeholder="搜索商品…" autocomplete="off">
      </div>
      <label class="switch" style="font-size:12px;color:var(--text-2)">
        <input type="checkbox" id="only-anomaly">
        <span class="track"></span>
        只看异常
      </label>
      <div class="spacer"></div>
      <button class="btn btn-ghost btn-sm" id="btn-live" title="尝试抓取商品页真实价格，失败自动回落模拟值">
        真实抓取
      </button>
      <button class="btn btn-primary btn-sm" id="btn-crawl">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-3.5-7.1"/><path d="M21 3v6h-6"/></svg>
        立即采集
      </button>
    </div>
    <div class="card" style="padding:0">
      <div class="table-wrap" id="price-table"></div>
    </div>
  `;

  const tableBox = root.querySelector('#price-table');

  async function load() {
    const data = await api.priceComparison();
    rows = data.list;
    renderKpi(data.summary);
    render();
  }

  function renderKpi(s) {
    root.querySelector('#price-kpi').innerHTML = `
      <div class="kpi ok">
        <div class="kpi-label">平均毛利率</div>
        <div class="kpi-value">${pct(s.avgMargin)}</div>
        <div class="kpi-foot">覆盖 ${s.products} 个在售 SKU</div>
      </div>
      <div class="kpi ${s.anomalyCount > 0 ? 'warn' : 'ok'}">
        <div class="kpi-label">价格异常商品</div>
        <div class="kpi-value">${s.anomalyCount}<small>个</small></div>
        <div class="kpi-foot">跨平台价差 > 22% 或显著高于竞品</div>
      </div>
      <div class="kpi purple">
        <div class="kpi-label">采集数据点</div>
        <div class="kpi-value">${s.products * 4}<small>条</small></div>
        <div class="kpi-foot">真实抓取 ${s.liveCount} 条 · 其余为模拟源</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">平台覆盖</div>
        <div class="kpi-value">4<small>个渠道</small></div>
        <div class="kpi-foot">淘宝 / 京东 / 拼多多 / 抖音</div>
      </div>
    `;
  }

  function render() {
    let list = rows;
    if (keyword) {
      const k = keyword.toLowerCase();
      list = list.filter((r) => r.name.toLowerCase().includes(k) || r.sku.toLowerCase().includes(k));
    }
    if (onlyAnomaly) list = list.filter((r) => r.anomaly);

    if (!list.length) {
      tableBox.innerHTML = emptyState('没有匹配的商品', onlyAnomaly ? '当前没有价格异常的商品' : '试试其他关键词');
      return;
    }

    // 平台列顺序取自数据
    const platforms = list[0].platforms.map((p) => p.platformName);

    tableBox.innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th style="min-width:180px">商品</th>
            <th class="num">进货价</th>
            ${platforms.map((p) => `<th class="num">${esc(p)}</th>`).join('')}
            <th class="num">均售价</th>
            <th class="num">价差</th>
            <th class="num">均毛利率</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          ${list.map((r) => `
            <tr class="clickable" data-pid="${r.productId}">
              <td>
                <div class="pname">${esc(r.name.length > 18 ? r.name.slice(0, 18) + '…' : r.name)}</div>
                <div class="sku">${esc(r.sku)} · ${esc(r.supplierName || '')}</div>
              </td>
              <td class="num" style="color:var(--text-2)">${yuan(r.purchasePrice)}</td>
              ${r.platforms.map((p) => {
                const vs = p.vsCompetitor;
                const color = vs == null ? 'var(--text)' : vs > 12 ? '#E11D48' : vs < -8 ? '#047857' : 'var(--text)';
                return `<td class="num" style="color:${color}">
                  ${yuan(p.price)}
                  <div style="font-size:9.5px;color:var(--text-3);margin-top:1px">
                    ${vs == null ? '' : `${vs > 0 ? '高于' : '低于'}竞品 ${Math.abs(vs).toFixed(0)}%`}
                  </div>
                </td>`;
              }).join('')}
              <td class="num" style="font-weight:600">${yuan(r.avgPrice)}</td>
              <td class="num" style="color:${r.spread > 22 ? '#E11D48' : 'var(--text-2)'}">${pct(r.spread)}</td>
              <td class="num" style="color:#047857">${pct(r.avgGrossMargin)}</td>
              <td>${r.anomaly
                ? '<span class="badge badge-warning"><b></b>需关注</span>'
                : '<span class="badge badge-success"><b></b>正常</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  root.querySelector('#pq').addEventListener('input', debounce((e) => {
    keyword = e.target.value.trim();
    render();
  }, 220));

  root.querySelector('#only-anomaly').addEventListener('change', (e) => {
    onlyAnomaly = e.target.checked;
    render();
  });

  root.querySelector('#btn-crawl').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api.crawlPrices({ live: false });
      toast(`已采集 ${r.ok} 个商品在 4 个平台的最新售价`, 'success', '采集完成');
      await load();
    } catch (err) {
      toast(err.message, 'danger', '采集失败');
    } finally {
      btn.disabled = false;
    }
  });

  root.querySelector('#btn-live').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '抓取中…';
    try {
      const r = await api.crawlPrices({ live: true });
      toast(
        r.liveSources > 0
          ? `${r.liveSources} 个商品成功抓取真实页面价格，其余回落模拟源`
          : '外部商品页反爬拦截，已自动回落模拟数据源（系统仍可完整演示）',
        r.liveSources > 0 ? 'success' : 'info',
        '真实抓取结果'
      );
      await load();
    } catch (err) {
      toast(err.message, 'danger', '抓取失败');
    } finally {
      btn.disabled = false;
      btn.textContent = '真实抓取';
    }
  });

  tableBox.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-pid]');
    if (tr) openPriceDrawer(Number(tr.dataset.pid));
  });

  await load();
}

/** 价格详情抽屉：14 天价格走势 + 各平台毛利对比 */
async function openPriceDrawer(productId) {
  openDrawer('价格走势', '<div style="padding:20px;text-align:center;color:var(--text-3)">加载中…</div>');
  try {
    const [hist, cmp] = await Promise.all([api.priceHistory(productId), api.priceComparison(productId)]);
    const row = cmp.list[0];
    document.getElementById('drawer-title').textContent = row.name;

    document.getElementById('drawer-body').innerHTML = `
      <div class="info-grid" style="margin-bottom:14px">
        <div class="info-item"><dt>进货价</dt><dd>${yuan(row.purchasePrice)}</dd></div>
        <div class="info-item"><dt>平均售价</dt><dd>${yuan(row.avgPrice)}</dd></div>
        <div class="info-item"><dt>平均毛利率</dt><dd style="color:#047857">${pct(row.avgGrossMargin)}</dd></div>
        <div class="info-item"><dt>跨平台价差</dt><dd>${pct(row.spread)}</dd></div>
      </div>

      ${row.anomaly ? `<div class="sug-reason" style="border-left:2px solid var(--warning)">${esc(row.anomaly)}</div>` : ''}

      <div class="card" style="padding:13px 15px;margin-bottom:14px">
        <div class="card-title" style="margin-bottom:9px;font-size:12.5px">近 14 天各平台价格走势</div>
        <div id="price-chart" style="height:210px"></div>
      </div>

      <div class="card-title" style="margin-bottom:9px;font-size:12.5px">各平台毛利结构</div>
      ${row.platforms.map((p) => `
        <div class="plat-price" style="flex-direction:column;align-items:stretch;gap:6px">
          <div style="display:flex;justify-content:space-between">
            <span class="tag"><i class="plat-dot" style="background:${(hist.series.find((s) => s.name === p.platformName) || {}).color || '#3B82F6'}"></i>${esc(p.platformName)}</span>
            <span style="font-family:var(--mono)">${yuan(p.price)}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-3)">
            <span>毛利 ${yuan(p.grossProfit)} · 毛利率 <b style="color:#047857">${pct(p.grossMargin)}</b></span>
            <span>竞品 ${yuan(p.competitor)}</span>
          </div>
        </div>
      `).join('')}
    `;

    // 简化 x 轴：只显示时间部分
    const times = hist.times.map((t) => String(t).slice(11, 16));
    makeChart(document.getElementById('price-chart'), {
      ...chartBase,
      grid: { left: 4, right: 14, top: 30, bottom: 4, containLabel: true },
      legend: {
        top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 3, itemGap: 10,
        textStyle: { color: '#475569', fontSize: 10.5 },
      },
      tooltip: { ...chartBase.tooltip, trigger: 'axis', valueFormatter: (v) => (v == null ? '—' : `¥${v}`) },
      xAxis: {
        type: 'category', data: times, boundaryGap: false, ...axisStyle,
        axisLabel: { ...axisStyle.axisLabel, interval: Math.max(0, Math.floor(times.length / 6)) },
      },
      yAxis: {
        type: 'value', ...axisStyle, scale: true,
        axisLabel: { ...axisStyle.axisLabel, formatter: (v) => `¥${v}` },
      },
      series: [
        ...hist.series.map((s, i) => ({
          name: s.name,
          type: 'line',
          data: s.data,
          smooth: 0.3,
          symbol: 'none',
          lineStyle: { width: 1.8, color: s.color && s.color !== '#161823' ? s.color : CHART_COLORS[i % CHART_COLORS.length] },
          itemStyle: { color: s.color && s.color !== '#161823' ? s.color : CHART_COLORS[i % CHART_COLORS.length] },
        })),
        {
          name: '进货价',
          type: 'line',
          data: times.map(() => hist.cost),
          symbol: 'none',
          lineStyle: { width: 1.4, color: '#E11D48', type: 'dashed' },
          itemStyle: { color: '#E11D48' },
        },
      ],
    });
  } catch (err) {
    document.getElementById('drawer-body').innerHTML = `<div class="empty"><strong>加载失败</strong><span>${esc(err.message)}</span></div>`;
  }
}
