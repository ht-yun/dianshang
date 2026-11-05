'use strict';
/**
 * 库存健康度监控与预警引擎
 *
 * 扫描维度：
 *  - 断货 / 低于安全库存 / 低于再订货点（补货触发线）
 *  - 库存积压（周转天数超过阈值）
 *  - 价格异常（跨平台价差过大、显著高于竞品）
 * 预警去重：同一商品同一类型只保留一条未关闭的预警，避免刷屏。
 */
const { all, get, run, getSettings } = require('../db');
const { computeAll } = require('./replenish');
const { getPriceComparison } = require('./crawler');

const LEVEL_ORDER = { critical: 0, warning: 1, info: 2 };

/**
 * 全量扫描并写入预警
 * @returns {{created: number, items: Array}}
 */
function scanAlerts() {
  const settings = getSettings();
  const overstockDays = Number(settings.alert_overstock_days) || 90;
  const slowDays = Number(settings.alert_slow_days) || 60;
  const stats = computeAll(settings);
  const created = [];

  const pushAlert = (productId, level, type, title, message) => {
    const exist = get(
      "SELECT id FROM alerts WHERE product_id = ? AND type = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
      productId, type
    );
    if (exist) {
      // 已存在则仅刷新内容与等级，保持时间戳稳定
      run('UPDATE alerts SET level = ?, title = ?, message = ? WHERE id = ?', level, title, message, exist.id);
      return;
    }
    run(
      'INSERT INTO alerts(product_id, level, type, title, message) VALUES(?,?,?,?,?)',
      productId, level, type, title, message
    );
    created.push({ productId, level, type, title });
  };

  // 自动关闭已经恢复正常的预警
  const autoClose = (productId, type) => {
    run("UPDATE alerts SET status = 'closed' WHERE product_id = ? AND type = ? AND status = 'open'", productId, type);
  };

  for (const s of stats) {
    if (s.health === 'out_of_stock') {
      pushAlert(s.productId, 'critical', 'out_of_stock', `${s.sku} 已断货`, `${s.name} 全渠道可售库存为 0，正在产生销售损失，请立即补货。`);
    } else {
      autoClose(s.productId, 'out_of_stock');
    }

    if (s.health === 'critical' && s.health !== 'out_of_stock') {
      pushAlert(s.productId, 'critical', 'stock_low',
        `${s.sku} 低于安全库存`,
        `${s.name} 可售 ${s.available} 件 < 安全库存 ${s.safetyStock} 件，可售仅 ${s.stockDays.toFixed(1)} 天。`);
    } else if (s.health !== 'critical' && s.health !== 'out_of_stock') {
      autoClose(s.productId, 'stock_low');
    }

    if (s.health === 'warning') {
      pushAlert(s.productId, 'warning', 'below_rop',
        `${s.sku} 跌破再订货点`,
        `${s.name} 可售 ${s.available} 件已低于再订货点 ${s.reorderPoint} 件，建议尽快下单补货。`);
    } else if (s.health !== 'warning') {
      autoClose(s.productId, 'below_rop');
    }

    if (s.health === 'overstock' || s.stockDays > overstockDays) {
      pushAlert(s.productId, 'info', 'overstock',
        `${s.sku} 库存积压`,
        `${s.name} 可售 ${s.stockDays.toFixed(0)} 天（阈值 ${overstockDays} 天），占用资金约 ¥${(s.available * s.purchasePrice).toLocaleString('zh-CN')}，建议促销或暂停采购。`);
    } else {
      autoClose(s.productId, 'overstock');
    }

    // 动销异常：近 N 天零销量
    const sold = get(
      `SELECT COALESCE(SUM(qty),0) AS q FROM sales_history
       WHERE product_id = ? AND sale_date >= date('now', ?)`,
      s.productId, `-${slowDays} day`
    );
    if (sold && sold.q === 0 && s.available > 0) {
      pushAlert(s.productId, 'info', 'slow_moving',
        `${s.sku} 滞销预警`, `${s.name} 近 ${slowDays} 天无销量，库存 ${s.available} 件需关注。`);
    } else {
      autoClose(s.productId, 'slow_moving');
    }
  }

  // 价格异常扫描
  try {
    const cmp = getPriceComparison();
    for (const p of cmp) {
      if (p.anomaly) {
        pushAlert(p.productId, 'warning', 'price_anomaly', `${p.sku} 价格异常`, `${p.name}：${p.anomaly}`);
      } else {
        autoClose(p.productId, 'price_anomaly');
      }
    }
  } catch (_) {
    /* 价格数据缺失时跳过该维度 */
  }

  created.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  return { created: created.length, items: created };
}

/** 预警列表（含分页与等级过滤） */
function listAlerts({ level, status = 'open', limit = 100 } = {}) {
  const cond = [];
  const params = [];
  if (level && level !== 'all') { cond.push('a.level = ?'); params.push(level); }
  if (status && status !== 'all') { cond.push('a.status = ?'); params.push(status); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return all(
    `SELECT a.*, p.sku, p.name AS product_name, p.category
     FROM alerts a LEFT JOIN products p ON p.id = a.product_id
     ${where}
     ORDER BY CASE a.level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.created_at DESC
     LIMIT ?`,
    ...params, limit
  );
}

/** 预警统计（用于看板角标） */
function alertStats() {
  const rows = all(
    `SELECT level, COUNT(*) AS c FROM alerts WHERE status='open' GROUP BY level`
  );
  const out = { critical: 0, warning: 0, info: 0, total: 0 };
  for (const r of rows) {
    out[r.level] = r.c;
    out.total += r.c;
  }
  return out;
}

module.exports = { scanAlerts, listAlerts, alertStats };
