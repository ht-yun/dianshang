/**
 * 智能补货：算法建议的生成、人工核验与下单
 * 流程：算法给出建议 → 运营核验（通过/调整/驳回）→ 生成供应商采购单
 */
import { api } from '../api.js';
import {
  num, yuan, fixed, esc, urgencyBadge, toast, emptyState, skeleton, SUG_STATUS_MAP,
} from '../utils.js';
import { openModal, closeModal } from '../ui.js';
import { openExplain } from './explain.js';

const TABS = [
  { k: 'pending', t: '待审核' },
  { k: 'approved', t: '已通过' },
  { k: 'ordered', t: '已下单' },
  { k: 'rejected', t: '已驳回' },
  { k: 'all', t: '全部' },
];

export async function mountReplenish(root) {
  let status = 'pending';
  let urgency = 'all';
  let rows = [];
  let summary = {};
  const selected = new Set();

  root.innerHTML = `
    <div class="kpi-grid" id="sug-kpi">${skeleton(2)}</div>
    <div class="toolbar">
      <div class="tabs" id="tabs">
        ${TABS.map((t) => `<button class="tab ${t.k === 'pending' ? 'active' : ''}" data-k="${t.k}">${t.t}</button>`).join('')}
      </div>
      <select class="input" id="f-urgency" style="width:118px">
        <option value="all">全部紧急度</option>
        <option value="critical">紧急</option>
        <option value="high">偏高</option>
        <option value="normal">常规</option>
      </select>
      <div class="spacer"></div>
      <button class="btn btn-ghost btn-sm" id="btn-generate">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>
        重新计算
      </button>
      <button class="btn btn-ghost btn-sm" id="btn-batch" disabled>批量通过</button>
      <button class="btn btn-primary btn-sm" id="btn-purchase" disabled>生成采购单</button>
    </div>
    <div id="sug-list" class="sug-list">${skeleton(3)}</div>
  `;

  const listBox = root.querySelector('#sug-list');

  async function load() {
    const q = status === 'all' ? '?status=all' : `?status=${status}`;
    const data = await api.suggestions(q);
    rows = data.list;
    summary = data.summary;
    renderKpi();
    render();
  }

  function renderKpi() {
    root.querySelector('#sug-kpi').innerHTML = `
      <div class="kpi ${summary.pending > 0 ? 'warn' : 'ok'}">
        <div class="kpi-label">待审核建议</div>
        <div class="kpi-value">${summary.pending || 0}<small>条</small></div>
        <div class="kpi-foot">预估采购金额 ${yuan(summary.totalAmount || 0, 0)}</div>
      </div>
      <div class="kpi ok">
        <div class="kpi-label">已通过待下单</div>
        <div class="kpi-value">${summary.approved || 0}<small>条</small></div>
        <div class="kpi-foot">核验通过后可生成供应商采购单</div>
      </div>
      <div class="kpi purple">
        <div class="kpi-label">已生成采购单</div>
        <div class="kpi-value">${summary.ordered || 0}<small>条</small></div>
        <div class="kpi-foot">等待供应商备货发货</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">人工驳回</div>
        <div class="kpi-value">${summary.rejected || 0}<small>条</small></div>
        <div class="kpi-foot">算法建议经人工修正的比例</div>
      </div>
    `;
  }

  function render() {
    let list = rows;
    if (urgency !== 'all') list = list.filter((r) => r.urgency === urgency);
    selected.clear();

    if (!list.length) {
      listBox.innerHTML = emptyState(
        status === 'pending' ? '当前没有待审核的补货建议' : '没有符合条件的建议',
        status === 'pending' ? '所有商品库存处于健康水位，或点击「重新计算」按最新库存再算一次' : ''
      );
      updateButtons();
      return;
    }

    listBox.innerHTML = list.map((r) => {
      const canReview = r.status === 'pending';
      return `
        <div class="sug-card urgency-${r.urgency}" data-id="${r.id}">
          <div class="sug-head">
            <div class="sug-title">
              <strong>${esc(r.name)}</strong>
              <span>${esc(r.sku)} · ${esc(r.supplier_name || '未绑定供应商')} · 交期 ${r.lead_time_days} 天</span>
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
              ${urgencyBadge(r.urgency)}
              <span class="badge ${(SUG_STATUS_MAP[r.status] || {}).cls || 'badge-muted'}">${(SUG_STATUS_MAP[r.status] || {}).text || r.status}</span>
              ${canReview ? `<input type="checkbox" class="sug-check" data-id="${r.id}" style="width:15px;height:15px;cursor:pointer;accent-color:#3B82F6">` : ''}
            </div>
          </div>

          <dl class="sug-metrics">
            <div class="metric"><dt>可售库存</dt><dd>${num(r.available_stock)}<small>${esc(r.unit)}</small></dd></div>
            <div class="metric"><dt>在途</dt><dd>${r.in_transit || 0}</dd></div>
            <div class="metric"><dt>日均销量</dt><dd>${fixed(r.avg_daily_sales, 1)}</dd></div>
            <div class="metric"><dt>可售天数</dt><dd style="color:${r.stock_days < 3 ? '#E11D48' : 'inherit'}">${fixed(r.stock_days, 1)}<small>天</small></dd></div>
            <div class="metric"><dt>安全库存</dt><dd>${r.safety_stock}</dd></div>
            <div class="metric"><dt>再订货点</dt><dd>${r.reorder_point}</dd></div>
            <div class="metric hl"><dt>建议补货</dt><dd>${r.final_qty}<small>${esc(r.unit)}</small></dd></div>
            <div class="metric"><dt>预估金额</dt><dd>${yuan(r.estimate_amount, 0)}</dd></div>
            <div class="metric"><dt>置信度</dt><dd>${(r.confidence * 100).toFixed(0)}<small>%</small></dd></div>
          </dl>

          <div class="sug-reason">${esc(r.reason || '')}</div>

          <div class="sug-actions">
            ${canReview ? `
              <button class="btn btn-success btn-sm" data-act="approve" data-id="${r.id}">核验通过</button>
              <button class="btn btn-sm" data-act="adjust" data-id="${r.id}">调整数量</button>
              <button class="btn btn-danger btn-sm" data-act="reject" data-id="${r.id}">驳回</button>
            ` : `
              <span style="font-size:11.5px;color:var(--text-3)">
                ${r.reviewed_by ? `由 ${esc(r.reviewed_by)} 于 ${esc((r.reviewed_at || '').slice(5, 16))} 处理` : '已处理'}
                ${r.review_note ? ` · ${esc(r.review_note)}` : ''}
              </span>
            `}
            <button class="btn btn-ghost btn-sm" data-act="explain" data-pid="${r.product_id}" style="margin-left:auto">
              算法推演
            </button>
          </div>
        </div>
      `;
    }).join('');

    updateButtons();
  }

  function updateButtons() {
    const batchBtn = root.querySelector('#btn-batch');
    const purchaseBtn = root.querySelector('#btn-purchase');
    batchBtn.disabled = selected.size === 0;
    batchBtn.textContent = selected.size ? `批量通过（${selected.size}）` : '批量通过';
    const approvedCount = status === 'approved' || status === 'all'
      ? rows.filter((r) => r.status === 'approved').length
      : (summary.approved || 0);
    purchaseBtn.disabled = approvedCount === 0;
    purchaseBtn.textContent = approvedCount > 0 ? `生成采购单（${approvedCount}）` : '生成采购单';
  }

  /* ---------- 交互 ---------- */
  root.querySelector('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    status = btn.dataset.k;
    root.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
    listBox.innerHTML = skeleton(3);
    load();
  });

  root.querySelector('#f-urgency').addEventListener('change', (e) => {
    urgency = e.target.value;
    render();
  });

  root.querySelector('#btn-generate').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '计算中…';
    try {
      const r = await api.generateSuggestions();
      toast(`已基于最新库存重算 ${r.computedCount} 个商品，其中 ${r.needReplenish} 个需要补货`, 'success', '算法重算完成');
      await load();
    } catch (err) {
      toast(err.message, 'danger', '重算失败');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>重新计算`;
    }
  });

  listBox.addEventListener('change', (e) => {
    const cb = e.target.closest('.sug-check');
    if (!cb) return;
    const id = Number(cb.dataset.id);
    if (cb.checked) selected.add(id); else selected.delete(id);
    updateButtons();
  });

  listBox.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const act = btn.dataset.act;

    if (act === 'explain') { openExplain(Number(btn.dataset.pid)); return; }

    if (act === 'approve') {
      btn.disabled = true;
      try {
        await api.reviewSuggestion(id, { action: 'approve', reviewer: '运营' });
        toast('建议已通过核验，可在采购单页生成供应商订单', 'success');
        await load();
      } catch (err) {
        toast(err.message, 'danger');
        btn.disabled = false;
      }
    } else if (act === 'adjust') {
      openAdjustModal(rows.find((r) => r.id === id), async (qty, note) => {
        await api.reviewSuggestion(id, { action: 'adjust', qty, note, reviewer: '运营' });
        toast(`补货数量已调整为 ${qty} 件并通过`, 'success');
        await load();
      });
    } else if (act === 'reject') {
      openModal('驳回补货建议', `
        <p style="font-size:13px;color:var(--text-2);line-height:1.7;margin-bottom:12px">
          驳回后该建议将不再出现在待审核列表，算法下次重算时会根据最新库存重新判断。
        </p>
        <div class="field"><label>驳回原因</label>
          <input class="input" id="reject-note" placeholder="例如：该商品即将下架 / 已有其他渠道调拨" value="暂不需要补货">
        </div>
      `, `<button class="btn" id="m-cancel">取消</button><button class="btn btn-danger" id="m-ok">确认驳回</button>`);

      document.getElementById('m-cancel').onclick = closeModal;
      document.getElementById('m-ok').onclick = async () => {
        const note = document.getElementById('reject-note').value.trim() || '人工驳回';
        closeModal();
        try {
          await api.reviewSuggestion(id, { action: 'reject', note, reviewer: '运营' });
          toast('已驳回该补货建议', 'info');
          await load();
        } catch (err) {
          toast(err.message, 'danger');
        }
      };
    }
  });

  root.querySelector('#btn-batch').addEventListener('click', async () => {
    const ids = [...selected];
    if (!ids.length) return;
    try {
      const r = await api.batchApprove(ids);
      toast(`已批量通过 ${r.count} 条补货建议`, 'success');
      await load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  });

  root.querySelector('#btn-purchase').addEventListener('click', async () => {
    // 注意：不能从当前列表 rows 里筛选已通过项——用户可能停留在「待审核」标签页，
    // rows 中并不包含 approved 记录。这里单独查询，保证任何标签页下都能正确下单。
    let ids = [];
    try {
      const data = await api.suggestions('?status=approved');
      ids = data.list.map((x) => x.id);
    } catch (err) {
      toast(err.message, 'danger');
      return;
    }
    if (!ids.length) { toast('当前没有已通过核验的建议，请先核验通过', 'warn'); return; }
    try {
      const r = await api.createOrders(ids, '智能补货建议自动生成');
      toast(
        `已按供应商拆分为 ${r.count} 张采购单，合计 ${r.orders.reduce((s, o) => s + o.totalQty, 0)} 件`,
        'success', '采购单生成成功'
      );
      setTimeout(() => { location.hash = '#/orders'; }, 700);
    } catch (err) {
      toast(err.message, 'danger', '生成失败');
    }
  });

  await load();
  return () => { rows = []; selected.clear(); };
}

/** 调整数量弹窗 */
function openAdjustModal(row, onConfirm) {
  if (!row) return;
  const suggest = row.suggest_qty;
  const moq = row.moq || 1;
  openModal('调整补货数量', `
    <div style="font-size:12.5px;color:var(--text-2);line-height:1.7;margin-bottom:14px">
      <b style="color:var(--text)">${esc(row.name)}</b><br>
      算法建议 <b style="color:var(--cyan);font-family:var(--mono)">${suggest} ${esc(row.unit)}</b>
      · 最小起订量 ${moq} · 可售 ${fixed(row.stock_days, 1)} 天
    </div>
    <div class="field">
      <label>实际下单数量（${esc(row.unit)}）</label>
      <input class="input" id="adj-qty" type="number" min="1" step="${moq}" value="${suggest}"
        style="font-family:var(--mono);font-size:15px">
      <div class="hint">
        预估金额：<span id="adj-amount">${yuan(suggest * row.purchase_price, 0)}</span>
        · 原建议 ${suggest} 件
      </div>
    </div>
    <div class="field">
      <label>调整说明</label>
      <input class="input" id="adj-note" placeholder="例如：供应商要求整箱起订，上调至整箱倍数" value="按实际供货规格调整">
    </div>
  `, `<button class="btn" id="m-cancel">取消</button><button class="btn btn-primary" id="m-ok">确认调整并通过</button>`);

  const input = document.getElementById('adj-qty');
  const amount = document.getElementById('adj-amount');
  input.addEventListener('input', () => {
    const q = Number(input.value) || 0;
    amount.textContent = yuan(q * row.purchase_price, 0);
  });
  input.focus();
  input.select();

  document.getElementById('m-cancel').onclick = closeModal;
  document.getElementById('m-ok').onclick = async () => {
    const qty = Number(input.value);
    if (!Number.isFinite(qty) || qty <= 0) { toast('请输入有效的正整数数量', 'warn'); return; }
    const note = document.getElementById('adj-note').value.trim();
    closeModal();
    try {
      await onConfirm(Math.round(qty), note);
    } catch (err) {
      toast(err.message, 'danger');
    }
  };
}
