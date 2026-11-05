/**
 * 商品库存：全渠道库存明细、健康度、可售天数与销售趋势
 */
import { api } from '../api.js';
import {
  num, fixed, esc, healthBadge, stockBar, pct, debounce, toast, emptyState, yuan,
} from '../utils.js';
import { openProductDrawer } from '../product-detail.js';
import { openExplain } from './explain.js';

const HEALTH_OPTIONS = [
  { k: 'all', t: '全部状态' },
  { k: 'out_of_stock', t: '已断货' },
  { k: 'critical', t: '低于安全库存' },
  { k: 'warning', t: '达到补货线' },
  { k: 'healthy', t: '库存健康' },
  { k: 'overstock', t: '库存积压' },
];

export async function mountInventory(root) {
  let state = { category: 'all', health: 'all', keyword: '', sort: 'days' };
  let cache = [];

  root.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input class="input" id="q" placeholder="搜索商品名称或 SKU…" autocomplete="off">
      </div>
      <select class="input" id="f-cat" style="width:132px"></select>
      <select class="input" id="f-health" style="width:140px">
        ${HEALTH_OPTIONS.map((o) => `<option value="${o.k}">${o.t}</option>`).join('')}
      </select>
      <div class="spacer"></div>
      <span id="stat-chip" style="font-size:12px;color:var(--text-3)"></span>
      <button class="btn btn-ghost btn-sm" id="btn-refresh">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 11-3.5-7.1"/><path d="M21 3v6h-6"/></svg>
        刷新
      </button>
    </div>
    <div class="card" style="padding:0">
      <div class="table-wrap" id="table-box"></div>
    </div>
  `;

  const catSel = root.querySelector('#f-cat');
  const tableBox = root.querySelector('#table-box');

  async function load() {
    const data = await api.products();
    cache = data.list;
    catSel.innerHTML = `<option value="all">全部类目</option>${data.categories
      .map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}`;
    render();
  }

  function filtered() {
    let rows = cache;
    if (state.category !== 'all') rows = rows.filter((r) => r.category === state.category);
    if (state.health !== 'all') rows = rows.filter((r) => r.health === state.health);
    if (state.keyword) {
      const k = state.keyword.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(k) || r.sku.toLowerCase().includes(k));
    }
    const sorters = {
      days: (a, b) => a.stockDays - b.stockDays,
      stock: (a, b) => b.available - a.available,
      sales: (a, b) => b.avgDaily - a.avgDaily,
      qty: (a, b) => b.suggestQty - a.suggestQty,
    };
    return [...rows].sort(sorters[state.sort] || sorters.days);
  }

  function render() {
    const rows = filtered();
    const urgent = rows.filter((r) => r.health === 'critical' || r.health === 'out_of_stock').length;
    root.querySelector('#stat-chip').innerHTML =
      `共 <b style="color:var(--text)">${rows.length}</b> 个 SKU · 需关注 <b style="color:#E11D48">${urgent}</b> 个`;

    if (!rows.length) {
      tableBox.innerHTML = emptyState('没有匹配的商品', '试试调整筛选条件或搜索关键词');
      return;
    }

    tableBox.innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th style="min-width:190px">商品</th>
            <th>类目</th>
            <th class="num" style="cursor:pointer" data-sort="stock">总库存 <span style="opacity:.45;font-size:9px">↕</span></th>
            <th class="num">可售</th>
            <th class="num">在途</th>
            <th class="num" style="cursor:pointer" data-sort="sales">日均 <span style="opacity:.45;font-size:9px">↕</span></th>
            <th style="min-width:104px">可售天数</th>
            <th>健康度</th>
            <th class="num" style="cursor:pointer" data-sort="qty">建议量 <span style="opacity:.45;font-size:9px">↕</span></th>
            <th class="num">毛利率</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr class="clickable" data-pid="${r.id}">
              <td>
                <div class="pname">${esc(r.name)}</div>
                <div class="sku">${esc(r.sku)} · ${esc(r.supplierName || '未绑定供应商')}</div>
              </td>
              <td><span class="badge badge-muted">${esc(r.category)}</span></td>
              <td class="num">${num(r.totalStock)}</td>
              <td class="num" style="color:${r.available === 0 ? '#E11D48' : 'var(--text)'}">${num(r.available)}</td>
              <td class="num" style="color:${r.inTransit > 0 ? '#7DD3FC' : 'var(--text-3)'}">${r.inTransit || '—'}</td>
              <td class="num">${fixed(r.avgDaily, 1)}</td>
              <td>
                <div style="display:flex;align-items:center;gap:7px">
                  <span style="font-family:var(--mono);font-size:12px;min-width:38px;color:${
                    r.stockDays < 7 ? '#E11D48' : r.stockDays < 30 ? '#B45309' : 'var(--text-2)'
                  }">${fixed(r.stockDays, 1)}天</span>
                  ${stockBar(r.stockDays)}
                </div>
              </td>
              <td>${healthBadge(r.health)}</td>
              <td class="num" style="color:${r.suggestQty > 0 ? 'var(--cyan)' : 'var(--text-3)'};font-weight:${r.suggestQty > 0 ? 600 : 400}">${r.suggestQty || '—'}</td>
              <td class="num">${pct(r.grossMargin)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  /* ---------- 事件绑定 ---------- */
  root.querySelector('#q').addEventListener('input', debounce((e) => {
    state.keyword = e.target.value.trim();
    render();
  }, 220));

  catSel.addEventListener('change', (e) => { state.category = e.target.value; render(); });
  root.querySelector('#f-health').addEventListener('change', (e) => { state.health = e.target.value; render(); });
  root.querySelector('#btn-refresh').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    await load();
    e.currentTarget.disabled = false;
    toast('库存数据已刷新', 'success');
  });

  tableBox.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) { state.sort = th.dataset.sort; render(); return; }
    const tr = e.target.closest('tr[data-pid]');
    if (tr) openProductDrawer(Number(tr.dataset.pid));
  });

  await load();
  return () => { cache = []; };
}
