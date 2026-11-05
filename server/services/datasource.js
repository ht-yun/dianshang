'use strict';
/**
 * 数据源适配层
 *
 * 职责：把「外部商品数据源」抽象成一个可替换的接口，让主系统与数据生产方解耦。
 *
 *   内部演示数据（内置种子） ─┐
 *   仿真数据子系统 (HTTP)   ─┼→ DataSource Adapter → 商品/库存/销量表 → 补货算法 → 看板
 *   真实电商 API（未来）    ─┘
 *
 * 当前实现 http 适配器，指向 mock-data-service（默认 http://127.0.0.1:4100）。
 * 未来接入真实平台，只需在 fetchProducts 里换成真实 API 的字段映射，
 * 上层业务（补货计算、预警、采购单）完全不用改——这就是分层的意义。
 *
 * 关键设计决策：
 *   1. 数据源拉取失败不影响主系统运行，只记录日志并保持既有数据；
 *   2. 外部数据源一旦启用即成为「库存主数据」，内部订单模拟引擎停止，
 *      否则两边同时扣减/覆盖库存会产生互相打架的脏数据；
 *   3. 首次导入按 30 天回填销量历史，后续只写增量，避免破坏预测所需的时序数据。
 */
const { all, get, run, tx, getSettings } = require('../db');

// 数据源自身的快照表（独立于核心业务表，便于整体移除该能力）
const { db } = require('../db');
db.exec(`
CREATE TABLE IF NOT EXISTS ds_product_snapshots (
  sku         TEXT PRIMARY KEY,
  source      TEXT NOT NULL DEFAULT 'mock',
  item_id     TEXT,
  last_sales  INTEGER NOT NULL DEFAULT 0,
  last_stock  INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`);

/** 默认配置：写入 settings 表后可持久化 */
const DEFAULTS = {
  datasource_url: 'http://127.0.0.1:4100',
  datasource_enabled: '0',
  datasource_interval: '60',
  datasource_mode: 'stable',
  datasource_batch: '12',
  datasource_offset: '0',
};

/** 品类 → 供应商映射：让仿真商品也能走通「按供应商拆单」的真实业务链路 */
const CATEGORY_SUPPLIER = {
  数码配件: 'SUP-01',
  小家电: 'SUP-01',
  家居日用: 'SUP-02',
  美妆个护: 'SUP-03',
  食品饮料: 'SUP-04',
  服饰鞋包: 'SUP-05',
  母婴玩具: 'SUP-05',
  运动户外: 'SUP-05',
};

/** 品类 → 毛利率：不同行业加价率差异很大，直接套同一个系数不真实 */
const CATEGORY_MARGIN = {
  数码配件: 0.22,
  小家电: 0.28,
  家居日用: 0.38,
  美妆个护: 0.45,
  食品饮料: 0.32,
  服饰鞋包: 0.42,
  母婴玩具: 0.36,
  运动户外: 0.35,
};

/** 各平台销量/库存占比（与平台体量一致，合计为 1） */
const PLATFORM_WEIGHTS = [0.40, 0.30, 0.20, 0.10];

const round2 = (v) => Math.round(v * 100) / 100;
const todayStr = () => new Date().toLocaleDateString('sv-SE');

// ---------------------------------------------------------------- 配置

function getConfig() {
  const s = getSettings();
  return {
    url: String(s.datasource_url || DEFAULTS.datasource_url).replace(/\/+$/, ''),
    enabled: String(s.datasource_enabled || DEFAULTS.datasource_enabled) === '1',
    interval: Math.max(10, Number(s.datasource_interval) || Number(DEFAULTS.datasource_interval)),
    mode: s.datasource_mode || DEFAULTS.datasource_mode,
    batch: Math.min(100, Math.max(1, Number(s.datasource_batch) || Number(DEFAULTS.datasource_batch))),
    offset: Math.max(0, Number(s.datasource_offset) || 0),
  };
}

/** 运行时状态（内存，重启即清零） */
const runtime = {
  lastPullAt: null,
  lastResult: null,
  lastError: null,
  timer: null,
  health: null,
  healthAt: 0,
};

// ---------------------------------------------------------------- HTTP

/**
 * 带超时与重试的 JSON 请求
 * 外部依赖不可控，必须假设它会超时、会拒连、会返回非 JSON
 */
async function requestJson(url, { timeout = 4000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (_) {
        throw new Error('响应不是合法 JSON（可能命中了错误的地址）');
      }
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error(`请求超时（${timeout}ms）`) : err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** 探测数据源连通性 */
async function checkHealth(baseUrl, { timeout = 3000 } = {}) {
  const url = baseUrl || getConfig().url;
  const started = Date.now();
  try {
    const data = await requestJson(`${url}/api/health`, { timeout, retries: 0 });
    return {
      online: true,
      url,
      latency_ms: Date.now() - started,
      service: data.service || 'unknown',
      version: data.version || '-',
      pool_size: data.pool_size ?? null,
      pool: data.pool || null,
      uptime_seconds: data.uptime_seconds ?? null,
    };
  } catch (err) {
    return { online: false, url, latency_ms: Date.now() - started, error: err.message };
  }
}

/** 拉取一批商品数据 */
async function fetchProducts({ url, count, mode, offset, timeout = 5000 } = {}) {
  const cfg = getConfig();
  const base = (url || cfg.url).replace(/\/+$/, '');
  const qs = new URLSearchParams();
  qs.set('count', String(count || cfg.batch));
  qs.set('mode', mode || cfg.mode);
  if (mode === 'stable' || (!mode && cfg.mode === 'stable')) {
    qs.set('offset', String(offset ?? cfg.offset));
  }
  const data = await requestJson(`${base}/api/products?${qs.toString()}`, { timeout });
  const items = Array.isArray(data) ? data : data.items;
  if (!Array.isArray(items)) throw new Error('数据源返回结构异常：缺少 items 数组');
  return { items, meta: (Array.isArray(data) ? null : data.meta) || null, base };
}

// ---------------------------------------------------------------- 映射

/** 整数拆分：按权重把 total 分成若干整数，保证求和精确等于 total */
function splitInt(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map((v) => Math.floor(v));
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; rest > 0; k += 1) {
    out[order[k % order.length].i] += 1;
    rest -= 1;
  }
  return out;
}

/** 校验并规整外部数据，防止脏数据写坏业务表 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const itemId = String(raw.item_id || '').trim();
  const title = String(raw.title || '').trim();
  if (!itemId || !title) return null;

  const stock = Number(raw.stock);
  const sales = Number(raw.sales);
  const price = Number(raw.price);
  if (!Number.isFinite(stock) || !Number.isFinite(sales) || !Number.isFinite(price)) return null;

  return {
    item_id: itemId,
    title,
    stock: Math.max(0, Math.round(stock)),
    sales: Math.max(0, Math.round(sales)),
    price: price > 0 ? round2(price) : 0,
    category: String(raw.category || '未分类').trim() || '未分类',
    min_stock: Number.isFinite(Number(raw.min_stock)) ? Math.max(0, Math.round(Number(raw.min_stock))) : null,
    stock_status: raw.stock_status || null,
  };
}

/** 解析供应商：品类优先，未知品类回落到主供应商 */
function resolveSupplier(category) {
  const code = CATEGORY_SUPPLIER[category];
  const byCode = code ? get('SELECT * FROM suppliers WHERE code = ?', code) : null;
  if (byCode) return byCode;
  return get('SELECT * FROM suppliers ORDER BY id LIMIT 1');
}

/** 取平台列表（按 id 排序，与 PLATFORM_WEIGHTS 对应） */
function getPlatforms() {
  return all('SELECT * FROM platforms ORDER BY id');
}

/** 生成过去 30 天的销量并回填（仅在商品首次接入时执行） */
function backfillSales(productId, totalSales, price, platforms) {
  if (totalSales <= 0 || platforms.length === 0) return 0;
  const days = 30;
  // 日分布形状：周末抬升 + 随机波动，让预测算法看到的不是一条直线
  const weights = [];
  for (let d = days - 1; d >= 0; d -= 1) {
    const date = new Date(Date.now() - d * 86400000);
    const dow = date.getDay();
    const weekend = dow === 0 || dow === 6 ? 1.28 : 1;
    weights.push(weekend * (0.72 + Math.random() * 0.56));
  }
  const wsum = weights.reduce((a, b) => a + b, 0);

  let allocated = 0;
  let rows = 0;
  for (let i = 0; i < days; i += 1) {
    const date = new Date(Date.now() - (days - 1 - i) * 86400000).toLocaleDateString('sv-SE');
    // 最后一天吃掉舍入残差，保证 30 天合计精确等于外部销量
    const qty = i === days - 1 ? totalSales - allocated : Math.round((totalSales * weights[i]) / wsum);
    allocated += qty;
    if (qty <= 0) continue;

    const parts = splitInt(qty, PLATFORM_WEIGHTS.slice(0, platforms.length));
    for (let p = 0; p < platforms.length; p += 1) {
      if (parts[p] <= 0) continue;
      run(
        `INSERT INTO sales_history(product_id, platform_id, sale_date, qty, amount)
         VALUES(?,?,?,?,?)`,
        productId, platforms[p].id, date, parts[p], round2(parts[p] * price)
      );
      rows += 1;
    }
  }
  return rows;
}

/** 写入当日销量增量（后续同步时使用，只增不减，保留历史） */
function addTodaySales(productId, delta, price, platforms) {
  if (delta <= 0 || platforms.length === 0) return;
  const date = todayStr();
  const parts = splitInt(delta, PLATFORM_WEIGHTS.slice(0, platforms.length));
  for (let p = 0; p < platforms.length; p += 1) {
    if (parts[p] <= 0) continue;
    run(
      `INSERT INTO sales_history(product_id, platform_id, sale_date, qty, amount)
       VALUES(?,?,?,?,?)`,
      productId, platforms[p].id, date, parts[p], round2(parts[p] * price)
    );
  }
}

/** 把总库存按权重分摊到各平台，并把平台售价按 price_factor 换算 */
function syncPlatformInventory(productId, stock, price, platforms) {
  const parts = splitInt(stock, PLATFORM_WEIGHTS.slice(0, platforms.length));
  for (let p = 0; p < platforms.length; p += 1) {
    const pf = Number(platforms[p].price_factor) || 1;
    // 各平台在基础价上做小幅差异化定价（促销/包邮成本不同）
    const listing = round2(Math.max(0.01, price * pf));
    run(
      `INSERT INTO platform_inventory(product_id, platform_id, stock, price, updated_at)
       VALUES(?,?,?,?,datetime('now','localtime'))
       ON CONFLICT(product_id, platform_id)
       DO UPDATE SET stock = excluded.stock, price = excluded.price, updated_at = excluded.updated_at`,
      productId, platforms[p].id, parts[p], listing
    );
  }
  return parts;
}

// ---------------------------------------------------------------- 导入

/**
 * 把一批外部商品写入主系统
 * @returns {{created:number, updated:number, salesBackfilled:number, stockDelta:number, skipped:number, createdItems:Array}}
 */
function importItems(rawItems, { source = 'mock' } = {}) {
  const platforms = getPlatforms();
  const stat = { created: 0, updated: 0, salesBackfilled: 0, stockDelta: 0, skipped: 0, createdItems: [] };
  if (platforms.length === 0) throw new Error('平台数据未初始化，无法分摊库存');

  tx(() => {
    for (const raw of rawItems) {
      const item = normalizeItem(raw);
      if (!item) {
        stat.skipped += 1;
        continue;
      }
      if (item.price <= 0) {
        stat.skipped += 1;
        continue;
      }

      const supplier = resolveSupplier(item.category);
      const margin = CATEGORY_MARGIN[item.category] ?? 0.35;
      const purchasePrice = round2(Math.max(0.5, item.price * (1 - margin)));
      const existing = get('SELECT * FROM products WHERE sku = ?', item.item_id);
      const brand = item.title.split(/\s+/)[0] || null;

      let productId;
      if (existing) {
        productId = existing.id;
        run(
          `UPDATE products SET name=?, category=?, brand=?, purchase_price=?, suggest_price=?,
             supplier_id=?, lead_time_days=?, moq=? WHERE id=?`,
          item.title, item.category, brand, purchasePrice, item.price,
          supplier ? supplier.id : null,
          supplier ? supplier.lead_time_days : 7,
          supplier ? supplier.min_order_qty : 20,
          productId
        );
        stat.updated += 1;
      } else {
        const r = run(
          `INSERT INTO products(sku,name,category,brand,unit,purchase_price,suggest_price,
             supplier_id,lead_time_days,safety_days,cover_days,moq,status)
           VALUES(?,?,?,?,'件',?,?,?,?,7,14,?,'on_sale')`,
          item.item_id, item.title, item.category, brand, purchasePrice, item.price,
          supplier ? supplier.id : null,
          supplier ? supplier.lead_time_days : 7,
          supplier ? supplier.min_order_qty : 20
        );
        productId = Number(r.lastInsertRowid);
        stat.created += 1;
        // 记下新建商品明细：chaos 模式下前端要展示「这次上架了哪些新品」
        stat.createdItems.push({
          sku: item.item_id,
          name: item.title,
          category: item.category,
          price: item.price,
          stock: item.stock,
        });
      }

      // ---- 库存：以外部数据源为准，绝对覆盖 ----
      const before = get(
        'SELECT COALESCE(SUM(stock),0) AS s FROM platform_inventory WHERE product_id = ?',
        productId
      ).s;
      syncPlatformInventory(productId, item.stock, item.price, platforms);
      const delta = item.stock - before;
      stat.stockDelta += delta;
      if (delta !== 0) {
        run(
          `INSERT INTO stock_movements(product_id, platform_id, type, qty, ref_no, note)
           VALUES(?,NULL,?,?,?,?)`,
          productId, delta > 0 ? 'in' : 'out', Math.abs(delta), `DS-${item.item_id}`,
          `数据源同步（${delta > 0 ? '补货入库' : '库存调减'}）`
        );
      }

      // ---- 销量：首次回填历史，之后只写增量 ----
      const snap = get('SELECT * FROM ds_product_snapshots WHERE sku = ?', item.item_id);
      if (!snap) {
        stat.salesBackfilled += backfillSales(productId, item.sales, item.price, platforms);
        run(
          `INSERT INTO ds_product_snapshots(sku, source, item_id, last_sales, last_stock, imported_at)
           VALUES(?,?,?,?,?,datetime('now','localtime'))`,
          item.item_id, source, item.item_id, item.sales, item.stock
        );
      } else {
        const growth = item.sales - snap.last_sales;
        if (growth > 0) addTodaySales(productId, growth, item.price, platforms);
        run(
          `UPDATE ds_product_snapshots SET last_sales=?, last_stock=?, imported_at=datetime('now','localtime')
           WHERE sku=?`,
          item.sales, item.stock, item.item_id
        );
      }
    }
  });

  return stat;
}

/** 记录同步日志（复用 sync_logs，便于在现有「同步日志」里一并查看） */
function logSync({ status, latency, payload }) {
  try {
    run(
      `INSERT INTO sync_logs(platform_id, event_type, direction, payload, status, latency_ms)
       VALUES(NULL,'datasource.pull','in',?,?,?)`,
      JSON.stringify(payload).slice(0, 2000), status, Math.round(latency)
    );
  } catch (err) {
    console.error('[datasource] 写同步日志失败:', err.message);
  }
}

/**
 * 执行一次完整拉取：探测 → 拉取 → 入库 → 触发补货重算
 * 任何环节失败都不会抛出到调用方，而是返回结构化结果
 */
async function pull({ count, mode, url } = {}) {
  const cfg = getConfig();
  const started = Date.now();
  const target = (url || cfg.url).replace(/\/+$/, '');

  try {
    const health = await checkHealth(target, { timeout: 3000 });
    if (!health.online) {
      throw new Error(`数据源不可达（${target}）：${health.error}`);
    }
    runtime.health = health;
    runtime.healthAt = Date.now();

    const { items, meta } = await fetchProducts({
      url: target,
      count: count ?? cfg.batch,
      mode: mode || cfg.mode,
      offset: cfg.offset,
    });

    const stat = importItems(items, { source: 'mock' });
    const latency = Date.now() - started;

    // 数据变了就重算补货建议与预警
    let recomputed = null;
    try {
      const sync = require('./sync');
      sync.markDirty();
      recomputed = sync.recompute({ force: true });
    } catch (err) {
      console.error('[datasource] 补货重算失败:', err.message);
    }

    const result = {
      ok: true,
      source: target,
      at: new Date().toISOString(),
      latency_ms: latency,
      fetched: items.length,
      request_id: meta ? meta.request_id : null,
      mode: mode || cfg.mode,
      created: stat.created,
      updated: stat.updated,
      salesBackfilled: stat.salesBackfilled,
      stockDelta: stat.stockDelta,
      skipped: stat.skipped,
      // 新上架商品清单：chaos 模式（新商品上架演示）靠它告诉用户「哪些是新的」
      created_items: stat.createdItems,
      // 入库后的商品总数：直接由同一次事务后的查询给出，
      // 前端不必再发一次状态请求，避免两次请求之间的时序差导致数字对不上。
      total: get('SELECT COUNT(*) AS c FROM products').c,
      imported_total: get("SELECT COUNT(*) AS c FROM products WHERE sku LIKE 'MOCK-%'").c,
      suggestions: recomputed ? recomputed.suggestions : null,
      alerts: recomputed ? recomputed.alerts : null,
    };
    runtime.lastPullAt = result.at;
    runtime.lastResult = result;
    runtime.lastError = null;
    logSync({
      status: 'success',
      latency,
      payload: {
        fetched: items.length,
        created: stat.created,
        updated: stat.updated,
        request_id: meta ? meta.request_id : null,
      },
    });
    return result;
  } catch (err) {
    const latency = Date.now() - started;
    const result = {
      ok: false,
      source: target,
      at: new Date().toISOString(),
      latency_ms: latency,
      error: err.message,
    };
    runtime.lastPullAt = result.at;
    runtime.lastError = err.message;
    logSync({ status: 'error', latency, payload: { error: err.message } });
    return result;
  }
}

// ---------------------------------------------------------------- 单商品对照

/** 从数据源查询单个商品的原始记录（GET /api/products/:item_id） */
async function fetchItemDetail(itemId, { url, timeout = 4000 } = {}) {
  const cfg = getConfig();
  const base = (url || cfg.url).replace(/\/+$/, '');
  const id = String(itemId || '').trim();
  if (!id) throw new Error('缺少商品编号');
  const data = await requestJson(`${base}/api/products/${encodeURIComponent(id)}`, { timeout, retries: 0 });
  if (!data || data.ok !== true || !data.item) {
    throw new Error((data && (data.error || data.hint)) || '数据源未返回商品数据');
  }
  return { item: data.item, meta: data.meta || null, base };
}

/**
 * 上游原始值 vs 主系统本地值的逐字段对照
 *
 * 演示意义：这是「数据确实来自数据源」最直接的证据。
 * 同步刚完成时差异应全为 0；随着数据源继续演进，上游库存会下降，
 * 差异开始出现——正好说明"该再同步一次了"。
 */
async function itemDetail(itemId, { url } = {}) {
  const id = String(itemId || '').trim();
  if (!id) throw new Error('缺少商品编号');

  const local = get(
    `SELECT p.id, p.sku, p.name, p.category, p.suggest_price,
            COALESCE(SUM(i.stock), 0) AS stock,
            (SELECT COALESCE(SUM(qty), 0) FROM sales_history s
              WHERE s.product_id = p.id AND s.sale_date >= date('now','-30 day')) AS sales_30d,
            d.imported_at
     FROM products p
     LEFT JOIN platform_inventory i ON i.product_id = p.id
     LEFT JOIN ds_product_snapshots d ON d.sku = p.sku
     WHERE p.sku = ?
     GROUP BY p.id`,
    id
  );

  const { item: upstream, meta, base } = await fetchItemDetail(id, { url });

  const diff = local
    ? {
        stock: upstream.stock - Number(local.stock || 0),
        sales: upstream.sales - Number(local.sales_30d || 0),
        price: round2(upstream.price - Number(local.suggest_price || 0)),
      }
    : null;

  return {
    ok: true,
    item_id: id,
    source: base,
    upstream,
    meta,
    local: local || null,
    diff,
    at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- 定时同步

function startAuto() {
  stopAuto();
  const cfg = getConfig();
  if (!cfg.enabled) return null;
  runtime.timer = setInterval(async () => {
    const r = await pull();
    if (r.ok) console.log(`[datasource] 自动同步完成：${r.fetched} 条，${r.latency_ms}ms`);
    else console.warn(`[datasource] 自动同步失败：${r.error}`);
  }, cfg.interval * 1000);
  runtime.timer.unref?.();
  console.log(`[datasource] 已启动定时同步，每 ${cfg.interval}s 拉取一次 ${cfg.url}`);
  return runtime.timer;
}

function stopAuto() {
  if (runtime.timer) {
    clearInterval(runtime.timer);
    runtime.timer = null;
  }
}

// ---------------------------------------------------------------- 维护

/** 查询已接入的外部商品 */
function listImported(limit = 300) {
  return all(
    `SELECT p.id, p.sku, p.name, p.category, p.suggest_price,
            COALESCE(SUM(i.stock),0) AS stock,
            (SELECT COALESCE(SUM(qty),0) FROM sales_history s
              WHERE s.product_id = p.id AND s.sale_date >= date('now','-30 day')) AS sales_30d,
            d.imported_at
     FROM products p
     LEFT JOIN platform_inventory i ON i.product_id = p.id
     LEFT JOIN ds_product_snapshots d ON d.sku = p.sku
     WHERE p.sku LIKE 'MOCK-%'
     GROUP BY p.id ORDER BY d.imported_at DESC, p.id DESC LIMIT ?`,
    limit
  );
}

/** 清除所有外部接入的商品（用于恢复干净的演示数据） */
function clearImported() {
  const rows = all("SELECT id FROM products WHERE sku LIKE 'MOCK-%'");
  if (rows.length === 0) return { removed: 0 };
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  tx(() => {
    // 采购明细的外键没有级联删除，必须先清理，否则会因约束失败
    run(`DELETE FROM purchase_order_items WHERE product_id IN (${placeholders})`, ...ids);
    run(`DELETE FROM purchase_orders WHERE id NOT IN (SELECT DISTINCT order_id FROM purchase_order_items)`);
    run(`DELETE FROM products WHERE id IN (${placeholders})`, ...ids);
    run("DELETE FROM ds_product_snapshots");
  });

  try {
    const sync = require('./sync');
    sync.markDirty();
    sync.recompute({ force: true });
  } catch (_) { /* 清理后的重算失败不影响清理结果 */ }

  return { removed: ids.length };
}

/** 汇总状态供前端展示 */
async function status({ withHealth = true } = {}) {
  const cfg = getConfig();
  const imported = get("SELECT COUNT(*) AS c FROM products WHERE sku LIKE 'MOCK-%'").c;
  const total = get('SELECT COUNT(*) AS c FROM products').c;

  // 健康探测结果缓存 10 秒，避免页面每次刷新都打外部服务
  let health = runtime.health;
  if (withHealth && (!health || Date.now() - runtime.healthAt > 10000)) {
    health = await checkHealth(cfg.url, { timeout: 2500 });
    runtime.health = health;
    runtime.healthAt = Date.now();
  }

  // 服务重启后内存状态为空，但数据库里仍有历史同步记录。
  // 回填最近一次结果，避免出现「已接入 12 个商品，却显示从未同步过」的矛盾。
  if (!runtime.lastResult) {
    const last = get(
      `SELECT latency_ms, payload, created_at FROM sync_logs
       WHERE event_type = 'datasource.pull' AND status = 'success'
       ORDER BY id DESC LIMIT 1`
    );
    if (last) {
      try {
        const payload = JSON.parse(last.payload || '{}');
        runtime.lastResult = { ...payload, latency_ms: last.latency_ms, at: last.created_at };
        runtime.lastPullAt = last.created_at;
      } catch (_) { /* 历史日志格式异常时忽略 */ }
    }
  }

  return {
    config: cfg,
    health: health || { online: false, error: '尚未探测' },
    runtime: {
      last_pull_at: runtime.lastPullAt,
      last_result: runtime.lastResult,
      last_error: runtime.lastError,
      auto_running: Boolean(runtime.timer),
    },
    products: { imported, total },
    recent_logs: all(
      `SELECT event_type, status, latency_ms, payload, created_at FROM sync_logs
       WHERE event_type = 'datasource.pull' ORDER BY id DESC LIMIT 10`
    ),
  };
}

module.exports = {
  getConfig,
  checkHealth,
  fetchProducts,
  fetchItemDetail,
  itemDetail,
  pull,
  importItems,
  startAuto,
  stopAuto,
  listImported,
  clearImported,
  status,
  DEFAULTS,
};
