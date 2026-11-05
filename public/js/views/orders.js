/**
 * 供应商订单：采购单列表、明细、状态流转与入库
 * 状态机：待确认 → 已确认 → 已发货 → 已入库（未入库前可取消）
 */
import { api } from '../api.js';
import {
  num, yuan, esc, toast, emptyState, skeleton, orderStatusBadge, ORDER_STATUS_MAP,
} from '../utils.js';
import { openDrawer, openModal, closeModal } from '../ui.js';

const TABS = [
  { k: 'all', t: '全部' },
  { k: 'pending', t: '待确认' },
  { k: 'confirmed', t: '已确认' },
  { k: 'shipped', t: '已发货' },
  { k: 'received', t: '已入库' },
  { k: 'cancelled', t: '已取消' },
];

/** 下一步可执行的动作 */
const NEXT_ACTIONS = {
  pending: [{ s: 'confirmed', t: '确认订单', cls: 'btn-primary' }, { s: 'cancelled', t: '取消', cls: 'btn-danger' }],
  confirmed: [{ s: 'shipped', t: '标记发货', cls: 'btn-primary' }, { s: 'cancelled', t: '取消', cls: 'btn-danger' }],
  shipped: [{ s: 'received', t: '确认入库', cls: 'btn-success' }],
  received: [],
  cancelled: [],
};

export async function mountOrders(root) {
  let status = 'all';
  let rows = [];
  let summary = {};

  root.innerHTML = `
    <div class="kpi-grid" id="ord-kpi">${skeleton(2)}</div>
    <div class="toolbar">
      <div class="tabs" id="tabs">
        ${TABS.map((t) => `<button class="tab ${t.k === 'all' ? 'active' : ''}" data-k="${t.k}">${t.t}</button>`).join('')}
      </div>
      <div class="spacer"></div>
      <button class="btn btn-ghost btn-sm" id="btn-refresh">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 11-3.5-7.1"/><path d="M21 3v6h-6"/></svg>
        刷新
      </button>
    </div>
    <div class="card" style="padding:0">
      <div class="table-wrap" id="ord-table">${skeleton(3)}</div>
    </div>
  `;

  const tableBox = root.querySelector('#ord-table');

  async function load() {
    const data = await api.orders(status === 'all' ? '' : `?status=${status}`);
    rows = data.list;
    summary = data.summary;
    renderKpi();
    render();
  }

  function renderKpi() {
    root.querySelector('#ord-kpi').innerHTML = `
      <div class="kpi">
        <div class="kpi-label">采购单总数</div>
        <div class="kpi-value">${summary.total || 0}<small>张</small></div>
        <div class="kpi-foot">累计采购金额 ${yuan(summary.amount || 0, 0)}</div>
      </div>
      <div class="kpi ${summary.pending > 0 ? 'warn' : 'ok'}">
        <div class="kpi-label">待供应商确认</div>
        <div class="kpi-value">${summary.pending || 0}<small>张</small></div>
        <div class="kpi-foot">需尽快与供应商核对交期</div>
      </div>
      <div class="kpi purple">
        <div class="kpi-label">在途订单</div>
        <div class="kpi-value">${summary.shipping || 0}<small>张</small></div>
        <div class="kpi-foot">已确认/已发货，等待入库</div>
      </div>
      <div class="kpi ok">
        <div class="kpi-label">入库回写</div>
        <div class="kpi-value">自动<small>分仓</small></div>
        <div class="kpi-foot">按各渠道近期销量占比回写库存</div>
      </div>
    `;
  }

  function render() {
    if (!rows.length) {
      tableBox.innerHTML = emptyState('暂无采购单', '在「智能补货」页审核通过建议后即可生成采购单');
      return;
    }

    tableBox.innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th>采购单号</th><th>供应商</th><th class="num">品项</th><th class="num">数量</th>
            <th class="num">金额</th><th>期望到货</th><th>状态</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((o) => `
            <tr class="clickable" data-id="${o.id}">
              <td>
                <div class="pname" style="font-family:var(--mono);font-size:12px">${esc(o.order_no)}</div>
                <div class="pmeta">${esc((o.created_at || '').slice(0, 16))}</div>
              </td>
              <td>
                <div>${esc(o.supplier_name)}</div>
                <div class="pmeta">${esc(o.contact || '')} · ${esc(o.payment_terms || '')}</div>
              </td>
              <td class="num">${o.item_count}</td>
              <td class="num">${num(o.total_qty)}</td>
              <td class="num" style="font-weight:600">${yuan(o.total_amount, 0)}</td>
              <td style="font-size:12px;color:var(--text-2)">${esc(o.expected_date || '—')}</td>
              <td>${orderStatusBadge(o.status)}</td>
              <td>
                <button class="btn btn-ghost btn-sm" data-act="detail" data-id="${o.id}">明细</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  root.querySelector('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    status = btn.dataset.k;
    root.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
    tableBox.innerHTML = skeleton(3);
    load();
  });

  root.querySelector('#btn-refresh').addEventListener('click', load);

  tableBox.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    openOrderDrawer(Number(tr.dataset.id), load);
  });

  await load();
}

/** 采购单详情抽屉 */
async function openOrderDrawer(orderId, refresh) {
  openDrawer('采购单详情', '<div style="padding:20px;text-align:center;color:var(--text-3)">加载中…</div>');
  try {
    const d = await api.order(orderId);
    const o = d.order;
    document.getElementById('drawer-title').textContent = o.order_no;

    const actions = NEXT_ACTIONS[o.status] || [];

    document.getElementById('drawer-body').innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
        ${orderStatusBadge(o.status)}
        <span class="badge badge-muted">${esc(o.created_by || '系统')} 创建</span>
        <span class="badge badge-info">${esc(o.payment_terms || '')}</span>
      </div>

      <div class="info-grid">
        <div class="info-item"><dt>供应商</dt><dd>${esc(o.supplier_name)}</dd></div>
        <div class="info-item"><dt>联系人</dt><dd>${esc(o.contact || '—')} ${esc(o.phone || '')}</dd></div>
        <div class="info-item"><dt>下单时间</dt><dd>${esc(o.created_at)}</dd></div>
        <div class="info-item"><dt>期望到货</dt><dd>${esc(o.expected_date || '—')}</dd></div>
        <div class="info-item"><dt>合计数量</dt><dd>${num(o.total_qty)} 件</dd></div>
        <div class="info-item"><dt>合计金额</dt><dd style="color:#047857">${yuan(o.total_amount)}</dd></div>
      </div>

      ${o.remark ? `<div class="sug-reason">${esc(o.remark)}</div>` : ''}

      <div class="card-title" style="margin:14px 0 9px;font-size:12.5px">采购明细</div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>商品</th><th class="num">数量</th><th class="num">单价</th><th class="num">小计</th></tr></thead>
          <tbody>
            ${d.items.map((i) => `
              <tr>
                <td>
                  <div class="pname" style="font-size:12px">${esc(i.name)}</div>
                  <div class="sku">${esc(i.sku)}</div>
                </td>
                <td class="num">${num(i.qty)} <small style="color:var(--text-3)">${esc(i.unit)}</small></td>
                <td class="num">${yuan(i.unit_price)}</td>
                <td class="num" style="font-weight:600">${yuan(i.amount)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="card-title" style="margin:16px 0 9px;font-size:12.5px">状态流转</div>
      <div style="display:flex;align-items:center;gap:6px;font-size:11px;flex-wrap:wrap">
        ${['pending', 'confirmed', 'shipped', 'received'].map((s, i) => {
          const order = ['pending', 'confirmed', 'shipped', 'received'];
          const cur = order.indexOf(o.status);
          const done = cur >= i && o.status !== 'cancelled';
          const active = o.status === s;
          return `
            <span style="padding:4px 10px;border-radius:20px;
              background:${active ? 'rgba(59,130,246,.22)' : done ? 'rgba(16,185,129,.12)' : 'var(--surface-2)'};
              color:${active ? '#93C5FD' : done ? '#047857' : 'var(--text-3)'};
              border:1px solid ${active ? 'rgba(59,130,246,.4)' : done ? 'rgba(16,185,129,.25)' : 'var(--border)'}">
              ${ORDER_STATUS_MAP[s].text}
            </span>
            ${i < 3 ? '<span style="color:var(--text-3)">→</span>' : ''}
          `;
        }).join('')}
      </div>

      <div style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap">
        ${actions.map((a) => `<button class="btn ${a.cls}" data-next="${a.s}">${a.t}</button>`).join('')}
        <button class="btn btn-ghost" id="btn-export" style="margin-left:auto">导出对账单</button>
      </div>
    `;

    // 状态操作
    document.getElementById('drawer-body').querySelectorAll('[data-next]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const next = btn.dataset.next;
        if (next === 'cancelled') {
          openModal('取消采购单', `<p style="font-size:13px;color:var(--text-2);line-height:1.7">确认取消采购单 <b style="font-family:var(--mono)">${esc(o.order_no)}</b>？取消后不可恢复。</p>`,
            '<button class="btn" id="m-cancel">返回</button><button class="btn btn-danger" id="m-ok">确认取消</button>');
          document.getElementById('m-cancel').onclick = closeModal;
          document.getElementById('m-ok').onclick = async () => {
            closeModal();
            await doStatusChange(orderId, 'cancelled', refresh);
          };
          return;
        }
        if (next === 'received') {
          openModal('确认入库', `
            <p style="font-size:13px;color:var(--text-2);line-height:1.7">
              确认该采购单已到货入库？<br>
              系统将把 <b>${num(o.total_qty)} 件</b> 商品按各渠道近 14 天销量占比回写到平台库存，
              并记录库存流水。
            </p>`,
            '<button class="btn" id="m-cancel">取消</button><button class="btn btn-success" id="m-ok">确认入库</button>');
          document.getElementById('m-cancel').onclick = closeModal;
          document.getElementById('m-ok').onclick = async () => {
            closeModal();
            await doStatusChange(orderId, 'received', refresh);
          };
          return;
        }
        await doStatusChange(orderId, next, refresh);
      });
    });

    // 导出
    document.getElementById('btn-export').addEventListener('click', async () => {
      try {
        const r = await api.exportOrder(orderId);
        openModal('对账单文本', `
          <pre style="font-family:var(--mono);font-size:11.5px;line-height:1.65;color:var(--text-2);
            background:var(--surface-2);padding:14px;border-radius:9px;overflow-x:auto;white-space:pre">${esc(r.text)}</pre>
        `, `<button class="btn btn-primary" id="m-ok">复制并关闭</button>`);
        document.getElementById('m-ok').onclick = async () => {
          try {
            await navigator.clipboard.writeText(r.text);
            toast('对账单已复制到剪贴板', 'success');
          } catch (_) {
            toast('复制失败，请手动选择文本', 'warn');
          }
          closeModal();
        };
      } catch (err) {
        toast(err.message, 'danger');
      }
    });
  } catch (err) {
    document.getElementById('drawer-body').innerHTML = `<div class="empty"><strong>加载失败</strong><span>${esc(err.message)}</span></div>`;
  }
}

async function doStatusChange(orderId, next, refresh) {
  try {
    const r = await api.updateOrderStatus(orderId, next);
    toast(r.message || `状态已更新为${r.statusText}`, 'success');
    await openOrderDrawer(orderId, refresh);
    if (typeof refresh === 'function') await refresh();
  } catch (err) {
    toast(err.message, 'danger', '操作失败');
  }
}
