/**
 * 商品详情抽屉（看板、库存、价格页共用）
 */
import { api } from './api.js';
import { openDrawer } from './ui.js';
import { num, yuan, fixed, esc, healthBadge, urgencyBadge, makeChart, chartBase, axisStyle } from './utils.js';

export async function openProductDrawer(productId) {
  openDrawer('商品详情', '<div style="padding:20px 0;text-align:center;color:var(--text-3)">加载中…</div>');
  try {
    const d = await api.product(productId);
    const p = d.product;
    const c = d.calc;
    document.getElementById('drawer-title').textContent = p.name;

    document.getElementById('drawer-body').innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
        ${healthBadge(c.health)} ${urgencyBadge(c.urgency)}
        <span class="badge badge-info">${esc(p.category)}</span>
        <span class="badge badge-muted">${esc(p.sku)}</span>
      </div>
      <div class="info-grid">
        <div class="info-item"><dt>可售库存</dt><dd>${num(c.available)} ${esc(p.unit)}</dd></div>
        <div class="info-item"><dt>在途库存</dt><dd>${num(c.inTransit)} ${esc(p.unit)}</dd></div>
        <div class="info-item"><dt>日均销量</dt><dd>${fixed(c.avgDaily, 1)} ${esc(p.unit)}</dd></div>
        <div class="info-item"><dt>可售天数</dt><dd>${fixed(c.stockDays, 1)} 天</dd></div>
        <div class="info-item"><dt>安全库存</dt><dd>${c.safetyStock}</dd></div>
        <div class="info-item"><dt>再订货点</dt><dd>${c.reorderPoint}</dd></div>
        <div class="info-item"><dt>建议补货</dt><dd style="color:var(--cyan)">${c.suggestQty} ${esc(p.unit)}</dd></div>
        <div class="info-item"><dt>进货价 / 售价</dt><dd>${yuan(p.purchasePrice)} / ${yuan(p.suggestPrice)}</dd></div>
        <div class="info-item"><dt>供应商</dt><dd>${esc(p.supplierName || '—')}</dd></div>
        <div class="info-item"><dt>交期 / MOQ</dt><dd>${p.leadTimeDays} 天 / ${p.moq}</dd></div>
        <div class="info-item"><dt>毛利率</dt><dd>${p.suggestPrice > 0 ? (((p.suggestPrice - p.purchasePrice) / p.suggestPrice) * 100).toFixed(1) : 0}%</dd></div>
        <div class="info-item"><dt>预测置信度</dt><dd>${(c.confidence * 100).toFixed(0)}%</dd></div>
      </div>

      <div class="card" style="padding:13px 15px;margin-bottom:14px">
        <div class="card-title" style="margin-bottom:9px;font-size:12.5px">近 30 天销量走势</div>
        <div id="drawer-chart" style="height:180px"></div>
      </div>

      <div class="card-title" style="margin-bottom:9px;font-size:12.5px">各平台库存分布</div>
      ${d.platforms.map((x) => `
        <div class="plat-price">
          <span class="tag"><i class="plat-dot" style="background:${x.color}"></i>${esc(x.name)}</span>
          <span style="font-family:var(--mono)">${num(x.stock)} 件 · ${yuan(x.price)}</span>
        </div>
      `).join('')}

      <div class="card-title" style="margin:16px 0 9px;font-size:12.5px">算法判断依据</div>
      <div class="sug-reason">${esc(c.reason)}</div>

      <div class="card-title" style="margin:16px 0 9px;font-size:12.5px">库存流水（最近 8 条）</div>
      <div class="table-wrap">
        <table class="data">
          <tbody>
            ${(d.movements || []).slice(0, 8).map((m) => `
              <tr>
                <td style="font-family:var(--mono);font-size:11px;color:var(--text-3)">${esc(m.created_at)}</td>
                <td>${esc(m.note || m.type)}</td>
                <td class="num" style="color:${m.qty > 0 ? '#047857' : '#E11D48'}">${m.qty > 0 ? '+' : ''}${m.qty}</td>
              </tr>
            `).join('') || '<tr><td colspan="3" style="text-align:center;color:var(--text-3);padding:18px">暂无流水</td></tr>'}
          </tbody>
        </table>
      </div>

      <div style="display:flex;gap:8px;margin-top:16px">
        <a class="btn btn-primary" href="#/replenish" style="text-decoration:none">查看补货建议</a>
        <a class="btn" href="#/pricing" style="text-decoration:none">比价详情</a>
        <button class="btn" data-explain="${p.id}">查看算法推演</button>
      </div>
    `;

    const n = 30;
    const dates = d.series.dates.slice(-n).map((x) => x.slice(5));
    const values = d.series.values.slice(-n);
    makeChart(document.getElementById('drawer-chart'), {
      ...chartBase,
      grid: { left: 4, right: 10, top: 18, bottom: 4, containLabel: true },
      tooltip: { ...chartBase.tooltip, trigger: 'axis' },
      xAxis: { type: 'category', data: dates, boundaryGap: false, ...axisStyle, axisLabel: { ...axisStyle.axisLabel, interval: 6 } },
      yAxis: { type: 'value', ...axisStyle },
      series: [{
        type: 'line', data: values, smooth: 0.3, symbol: 'none',
        lineStyle: { width: 2, color: '#2F9E62' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(47,158,98,.28)' },
              { offset: 1, color: 'rgba(47,158,98,0)' },
            ],
          },
        },
      }],
    });

    // 算法推演按钮（动态引入，避免循环依赖）
    document.getElementById('drawer-body').querySelector('[data-explain]')?.addEventListener('click', async (e) => {
      const { openExplain } = await import('./views/explain.js');
      openExplain(Number(e.currentTarget.dataset.explain));
    });
  } catch (err) {
    document.getElementById('drawer-body').innerHTML = `<div class="empty"><strong>加载失败</strong><span>${esc(err.message)}</span></div>`;
  }
}
