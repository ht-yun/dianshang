'use strict';
/**
 * 智能补货建议接口
 * 流程：算法生成 → 人工核验（通过/调整/驳回）→ 生成采购单
 */
const express = require('express');
const { all, get, run, getSettings, tx } = require('../db');
const { computeAll, syncSuggestions, round2 } = require('../services/replenish');
const { invalidateDashboard } = require('./dashboard');

const router = express.Router();

/** 建议列表 */
router.get('/suggestions', (req, res) => {
  const { status = 'pending', urgency, keyword } = req.query;
  const cond = [];
  const params = [];
  if (status && status !== 'all') { cond.push('r.status = ?'); params.push(status); }
  if (urgency && urgency !== 'all') { cond.push('r.urgency = ?'); params.push(urgency); }
  if (keyword) { cond.push('(p.name LIKE ? OR p.sku LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const list = all(
    `SELECT r.*, p.sku, p.name, p.category, p.unit, p.purchase_price, p.suggest_price, p.moq,
            s.name AS supplier_name, s.id AS supplier_id
     FROM replenish_suggestions r
     JOIN products p ON p.id = r.product_id
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     ${where}
     ORDER BY CASE r.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, r.id DESC`,
    ...params
  ).map((r) => ({
    ...r,
    estimate_amount: round2(r.final_qty * r.purchase_price),
    stock_days: r.avg_daily_sales > 0 ? round2(r.available_stock / r.avg_daily_sales) : 0,
    gross_margin: r.suggest_price > 0 ? round2(((r.suggest_price - r.purchase_price) / r.suggest_price) * 100) : 0,
  }));

  const summary = {
    pending: get("SELECT COUNT(*) c FROM replenish_suggestions WHERE status='pending'").c,
    approved: get("SELECT COUNT(*) c FROM replenish_suggestions WHERE status='approved'").c,
    ordered: get("SELECT COUNT(*) c FROM replenish_suggestions WHERE status='ordered'").c,
    rejected: get("SELECT COUNT(*) c FROM replenish_suggestions WHERE status='rejected'").c,
    totalAmount: round2(get(
      "SELECT COALESCE(SUM(r.final_qty * p.purchase_price),0) amt FROM replenish_suggestions r JOIN products p ON p.id=r.product_id WHERE r.status='pending'"
    ).amt),
  };

  res.json({ list, summary, total: list.length });
});

/** 触发算法重新生成 / 刷新建议 */
router.post('/generate', (req, res) => {
  const settings = getSettings();
  const result = syncSuggestions({ settings });
  // 同时输出全量计算结果，便于前端展示「暂无需补货」的商品
  const computed = computeAll(settings);
  invalidateDashboard();
  res.json({
    ok: true,
    ...result,
    needReplenish: computed.filter((r) => r.needReplenish).length,
    computedCount: computed.length,
    at: new Date().toLocaleString('zh-CN'),
  });
});

/** 算法透明度说明：把每个商品的计算过程完整吐出来 */
router.get('/explain/:productId', (req, res) => {
  const p = get('SELECT * FROM products WHERE id = ?', Number(req.params.productId));
  if (!p) return res.status(404).json({ error: '商品不存在' });
  const settings = getSettings();
  const r = computeAll(settings).find((x) => x.productId === p.id);
  if (!r) return res.status(404).json({ error: '商品未参与计算' });

  res.json({
    product: { id: p.id, sku: p.sku, name: p.name },
    inputs: {
      serviceLevel: r.serviceLevel,
      z: r.z,
      leadTime: r.leadTime,
      sigmaLeadTime: r.sigmaL,
      avgDaily: r.avgDaily,
      demandStd: r.demandStd,
      available: r.available,
      inTransit: r.inTransit,
      coverDays: r.coverDays,
      moq: p.moq,
      purchasePrice: p.purchase_price,
    },
    steps: [
      {
        step: 1,
        name: '需求预测',
        formula: 'Holt(α=0.35, β=0.12) 与 加权移动平均(7/14/30日) 加权融合',
        detail: `Holt 预测 ${r.forecast.holt} 件/日，WMA ${r.forecast.wma} 件/日（近7日均值 ${r.forecast.m7}），融合后日均需求 ${r.avgDaily} 件`,
        result: r.avgDaily,
      },
      {
        step: 2,
        name: '需求波动',
        formula: 'σ_d = 样本标准差(近 ' + r.forecast.sampleDays + ' 天日销量)',
        detail: `标准差 ${r.demandStd}，变异系数 ${r.cv}（越大说明波动越剧烈，安全库存越厚）`,
        result: r.demandStd,
      },
      {
        step: 3,
        name: '动态安全库存',
        formula: 'SS = z × √(L·σ_d² + d̄²·σ_L²)',
        detail: `${r.z} × √(${r.leadTime}×${r.demandStd}² + ${r.avgDaily}²×${r.sigmaL}²) = ${r.safetyStock} 件`,
        result: r.safetyStock,
      },
      {
        step: 4,
        name: '再订货点',
        formula: 'ROP = d̄·L + SS',
        detail: `${r.avgDaily}×${r.leadTime} + ${r.safetyStock} = ${r.reorderPoint} 件`,
        result: r.reorderPoint,
      },
      {
        step: 5,
        name: '目标库存水位',
        formula: 'Target = d̄·(L + 覆盖天数) + SS',
        detail: `${r.avgDaily}×(${r.leadTime}+${r.coverDays}) + ${r.safetyStock} = ${r.targetStock} 件`,
        result: r.targetStock,
      },
      {
        step: 6,
        name: '补货量',
        formula: 'Q = (Target − 可用库存 − 在途库存)，再按 MOQ 向上取整',
        detail: `(${r.targetStock} − ${r.available} − ${r.inTransit}) = ${r.targetStock - r.available - r.inTransit} → MOQ ${p.moq} 取整 → ${r.suggestQty} 件`,
        result: r.suggestQty,
      },
      {
        step: 7,
        name: '经济订货批量（参考）',
        formula: 'EOQ = √(2·D·S / H)',
        detail: `年需求 ${Math.round(r.avgDaily * 365)} 件，单次订货成本 200 元，年持有成本率 20% → ${r.eoq} 件`,
        result: r.eoq,
      },
    ],
    conclusion: {
      health: r.health,
      urgency: r.urgency,
      confidence: r.confidence,
      suggestQty: r.suggestQty,
      estimateAmount: r.estimateAmount,
      reason: r.reason,
    },
  });
});

/** 审核建议：approve 通过 / adjust 调整数量后通过 / reject 驳回 */
router.patch('/suggestions/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = get('SELECT * FROM replenish_suggestions WHERE id = ?', id);
  if (!row) return res.status(404).json({ error: '建议不存在' });
  if (row.status !== 'pending') return res.status(400).json({ error: `该建议已处理（当前状态：${row.status}）` });

  const { action, qty, note, reviewer = '运营' } = req.body;

  if (action === 'reject') {
    run(
      "UPDATE replenish_suggestions SET status='rejected', reviewed_by=?, reviewed_at=datetime('now','localtime'), review_note=? WHERE id=?",
      reviewer, note || '人工驳回', id
    );
  } else if (action === 'adjust') {
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ error: '调整数量必须为正整数' });
    if (q > 100000) return res.status(400).json({ error: '调整数量过大' });
    run(
      "UPDATE replenish_suggestions SET status='approved', final_qty=?, reviewed_by=?, reviewed_at=datetime('now','localtime'), review_note=? WHERE id=?",
      Math.round(q), reviewer, note || `人工调整为 ${Math.round(q)} 件`, id
    );
  } else {
    run(
      "UPDATE replenish_suggestions SET status='approved', reviewed_by=?, reviewed_at=datetime('now','localtime'), review_note=? WHERE id=?",
      reviewer, note || '人工核验通过', id
    );
  }

  invalidateDashboard();
  res.json({ ok: true, suggestion: get('SELECT * FROM replenish_suggestions WHERE id = ?', id) });
});

/** 批量通过 */
router.post('/batch-approve', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (!ids.length) return res.status(400).json({ error: '请选择至少一条建议' });

  let count = 0;
  tx(() => {
    for (const id of ids) {
      const row = get("SELECT * FROM replenish_suggestions WHERE id = ? AND status = 'pending'", id);
      if (!row) continue;
      run(
        "UPDATE replenish_suggestions SET status='approved', reviewed_by='运营', reviewed_at=datetime('now','localtime'), review_note='批量核验通过' WHERE id=?",
        id
      );
      count += 1;
    }
  });
  invalidateDashboard();
  res.json({ ok: true, count });
});

module.exports = router;
