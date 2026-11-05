'use strict';
/**
 * 数据看板聚合接口
 * 把分散在库存、销售、补货、预警各表的数据聚合成前端可直接渲染的结构。
 * 计算涉及全量商品预测，结果做 15 秒内存缓存，避免高频刷新拖慢服务。
 */
const express = require('express');
const { all, get, getSettings } = require('../db');
const { computeAll } = require('../services/replenish');
const { alertStats } = require('../services/alerts');

const router = express.Router();

const HEALTH_LABEL = {
  out_of_stock: '已断货',
  critical: '低于安全库存',
  warning: '达到补货线',
  healthy: '库存健康',
  overstock: '库存积压',
};

// ---- 简单 TTL 缓存 ----
let cache = { at: 0, data: null };
const TTL = 15000;
function invalidate() { cache.at = 0; }

const round2 = (n) => Math.round(n * 100) / 100;

/** 近 N 天销售趋势（按日聚合，含未来 7 天预测） */
function buildTrend(days = 30) {
  const rows = all(
    `SELECT sale_date AS d, SUM(qty) AS qty, SUM(amount) AS amt
     FROM sales_history WHERE sale_date >= date('now', ?)
     GROUP BY sale_date ORDER BY sale_date ASC`,
    `-${days} day`
  );
  const map = new Map(rows.map((r) => [r.d, r]));
  const dates = [];
  const sales = [];
  const qty = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hit = map.get(key);
    dates.push(key);
    sales.push(hit ? round2(hit.amt) : 0);
    qty.push(hit ? hit.qty : 0);
  }

  // 预测：近 7 日均值 + 近 14 日趋势斜率外推，做平滑处理
  const tail = qty.slice(-7);
  const tail14 = qty.slice(-14);
  const ma7 = tail.reduce((s, v) => s + v, 0) / Math.max(1, tail.length);
  const ma14 = tail14.reduce((s, v) => s + v, 0) / Math.max(1, tail14.length);
  const slope = (ma7 - ma14) / 7;
  const avgPrice = qty.slice(-7).reduce((s, v, i) => s + v, 0) > 0
    ? sales.slice(-7).reduce((s, v) => s + v, 0) / qty.slice(-7).reduce((s, v) => s + v, 0)
    : 0;

  const forecastDates = [];
  const forecastQty = [];
  for (let h = 1; h <= 7; h++) {
    const d = new Date(Date.now() + h * 86400000);
    forecastDates.push(`${d.getMonth() + 1}/${d.getDate()}`);
    forecastQty.push(Math.max(0, Math.round(ma7 + slope * h)));
  }
  const forecastSales = forecastQty.map((q) => round2(q * avgPrice));

  return {
    dates: dates.map((d) => d.slice(5).replace('-', '/')),
    sales,
    qty,
    forecastDates,
    forecastQty,
    forecastSales,
    ma7: Math.round(ma7),
    forecastTotal: forecastQty.reduce((s, v) => s + v, 0),
  };
}

router.get('/overview', (req, res) => {
  if (cache.data && Date.now() - cache.at < TTL) {
    return res.json({ ...cache.data, cached: true });
  }

  const settings = getSettings();
  const stats = computeAll(settings);

  // ---- 库存与货值 ----
  const invAgg = get(
    `SELECT COALESCE(SUM(i.stock),0) AS totalStock,
            COALESCE(SUM(i.stock * p.purchase_price),0) AS stockValue,
            COALESCE(SUM(i.stock * i.price),0) AS retailValue
     FROM platform_inventory i JOIN products p ON p.id = i.product_id`
  );

  // ---- 今日 / 近 7 日销售 ----
  const today = get(
    `SELECT COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(amount),0) AS amt
     FROM sales_history WHERE sale_date = date('now')`
  );
  const week = get(
    `SELECT COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(amount),0) AS amt
     FROM sales_history WHERE sale_date >= date('now','-6 day')`
  );
  const prevWeek = get(
    `SELECT COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(amount),0) AS amt
     FROM sales_history WHERE sale_date >= date('now','-13 day') AND sale_date < date('now','-6 day')`
  );
  const weekGrowth = prevWeek.amt > 0 ? ((week.amt - prevWeek.amt) / prevWeek.amt) * 100 : 0;

  // ---- 健康度分布 ----
  const healthDist = Object.keys(HEALTH_LABEL).map((k) => ({
    status: k,
    label: HEALTH_LABEL[k],
    count: stats.filter((s) => s.health === k).length,
  }));

  // ---- 平台销售占比（近 30 天） ----
  const platformShare = all(
    `SELECT pl.name, pl.code, pl.color,
            COALESCE(SUM(s.amount),0) AS sales, COALESCE(SUM(s.qty),0) AS qty
     FROM platforms pl
     LEFT JOIN sales_history s ON s.platform_id = pl.id AND s.sale_date >= date('now','-29 day')
     GROUP BY pl.id ORDER BY sales DESC`
  ).map((r) => ({ ...r, sales: round2(r.sales) }));

  // ---- 品类库存货值 ----
  const categoryStock = all(
    `SELECT p.category AS name,
            COALESCE(SUM(i.stock),0) AS stock,
            ROUND(COALESCE(SUM(i.stock * p.purchase_price),0), 2) AS value
     FROM products p LEFT JOIN platform_inventory i ON i.product_id = p.id
     GROUP BY p.category ORDER BY value DESC`
  );

  // ---- 热销榜（近 7 天） ----
  const topSellers = all(
    `SELECT p.id, p.sku, p.name, p.category,
            SUM(s.qty) AS qty, ROUND(SUM(s.amount),2) AS amount
     FROM sales_history s JOIN products p ON p.id = s.product_id
     WHERE s.sale_date >= date('now','-6 day')
     GROUP BY p.id ORDER BY amount DESC LIMIT 8`
  );

  // ---- 待处理补货建议（紧急优先） ----
  const urgent = all(
    `SELECT r.*, p.sku, p.name, p.category, p.unit, p.purchase_price,
            s.name AS supplier_name
     FROM replenish_suggestions r
     JOIN products p ON p.id = r.product_id
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE r.status = 'pending'
     ORDER BY CASE r.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, r.id DESC
     LIMIT 8`
  );

  const pendingOrders = get(
    "SELECT COUNT(*) AS c, COALESCE(SUM(total_amount),0) AS amt FROM purchase_orders WHERE status IN ('pending','confirmed','shipped')"
  );

  const data = {
    kpi: {
      stockValue: round2(invAgg.stockValue),
      retailValue: round2(invAgg.retailValue),
      totalStock: invAgg.totalStock,
      skuCount: stats.length,
      todaySales: round2(today.amt),
      todayQty: today.qty,
      weekSales: round2(week.amt),
      weekQty: week.qty,
      weekGrowth: round2(weekGrowth),
      needReplenish: stats.filter((s) => s.needReplenish).length,
      outOfStock: stats.filter((s) => s.health === 'out_of_stock').length,
      overstock: stats.filter((s) => s.health === 'overstock').length,
      avgTurnoverDays: round2(
        stats.length
          ? stats.reduce((s, r) => s + (r.avgDaily > 0 ? r.available / r.avgDaily : 0), 0) / stats.length
          : 0
      ),
      pendingSuggestions: get("SELECT COUNT(*) AS c FROM replenish_suggestions WHERE status='pending'").c,
      pendingOrders: pendingOrders.c,
      pendingOrderAmount: round2(pendingOrders.amt),
      alerts: alertStats(),
    },
    trend: buildTrend(30),
    platformShare,
    categoryStock,
    healthDist,
    topSellers,
    urgent,
    generatedAt: new Date().toLocaleString('zh-CN'),
  };

  cache = { at: Date.now(), data };
  res.json({ ...data, cached: false });
});

/** 全渠道库存水位矩阵（商品 × 平台），用于库存热力对比 */
router.get('/matrix', (req, res) => {
  const platforms = all('SELECT id, name, code, color FROM platforms ORDER BY id');
  const rows = all(
    `SELECT p.id, p.sku, p.name, p.category, p.safety_days,
            i.platform_id, i.stock, i.locked, i.price
     FROM products p JOIN platform_inventory i ON i.product_id = p.id
     ORDER BY p.id, i.platform_id`
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.id)) {
      map.set(r.id, { id: r.id, sku: r.sku, name: r.name, category: r.category, cells: {} });
    }
    map.get(r.id).cells[r.platform_id] = { stock: r.stock, locked: r.locked, price: r.price };
  }
  res.json({ platforms, rows: [...map.values()] });
});

/** 实时事件流（SSE） */
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  require('../services/sync').addSseClient(res);
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(hb); }
  }, 25000);
  req.on('close', () => clearInterval(hb));
});

module.exports = router;
module.exports.invalidateDashboard = invalidate;
