/**
 * 预警中心：库存水位、价格异常、滞销积压的实时告警
 */
import { api } from '../api.js';
import { esc, toast, emptyState, skeleton } from '../utils.js';
import { onRealtime } from '../bus.js';

const LEVEL = {
  critical: { text: '紧急', cls: 'badge-critical', color: '#E11D48' },
  warning: { text: '警告', cls: 'badge-warning', color: '#D97706' },
  info: { text: '提示', cls: 'badge-info', color: '#2F9E62' },
};

const TYPE_TEXT = {
  out_of_stock: '断货',
  stock_low: '低库存',
  below_rop: '达补货线',
  overstock: '库存积压',
  slow_moving: '滞销',
  price_anomaly: '价格异常',
};

export async function mountAlerts(root) {
  let level = 'all';
  let rows = [];
  let stats = {};

  root.innerHTML = `
    <div class="kpi-grid" id="al-kpi">${skeleton(2)}</div>
    <div class="toolbar">
      <div class="tabs" id="tabs">
        <button class="tab active" data-k="all">全部</button>
        <button class="tab" data-k="critical">紧急</button>
        <button class="tab" data-k="warning">警告</button>
        <button class="tab" data-k="info">提示</button>
      </div>
      <div class="spacer"></div>
      <button class="btn btn-ghost btn-sm" id="btn-scan">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 11-3.5-7.1"/><path d="M21 3v6h-6"/></svg>
        重新扫描
      </button>
      <button class="btn btn-ghost btn-sm" id="btn-close-all">全部关闭</button>
    </div>
    <div class="card" style="padding:0">
      <div class="table-wrap" id="al-table">${skeleton(3)}</div>
    </div>
  `;

  const tableBox = root.querySelector('#al-table');

  async function load() {
    const data = await api.alerts(`?level=${level}&status=open&limit=120`);
    rows = data.list;
    stats = data.stats;
    renderKpi();
    render();
  }

  function renderKpi() {
    root.querySelector('#al-kpi').innerHTML = `
      <div class="kpi ${stats.critical > 0 ? 'danger' : 'ok'}">
        <div class="kpi-label">紧急预警</div>
        <div class="kpi-value">${stats.critical || 0}<small>条</small></div>
        <div class="kpi-foot">断货或低于安全库存，需立即处理</div>
      </div>
      <div class="kpi ${stats.warning > 0 ? 'warn' : 'ok'}">
        <div class="kpi-label">警告</div>
        <div class="kpi-value">${stats.warning || 0}<small>条</small></div>
        <div class="kpi-foot">跌破补货线或价格异常</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">提示</div>
        <div class="kpi-value">${stats.info || 0}<small>条</small></div>
        <div class="kpi-foot">库存积压与滞销提醒</div>
      </div>
      <div class="kpi purple">
        <div class="kpi-label">未处理合计</div>
        <div class="kpi-value">${stats.total || 0}<small>条</small></div>
        <div class="kpi-foot">每 25 秒随库存变化自动复算</div>
      </div>
    `;
  }

  function render() {
    if (!rows.length) {
      tableBox.innerHTML = emptyState('很好，暂无未处理预警', '所有商品库存水位正常');
      return;
    }

    tableBox.innerHTML = `
      <table class="data">
        <thead>
          <tr><th>等级</th><th>类型</th><th style="min-width:150px">预警内容</th><th style="min-width:200px">详情</th><th>时间</th><th>操作</th></tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const lv = LEVEL[r.level] || LEVEL.info;
            return `
              <tr data-id="${r.id}">
                <td><span class="badge ${lv.cls}"><b></b>${lv.text}</span></td>
                <td><span class="badge badge-muted">${TYPE_TEXT[r.type] || r.type}</span></td>
                <td>
                  <div class="pname" style="font-size:12.5px">${esc(r.title)}</div>
                  <div class="sku">${esc(r.sku || '')}</div>
                </td>
                <td style="font-size:11.5px;color:var(--text-2);line-height:1.55">${esc(r.message || '')}</td>
                <td style="font-size:11px;color:var(--text-3);font-family:var(--mono)">${esc((r.created_at || '').slice(5, 16))}</td>
                <td><button class="btn btn-ghost btn-sm" data-close="${r.id}">关闭</button></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  root.querySelector('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    level = btn.dataset.k;
    root.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
    tableBox.innerHTML = skeleton(3);
    load();
  });

  root.querySelector('#btn-scan').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api.scanAlerts();
      toast(`扫描完成，新增 ${r.created} 条预警，当前未处理 ${r.stats.total} 条`, 'success');
      await load();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      btn.disabled = false;
    }
  });

  root.querySelector('#btn-close-all').addEventListener('click', async () => {
    try {
      await api.closeAllAlerts();
      toast('已关闭全部预警', 'info');
      await load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  });

  tableBox.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-close]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await api.closeAlert(Number(btn.dataset.close));
      await load();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });

  // 实时刷新：库存复算后若有新预警则自动刷新
  const off = onRealtime((type, d) => {
    if (type === 'recomputed' && d.alerts > 0) load();
  });

  await load();
  return () => off();
}
