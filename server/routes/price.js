'use strict';
/**
 * 价格采集与对比接口
 * 「爬取各方售价 → 与进货价对比 → 得到毛利结构」是补货决策的资金侧依据
 */
const express = require('express');
const { all, get } = require('../db');
const { crawlAll, crawlProductPrices, getPriceComparison } = require('../services/crawler');
const { invalidateDashboard } = require('./dashboard');

const router = express.Router();

/** 价格对比总表 */
router.get('/comparison', (req, res) => {
  const productId = req.query.productId ? Number(req.query.productId) : null;
  const rows = getPriceComparison(productId);
  const summary = {
    products: rows.length,
    avgMargin: rows.length
      ? Math.round((rows.reduce((s, r) => s + r.avgGrossMargin, 0) / rows.length) * 100) / 100
      : 0,
    anomalyCount: rows.filter((r) => r.anomaly).length,
    liveCount: rows.reduce((s, r) => s + r.platforms.filter((p) => p.source === 'live').length, 0),
  };
  res.json({ list: rows, summary });
});

/** 触发采集：默认模拟模式；live=true 时尝试真实抓取商品页 */
router.post('/crawl', async (req, res) => {
  const useLive = req.body && req.body.live === true;
  const productId = req.body && req.body.productId ? Number(req.body.productId) : null;
  try {
    if (productId) {
      const r = await crawlProductPrices(productId, useLive);
      invalidateDashboard();
      return res.json({ ok: true, mode: useLive ? 'live' : 'simulated', results: r.results });
    }
    const r = await crawlAll(useLive);
    invalidateDashboard();
    res.json({ ok: true, mode: useLive ? 'live' : 'simulated', ...r });
  } catch (err) {
    res.status(500).json({ error: `采集失败：${err.message}` });
  }
});

/** 单商品价格历史曲线 */
router.get('/history/:productId', (req, res) => {
  const id = Number(req.params.productId);
  const rows = all(
    `SELECT ps.captured_at, ps.price, ps.competitor, ps.source, pl.name AS platform_name, pl.code, pl.color
     FROM price_snapshots ps JOIN platforms pl ON pl.id = ps.platform_id
     WHERE ps.product_id = ? AND ps.captured_at >= datetime('now','-14 day')
     ORDER BY ps.captured_at ASC`,
    id
  );
  const product = get('SELECT id, sku, name, purchase_price, suggest_price FROM products WHERE id = ?', id);
  if (!product) return res.status(404).json({ error: '商品不存在' });

  // 按平台聚合为多条折线
  const platforms = [...new Set(rows.map((r) => r.platform_name))];
  const times = [...new Set(rows.map((r) => r.captured_at))];
  const series = platforms.map((name) => {
    const sample = rows.find((r) => r.platform_name === name);
    return {
      name,
      color: sample ? sample.color : '#38BDF8',
      data: times.map((t) => {
        const hit = rows.find((r) => r.platform_name === name && r.captured_at === t);
        return hit ? hit.price : null;
      }),
    };
  });

  res.json({
    product,
    times,
    series,
    cost: product.purchase_price,
    suggestPrice: product.suggest_price,
  });
});

module.exports = router;
