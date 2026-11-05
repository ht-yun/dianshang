'use strict';
/**
 * 数据同步层（事件驱动）
 *
 * 真实场景中，电商平台通过 Webhook / 消息队列推送「订单支付」「库存变更」事件。
 * 本模块用 EventEmitter 构建同样的事件总线，并对外提供：
 *   - 平台订单事件模拟（定时产生真实感订单，驱动库存实时变化）
 *   - 全渠道库存同步（拉取平台侧库存并落库）
 *   - SSE 长连接广播，前端看板可无刷新实时跳动
 *
 * 事件流：order.paid → 扣减平台库存 → 写库存流水 → 累加当日销量
 *        → 触发库存健康复算 → 生成补货建议/预警 → SSE 推送
 */
const { EventEmitter } = require('node:events');
const { all, get, run, getSettings } = require('../db');

const bus = new EventEmitter();
bus.setMaxListeners(50);

/** SSE 客户端集合 */
const sseClients = new Set();

function addSseClient(res) {
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
  // 立即发送一次握手事件，让前端确认通道已建立
  try {
    res.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  } catch (_) { /* 连接已断开 */ }
}

/** 向所有 SSE 客户端广播 */
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...sseClients]) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

const nowStr = () => new Date().toLocaleString('sv-SE').replace('T', ' ');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * 处理平台订单支付事件：扣减库存、写流水、累加销量
 * @returns {object|null} 事件摘要
 */
function handleOrderPaid({ productId, platformId, qty, orderNo }) {
  const inv = get(
    `SELECT i.*, pl.name AS platform_name FROM platform_inventory i
     JOIN platforms pl ON pl.id = i.platform_id
     WHERE i.product_id = ? AND i.platform_id = ?`,
    productId, platformId
  );
  if (!inv || inv.stock <= 0) return null;

  const deduct = Math.min(qty, inv.stock);
  const product = get('SELECT * FROM products WHERE id = ?', productId);
  if (!product) return null;

  run("UPDATE platform_inventory SET stock = stock - ?, updated_at = datetime('now','localtime') WHERE id = ?", deduct, inv.id);
  run(
    "INSERT INTO stock_movements(product_id, platform_id, type, qty, ref_no, note, created_at) VALUES(?,?,?,?,?,?, datetime('now','localtime'))",
    productId, platformId, 'out', -deduct, orderNo, `${inv.platform_name} 订单出库`
  );

  // 累加当日销量，让预测模型能用上实时数据
  const today = todayStr();
  const exist = get(
    'SELECT id, qty, amount FROM sales_history WHERE product_id = ? AND platform_id = ? AND sale_date = ?',
    productId, platformId, today
  );
  const amount = deduct * inv.price;
  if (exist) {
    run('UPDATE sales_history SET qty = qty + ?, amount = amount + ? WHERE id = ?', deduct, amount, exist.id);
  } else {
    run(
      'INSERT INTO sales_history(product_id, platform_id, sale_date, qty, amount) VALUES(?,?,?,?,?)',
      productId, platformId, today, deduct, amount
    );
  }

  run(
    "INSERT INTO sync_logs(platform_id, event_type, direction, payload, status, latency_ms, created_at) VALUES(?,?,?,?,?,?, datetime('now','localtime'))",
    platformId, 'order_paid', 'in',
    JSON.stringify({ orderNo, sku: product.sku, qty: deduct }),
    'success', 30 + Math.floor(Math.random() * 120)
  );

  const afterStock = inv.stock - deduct;
  const payload = {
    orderNo,
    productId,
    sku: product.sku,
    productName: product.name,
    platformId,
    platformName: inv.platform_name,
    qty: deduct,
    stockAfter: afterStock,
    at: nowStr(),
  };
  broadcast('order.paid', payload);
  bus.emit('order.paid', payload);
  return payload;
}

/**
 * 全渠道库存同步：模拟从各平台拉取库存与锁定数
 * 真实实现应调用各平台 OpenAPI（如淘宝 taobao.item.quantity.update / 京东 jos）
 */
function syncAllPlatforms() {
  const platforms = all("SELECT * FROM platforms WHERE status = 'active'");
  const started = Date.now();
  let changed = 0;

  for (const pl of platforms) {
    const invs = all('SELECT * FROM platform_inventory WHERE platform_id = ?', pl.id);
    for (const inv of invs) {
      // 平台侧可能有微小差异（例如其他渠道占用），同步后对齐
      const drift = Math.random() < 0.08 ? (Math.random() < 0.5 ? -1 : 1) : 0;
      if (drift !== 0) {
        run(
          "UPDATE platform_inventory SET stock = MAX(0, stock + ?), updated_at = datetime('now','localtime') WHERE id = ?",
          drift, inv.id
        );
        changed += 1;
      } else {
        run("UPDATE platform_inventory SET updated_at = datetime('now','localtime') WHERE id = ?", inv.id);
      }
    }
    run(
      "INSERT INTO sync_logs(platform_id, event_type, direction, payload, status, latency_ms, created_at) VALUES(?,?,?,?,?,?, datetime('now','localtime'))",
      pl.id, 'inventory_pull', 'in',
      JSON.stringify({ platform: pl.name, items: invs.length, changed }),
      'success', 60 + Math.floor(Math.random() * 300)
    );
  }

  const latency = Date.now() - started;
  broadcast('sync.done', { platforms: platforms.length, changed, latency, at: nowStr() });
  return { platforms: platforms.length, changed, latency };
}

/** 随机产生一笔平台订单（用于演示实时事件流） */
function randomOrderEvent() {
  const rows = all(
    `SELECT i.product_id, i.platform_id, i.stock, p.name, p.sku
     FROM platform_inventory i JOIN products p ON p.id = i.product_id
     WHERE i.stock > 2 ORDER BY RANDOM() LIMIT 1`
  );
  if (!rows.length) return null;
  const r = rows[0];
  // 单笔订单量贴合真实客单：1~4 件，热销品可到 8 件
  const qty = 1 + Math.floor(Math.random() * 4);
  const orderNo = `ORD${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 90 + 10)}`;
  return handleOrderPaid({ productId: r.product_id, platformId: r.platform_id, qty, orderNo });
}

/** 定时器句柄 */
let timers = [];
let recomputeTimer = null;
let dirty = false;

/** 标记库存已变化，等待后台批量复算（避免每笔订单都全量重算） */
function markDirty() {
  dirty = true;
}

/** 后台复算：生成补货建议 + 扫描预警，并广播结果 */
function recompute({ force = false } = {}) {
  if (!dirty && !force) return null;
  dirty = false;
  const settings = getSettings();
  let sug = { created: 0, updated: 0, cleared: 0 };
  let alertResult = { created: 0 };

  try {
    const { syncSuggestions } = require('./replenish');
    sug = syncSuggestions({ settings });
  } catch (err) {
    console.error('[sync] 补货建议重算失败:', err.message);
  }

  if (String(settings.auto_replenish) === '1') {
    try {
      const { scanAlerts } = require('./alerts');
      alertResult = scanAlerts();
    } catch (err) {
      console.error('[sync] 预警扫描失败:', err.message);
    }
  }

  const payload = {
    suggestions: sug,
    alerts: alertResult.created,
    at: nowStr(),
  };
  broadcast('inventory.recomputed', payload);
  return payload;
}

/**
 * 启动同步引擎
 * @param {object} opts { orderInterval: 秒 }
 */
function startEngine(opts = {}) {
  stopEngine();
  const settings = getSettings();
  // 订单事件间隔：默认 15 秒产生一笔模拟订单；可通过环境变量覆盖
  const orderInterval = Math.max(3, Number(opts.orderInterval || process.env.SIM_ORDER_INTERVAL || 15));

  timers.push(setInterval(() => {
    try {
      const evt = randomOrderEvent();
      if (evt) {
        // 判断是否跌破再订货点，跌破则立即安排复算
        const stock = get(
          'SELECT COALESCE(SUM(stock),0) AS s FROM platform_inventory WHERE product_id = ?',
          evt.productId
        );
        markDirty();
        broadcast('stock.changed', { ...evt, totalStock: stock ? stock.s : 0 });
      }
    } catch (err) {
      console.error('[sync] 订单事件处理异常:', err.message);
    }
  }, orderInterval * 1000));

  // 每 25 秒执行一次批量复算
  recomputeTimer = setInterval(() => {
    try {
      recompute();
    } catch (err) {
      console.error('[sync] 复算异常:', err.message);
    }
  }, 25000);

  // 每次启动先算一遍，保证首屏就有建议
  markDirty();
  recompute({ force: true });

  console.log(`[sync] 事件引擎已启动，模拟订单间隔 ${orderInterval}s`);
  return { orderInterval };
}

function stopEngine() {
  for (const t of timers) clearInterval(t);
  timers = [];
  if (recomputeTimer) clearInterval(recomputeTimer);
  recomputeTimer = null;
}

module.exports = {
  bus, addSseClient, broadcast, handleOrderPaid, syncAllPlatforms,
  randomOrderEvent, startEngine, stopEngine, recompute, markDirty,
};
