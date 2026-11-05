'use strict';
/**
 * 智能补货算法模块
 *
 * 算法链路：
 *   1) 需求预测        → 日均需求 d̄、需求标准差 σ_d   （forecast.js）
 *   2) 动态安全库存    → SS = z·√(L·σ_d² + d̄²·σ_L²)
 *                        同时考虑「需求波动」与「供应商交期波动」，比固定安全库存更贴合实际
 *   3) 再订货点        → ROP = d̄·L + SS
 *   4) 目标库存水位    → Target = d̄·(L + 覆盖天数) + SS
 *   5) 补货量          → Q = Target − 可用库存 − 在途库存，按 MOQ 向上取整
 *   6) 经济订货批量    → EOQ = √(2·D·S / H) 作为单次订货上限参考
 *
 * 也支持企业自定义补货公式（走安全表达式求值器）。
 */
const { all, get, getSettings } = require('../db');
const { forecastDemand, normalInverse } = require('./forecast');
const { evaluate } = require('../lib/expression');

/** 单次下单固定成本（元/次），用于 EOQ */
const ORDER_COST = 200;

/** 查询商品库存与在途明细 */
function getStockInfo(productId) {
  const platforms = all(
    `SELECT i.*, pl.name AS platform_name, pl.code AS platform_code, pl.color
     FROM platform_inventory i
     JOIN platforms pl ON pl.id = i.platform_id
     WHERE i.product_id = ? ORDER BY pl.id`,
    productId
  );
  const totalStock = platforms.reduce((s, r) => s + r.stock, 0);
  const totalLocked = platforms.reduce((s, r) => s + r.locked, 0);

  // 在途库存：已下单但尚未入库的采购单明细
  const transit = get(
    `SELECT COALESCE(SUM(oi.qty), 0) AS qty
     FROM purchase_order_items oi
     JOIN purchase_orders o ON o.id = oi.order_id
     WHERE oi.product_id = ? AND o.status IN ('pending','confirmed','shipped')`,
    productId
  );

  return {
    platforms,
    totalStock,
    totalLocked,
    available: Math.max(0, totalStock - totalLocked),
    inTransit: transit ? transit.qty : 0,
  };
}

/**
 * 计算单个商品的补货建议（不落库，纯计算）
 * @param {object} product 商品行（含 lead_time_days / safety_days / cover_days / moq / purchase_price / supplier_id）
 * @param {object} settings 系统参数
 */
function computeSuggestion(product, settings = getSettings()) {
  const serviceLevel = clampNumber(Number(settings.service_level) || 0.95, 0.5, 0.999);
  const window = clampNumber(Number(settings.forecast_window) || 30, 7, 90);
  const weights = String(settings.forecast_weights || '0.5,0.3,0.2')
    .split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
  // 覆盖天数：商品级精细化配置优先，全局参数仅作兜底（新增商品未单独设置时使用）
  const coverDays = clampNumber(
    Number(product.cover_days) || Number(settings.cover_days) || 14, 1, 120
  );
  const overstockDays = clampNumber(Number(settings.alert_overstock_days) || 90, 30, 365);

  const fc = forecastDemand(product.id, {
    window,
    weights: weights.length === 3 ? weights : [0.5, 0.3, 0.2],
    forecastDays: 7,
  });
  const stock = getStockInfo(product.id);

  const d = Math.max(fc.avgDaily, 0.01);      // 日均需求（下限防止除零）
  const sigmaD = fc.demandStd;                 // 需求标准差
  const L = Math.max(1, Number(product.lead_time_days) || 7); // 提前期（天）

  // 供应商交期波动 σ_L：优先取供应商维护的标准差，否则按提前期 15% 估算
  const supplier = product.supplier_id ? get('SELECT lead_time_std FROM suppliers WHERE id = ?', product.supplier_id) : null;
  const sigmaL = supplier && supplier.lead_time_std != null ? Number(supplier.lead_time_std) : L * 0.15;

  // ---- 动态安全库存 ----
  const z = normalInverse(serviceLevel);
  const safetyStock = Math.ceil(z * Math.sqrt(L * sigmaD ** 2 + d ** 2 * sigmaL ** 2));

  // 兜底策略：仅当历史波动为 0（新品/无销量数据）时，退化为「固定安全天数」估算，
  // 其余情况以动态公式为准，并保证不低于 1 天销量，避免安全库存为 0 导致频繁断货。
  const fallbackDays = Number(product.safety_days) || Number(settings.safety_days) || 7;
  const finalSafety = sigmaD <= 0
    ? Math.ceil(d * fallbackDays * 0.6)
    : Math.max(safetyStock, Math.ceil(d * 1.0));

  // ---- 再订货点与目标水位 ----
  const reorderPoint = Math.ceil(d * L + finalSafety);
  const targetStock = Math.ceil(d * (L + coverDays) + finalSafety);

  // ---- 补货量 ----
  let rawQty = targetStock - stock.available - stock.inTransit;
  let algorithm = 'dynamic_ss';
  let formulaError = null;

  // 自定义公式优先（企业可覆盖默认算法）
  if (String(settings.custom_formula_enabled) === '1' && settings.custom_formula) {
    try {
      const vars = {
        available: stock.available,
        in_transit: stock.inTransit,
        avg_daily: d,
        demand_std: sigmaD,
        lead_time: L,
        safety_stock: finalSafety,
        reorder_point: reorderPoint,
        cover_days: coverDays,
        moq: product.moq,
        eoq: Math.round(Math.sqrt((2 * d * 365 * ORDER_COST) / Math.max(1, product.purchase_price * 0.2))),
        stock_days: stock.available / d,
        target_stock: targetStock,
        service_z: z,
      };
      rawQty = evaluate(settings.custom_formula, vars);
      algorithm = 'custom';
    } catch (err) {
      // 公式有误时自动回落到默认算法，保证业务不中断
      formulaError = err.message;
      algorithm = 'dynamic_ss';
      rawQty = targetStock - stock.available - stock.inTransit;
    }
  }

  // ---- EOQ 参考值 ----
  const annualDemand = d * 365;
  const holdingCost = Math.max(1, product.purchase_price * 0.2); // 年持有成本 ≈ 货值 20%
  const eoq = Math.round(Math.sqrt((2 * annualDemand * ORDER_COST) / holdingCost));

  // ---- MOQ 取整 ----
  const moq = Math.max(1, Number(product.moq) || 1);
  let suggestQty = 0;
  if (rawQty > 0) {
    suggestQty = Math.ceil(rawQty / moq) * moq;
    if (suggestQty <= 0) suggestQty = moq;
  }

  // ---- 库存健康状态 ----
  const stockDays = stock.available / d;
  const health = classifyHealth(stock.available, finalSafety, reorderPoint, stockDays, overstockDays, fc.trend);

  // ---- 紧急度 ----
  let urgency = 'normal';
  if (health === 'overstock') urgency = 'none';
  else if (stock.available <= 0) urgency = 'critical';
  else if (stock.available < finalSafety) urgency = 'critical';
  else if (stockDays < L) urgency = 'critical';        // 现有库存撑不到新货到仓
  else if (stock.available < reorderPoint) urgency = 'high';
  else if (suggestQty > 0) urgency = 'normal';

  // 积压商品（周转过慢）与健康库存不产生补货动作，避免无效采购占用资金
  if (health === 'overstock' || health === 'healthy') suggestQty = 0;

  // ---- 置信度：样本量 + 波动率 ----
  const sampleFactor = Math.min(1, fc.sampleDays / 30);
  const confidence = clampNumber(0.98 - fc.cv * 0.55 - (1 - sampleFactor) * 0.15, 0.5, 0.98);

  return {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    category: product.category,
    unit: product.unit,
    available: stock.available,
    totalStock: stock.totalStock,
    inTransit: stock.inTransit,
    avgDaily: round2(d),
    demandStd: round2(sigmaD),
    leadTime: L,
    sigmaL: round2(sigmaL),
    serviceLevel,
    z: round2(z),
    safetyStock: finalSafety,
    reorderPoint,
    targetStock,
    suggestQty,
    finalQty: suggestQty,
    eoq,
    coverDays,
    stockDays: round2(stockDays),
    urgency,
    health,
    confidence: round2(confidence),
    algorithm,
    formulaError,
    trend: fc.trend,
    cv: fc.cv,
    forecast: fc,
    purchasePrice: product.purchase_price,
    suggestPrice: product.suggest_price,
    supplierId: product.supplier_id,
    estimateAmount: round2(suggestQty * product.purchase_price),
    needReplenish: suggestQty > 0 && ['out_of_stock', 'critical', 'warning'].includes(health),
    reason: buildReason({
      health, available: stock.available, safety: finalSafety, rop: reorderPoint,
      stockDays, L, d, suggestQty, trend: fc.trend, inTransit: stock.inTransit,
    }),
  };
}

/** 库存健康度分档 */
function classifyHealth(available, safetyStock, reorderPoint, stockDays, overstockDays, trend) {
  if (available <= 0) return 'out_of_stock';
  if (available < safetyStock) return 'critical';
  if (available < reorderPoint) return 'warning';
  if (stockDays > overstockDays) return 'overstock';
  return 'healthy';
}

/** 生成人类可读的补货理由，供运营快速判断 */
function buildReason({ health, available, safety, rop, stockDays, L, d, suggestQty, trend, inTransit }) {
  const parts = [];
  if (health === 'out_of_stock') parts.push('全渠道已无可售库存，存在断货损失');
  else if (health === 'critical') parts.push(`可售库存 ${available} 件低于安全库存 ${safety} 件`);
  else if (health === 'warning') parts.push(`可售库存 ${available} 件已跌破再订货点 ${rop} 件`);
  else if (health === 'overstock') parts.push(`可售 ${stockDays.toFixed(0)} 天，周转严重偏慢，建议暂缓补货`);
  else parts.push('库存水位健康');

  parts.push(`当前日均销 ${d.toFixed(1)} 件，可售约 ${stockDays.toFixed(1)} 天`);
  if (stockDays < L) parts.push(`已低于供应商 ${L} 天交期，需立即下单`);
  if (inTransit > 0) parts.push(`另有在途 ${inTransit} 件已抵扣`);
  if (trend > 0.08) parts.push('近一周销量呈上升趋势，建议适当上调');
  else if (trend < -0.08) parts.push('近一周销量走弱，可酌情下调');
  if (suggestQty > 0) parts.push(`建议补货 ${suggestQty} 件`);
  return parts.join('；');
}

const round2 = (n) => Math.round(n * 100) / 100;
const clampNumber = (n, min, max) => Math.min(Math.max(Number.isFinite(n) ? n : min, min), max);

/** 对所有在售商品计算补货建议 */
function computeAll(settings = getSettings()) {
  const products = all("SELECT * FROM products WHERE status = 'on_sale' ORDER BY id");
  return products.map((p) => computeSuggestion(p, settings));
}

/**
 * 生成并同步补货建议到数据库
 * - 需要补货：无 pending 建议则插入，有则更新（已被人工调整/审核的保留不动）
 * - 不需要补货：清理掉该商品残留的 pending 建议，避免脏数据
 * @returns {{created:number, updated:number, cleared:number}}
 */
function syncSuggestions({ run: runStmt, all: allStmt, settings } = {}) {
  const { run, all: allRows } = require('../db');
  const st = settings || getSettings();
  const results = computeAll(st);
  let created = 0;
  let updated = 0;
  let cleared = 0;

  for (const r of results) {
    const pending = allRows(
      "SELECT * FROM replenish_suggestions WHERE product_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
      r.productId
    )[0];

    if (!r.needReplenish) {
      if (pending && !pending.reviewed_by) {
        run('DELETE FROM replenish_suggestions WHERE id = ?', pending.id);
        cleared += 1;
      }
      continue;
    }

    if (pending) {
      // 已被人工调整过的建议不再自动覆盖，避免冲掉人的判断
      run(
        `UPDATE replenish_suggestions
         SET available_stock=?, in_transit=?, avg_daily_sales=?, demand_std=?, lead_time_days=?,
             safety_stock=?, reorder_point=?, suggest_qty=?, final_qty=?, eoq=?, cover_days=?,
             urgency=?, confidence=?, algorithm=?, reason=?
         WHERE id=?`,
        r.available, r.inTransit, r.avgDaily, r.demandStd, r.leadTime,
        r.safetyStock, r.reorderPoint, r.suggestQty, r.suggestQty, r.eoq, r.coverDays,
        r.urgency, r.confidence, r.algorithm, r.reason, pending.id
      );
      updated += 1;
    } else {
      const no = `RP${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${String(r.productId).padStart(4, '0')}`;
      try {
        run(
          `INSERT INTO replenish_suggestions
            (suggestion_no, product_id, available_stock, in_transit, avg_daily_sales, demand_std,
             lead_time_days, safety_stock, reorder_point, suggest_qty, final_qty, eoq, cover_days,
             urgency, confidence, algorithm, reason, status)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
          no, r.productId, r.available, r.inTransit, r.avgDaily, r.demandStd,
          r.leadTime, r.safetyStock, r.reorderPoint, r.suggestQty, r.suggestQty, r.eoq, r.coverDays,
          r.urgency, r.confidence, r.algorithm, r.reason
        );
        created += 1;
      } catch (err) {
        // 唯一键冲突（同一天同商品重复生成）时跳过
        if (!String(err.message).includes('UNIQUE')) throw err;
      }
    }
  }
  return { created, updated, cleared, total: results.length };
}

module.exports = {
  computeSuggestion,
  computeAll,
  syncSuggestions,
  getStockInfo,
  classifyHealth,
  round2,
};
