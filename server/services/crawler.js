'use strict';
/**
 * 价格采集器
 *
 * 双模式设计：
 *  1) simulated（默认）：基于商品基准价 × 平台价格系数 + 随机漂移，生成价格快照。
 *     用于无外网/被反爬时的演示，保证系统可离线完整运行。
 *  2) live：若商品配置了真实商品页 URL（platform_inventory.listing_url），
 *     则用 fetch 抓取页面并从 HTML / JSON-LD 中解析价格。抓取失败自动回落模拟值，
 *     并在 source 字段标记，前端可区分数据来源。
 *
 * 采集后同时计算：毛利、毛利率、跨平台价差，供「爬价对比进货」决策使用。
 */
const { all, get, run, getSettings } = require('../db');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 从 HTML 中尽量提取价格（JSON-LD → itemprop → 常见 class） */
function parsePriceFromHtml(html) {
  const patterns = [
    /"price"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/i,
    /itemprop=["']price["'][^>]*content=["']([0-9]+(?:\.[0-9]{1,2})?)["']/i,
    /"lowPrice"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/i,
    /class=["'][^"']*(?:price|Price)[^"']*["'][^>]*>\s*[¥￥$]?\s*([0-9]+(?:\.[0-9]{1,2})?)/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const val = Number(m[1]);
      if (Number.isFinite(val) && val > 0 && val < 1000000) return Math.round(val * 100) / 100;
    }
  }
  return null;
}

/** 抓取真实页面价格，8 秒超时；失败返回 null 由调用方回落 */
async function fetchLivePrice(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;
    // 限制读取体积，避免大页面拖垮服务
    const reader = res.body?.getReader();
    let html = '';
    const decoder = new TextDecoder('utf-8');
    const MAX = 400 * 1024;
    if (reader) {
      let size = 0;
      while (size < MAX) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        html += decoder.decode(value, { stream: true });
      }
      try { await reader.cancel(); } catch (_) { /* 忽略取消异常 */ }
    } else {
      html = await res.text();
    }
    return parsePriceFromHtml(html);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 模拟价格：基准价 × 平台系数 × 随时间漂移 × 促销概率 */
function simulatePrice(product, platform) {
  const base = product.suggest_price * platform.price_factor;
  // 以小时为粒度的确定性漂移，避免同一时刻反复采集价格乱跳
  const hourSeed = Math.floor(Date.now() / 3600000);
  const pseudo = Math.abs(Math.sin(product.id * 12.9898 + platform.id * 78.233 + hourSeed * 0.371)) % 1;
  const drift = 1 + (pseudo - 0.5) * 0.06;         // ±3% 漂移
  const promo = pseudo > 0.93 ? 0.88 : 1;           // 7% 概率模拟大促降价
  const price = base * drift * promo;
  const competitor = price * (0.86 + ((pseudo * 7) % 1) * 0.28); // 竞品价 ±14%
  return {
    price: Math.round(price * 100) / 100,
    competitor: Math.round(competitor * 100) / 100,
  };
}

/**
 * 采集单个商品在所有平台的价格
 * @param {number} productId
 * @param {boolean} useLive 是否尝试真实抓取
 */
async function crawlProductPrices(productId, useLive = false) {
  const product = get('SELECT * FROM products WHERE id = ?', productId);
  if (!product) throw new Error('商品不存在');

  const inventories = all(
    `SELECT i.*, pl.id AS pid, pl.code, pl.name, pl.price_factor
     FROM platform_inventory i JOIN platforms pl ON pl.id = i.platform_id
     WHERE i.product_id = ?`,
    productId
  );

  const results = [];
  for (const inv of inventories) {
    let price = null;
    let competitor = null;
    let source = 'simulated';

    if (useLive && inv.listing_url) {
      price = await fetchLivePrice(inv.listing_url);
      if (price != null) source = 'live';
    }

    const sim = simulatePrice(product, { id: inv.pid, price_factor: inv.price_factor });
    if (price == null) {
      price = sim.price;
      competitor = sim.competitor;
    } else {
      // 真实价格到手后，竞品价以该价为基准做行业区间估算
      competitor = Math.round(price * (0.86 + Math.random() * 0.28) * 100) / 100;
    }

    const marketPrice = Math.round(product.suggest_price * 1.15 * 100) / 100;

    run(
      `INSERT INTO price_snapshots(product_id, platform_id, price, market_price, competitor, source, captured_at)
       VALUES(?,?,?,?,?,?, datetime('now','localtime'))`,
      productId, inv.pid, price, marketPrice, competitor, source
    );
    // 同步更新平台挂牌价，保证看板与采集结果一致
    run('UPDATE platform_inventory SET price = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?', price, inv.id);

    results.push({
      platformId: inv.pid,
      platformCode: inv.code,
      platformName: inv.name,
      price,
      competitor,
      source,
      grossProfit: Math.round((price - product.purchase_price) * 100) / 100,
      grossMargin: Math.round(((price - product.purchase_price) / price) * 10000) / 100,
    });
  }

  return { product, results };
}

/** 批量采集（默认只采在售商品，可限制数量避免阻塞） */
async function crawlAll(useLive = false, limit = 50) {
  const products = all("SELECT id FROM products WHERE status = 'on_sale' ORDER BY id LIMIT ?", limit);
  let ok = 0;
  let live = 0;
  for (const p of products) {
    try {
      const r = await crawlProductPrices(p.id, useLive);
      ok += 1;
      if (r.results.some((x) => x.source === 'live')) live += 1;
    } catch (_) {
      /* 单商品失败不影响整批 */
    }
  }
  return { total: products.length, ok, liveSources: live };
}

/**
 * 价格对比分析：把「平台售价 / 竞品价 / 进货价」拉到一起，
 * 输出每个商品的毛利结构与价格异常提示，这是采购决策的核心视图。
 */
function getPriceComparison(productId = null) {
  const where = productId ? 'WHERE p.id = ?' : '';
  const params = productId ? [productId] : [];
  const products = all(
    `SELECT p.id, p.sku, p.name, p.category, p.purchase_price, p.suggest_price, p.unit,
            s.name AS supplier_name
     FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
     ${where} ORDER BY p.id`,
    ...params
  );

  return products.map((p) => {
    // 取每个平台最近一次快照
    const rows = all(
      `SELECT ps.*, pl.name AS platform_name, pl.code
       FROM price_snapshots ps JOIN platforms pl ON pl.id = ps.platform_id
       WHERE ps.product_id = ?
         AND ps.captured_at = (SELECT MAX(captured_at) FROM price_snapshots
                               WHERE product_id = ps.product_id AND platform_id = ps.platform_id)
       ORDER BY pl.id`,
      p.id
    );
    const prices = rows.map((r) => r.price).filter((v) => Number.isFinite(v) && v > 0);
    const max = prices.length ? Math.max(...prices) : 0;
    const min = prices.length ? Math.min(...prices) : 0;
    const avg = prices.length ? prices.reduce((s, v) => s + v, 0) / prices.length : 0;
    const spread = avg > 0 ? ((max - min) / avg) * 100 : 0;

    const platforms = rows.map((r) => ({
      platformId: r.platform_id,
      platformName: r.platform_name,
      code: r.code,
      price: r.price,
      competitor: r.competitor,
      marketPrice: r.market_price,
      source: r.source,
      capturedAt: r.captured_at,
      grossProfit: Math.round((r.price - p.purchase_price) * 100) / 100,
      grossMargin: r.price > 0 ? Math.round(((r.price - p.purchase_price) / r.price) * 10000) / 100 : 0,
      vsCompetitor: r.competitor > 0 ? Math.round(((r.price - r.competitor) / r.competitor) * 10000) / 100 : null,
    }));

    // 价格异常判定：阈值按电商实务设定——
    // 跨平台价差 22% 以上才视为乱价风险（各平台定价系数本就存在 10%+ 差异）；
    // 高于竞品 12% 以上才提示转化风险，避免正常价差造成告警疲劳。
    let anomaly = null;
    if (spread > 22) anomaly = `跨平台价差 ${spread.toFixed(1)}%，存在乱价/窜货风险`;
    const cheap = platforms.find((x) => x.vsCompetitor != null && x.vsCompetitor > 12);
    if (cheap) anomaly = `${cheap.platformName} 售价比竞品高 ${cheap.vsCompetitor.toFixed(1)}%，转化可能受影响`;

    return {
      productId: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      unit: p.unit,
      supplierName: p.supplier_name,
      purchasePrice: p.purchase_price,
      suggestPrice: p.suggest_price,
      platforms,
      minPrice: min,
      maxPrice: max,
      avgPrice: Math.round(avg * 100) / 100,
      spread: Math.round(spread * 100) / 100,
      avgGrossMargin: avg > 0 ? Math.round(((avg - p.purchase_price) / avg) * 10000) / 100 : 0,
      anomaly,
    };
  });
}

module.exports = { crawlProductPrices, crawlAll, getPriceComparison, parsePriceFromHtml, simulatePrice };
