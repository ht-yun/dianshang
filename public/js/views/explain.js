/**
 * 算法推演弹窗：把某商品从「需求预测」到「补货量」的完整推导过程逐步展示
 * 用于答辩演示与运营复核，让黑盒算法变成可追溯的白盒
 */
import { api } from '../api.js';
import { openModal, closeModal } from '../ui.js';
import { esc, num, yuan } from '../utils.js';

export async function openExplain(productId) {
  openModal('算法推演过程', '<div style="padding:30px;text-align:center;color:var(--text-3)">计算中…</div>');
  try {
    const d = await api.explain(productId);
    const inp = d.inputs;
    const con = d.conclusion;

    document.getElementById('modal-title').textContent = `算法推演 · ${d.product.sku}`;

    document.getElementById('modal-body').innerHTML = `
      <div style="font-size:13px;font-weight:600;margin-bottom:4px">${esc(d.product.name)}</div>
      <div style="font-size:11.5px;color:var(--text-3);margin-bottom:16px">
        输入参数：服务水平 ${(inp.serviceLevel * 100).toFixed(0)}%（z=${inp.z}）· 交期 ${inp.leadTime} 天（σ=${inp.sigmaLeadTime}）
        · 日均需求 ${inp.avgDaily} · 需求波动 ${inp.demandStd} · 可售 ${num(inp.available)} · 在途 ${num(inp.inTransit)}
        · 覆盖 ${inp.coverDays} 天 · MOQ ${inp.moq}
      </div>

      <div class="steps">
        ${d.steps.map((s) => `
          <div class="step">
            <div class="step-no">${s.step}</div>
            <div class="step-body">
              <h4>${esc(s.name)}<span class="step-result">＝ ${s.result}</span></h4>
              <div class="step-formula">${esc(s.formula)}</div>
              <div class="step-detail">${esc(s.detail)}</div>
            </div>
          </div>
        `).join('')}
      </div>

      <div style="margin-top:16px;padding:13px 15px;border-radius:10px;background:rgba(34,211,238,.07);border:1px solid rgba(34,211,238,.2)">
        <div style="font-size:12px;color:var(--text-2);line-height:1.75">${esc(con.reason)}</div>
        <div style="display:flex;gap:18px;margin-top:10px;font-size:12px;flex-wrap:wrap">
          <span>建议补货：<b style="color:var(--cyan);font-family:var(--mono)">${con.suggestQty} 件</b></span>
          <span>预估金额：<b style="font-family:var(--mono)">${yuan(con.estimateAmount)}</b></span>
          <span>预测置信度：<b style="font-family:var(--mono)">${(con.confidence * 100).toFixed(0)}%</b></span>
        </div>
      </div>
    `;

    document.getElementById('modal-foot').innerHTML = '<button class="btn btn-primary" id="explain-ok">明白了</button>';
    document.getElementById('explain-ok').addEventListener('click', closeModal);
  } catch (err) {
    document.getElementById('modal-body').innerHTML = `<div class="empty"><strong>推演失败</strong><span>${esc(err.message)}</span></div>`;
  }
}
