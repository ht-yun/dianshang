'use strict';
/**
 * 商品与库存接口
 */
const express = require('express');
const { all, get, run, getSettings } = require('../db');
const { computeSuggestion, getStockInfo } = require('../services/replenish');
const { forecastDemand, getDailySeries } = require('../services/forecast');
const { invalidateDashboard } = require('./dashboard');

const router = express.Router();

/** 商品列表：库存、健康状态、在途、毛利一屏可见 */
router.get('/', (req, res) => {
  const { category, keyword, health } = req.query;
  const settings = getSettings();
  const cond = [];
  const params = [];
  if (category && category !== 'all') { cond.push('p.category = ?'); params.push(category); }
  if (keyword) { cond.push('(p.name LIKE ? OR p.sku LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const products = all(
    `SELECT p.*, s.name AS supplier_name, s.lead_time_std
     FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
     ${where} ORDER BY p.id`,
    ...params
  );

  let list = products.map((p) => {
    const r = computeSuggestion(p, settings);
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      brand: p.brand,
      unit: p.unit,
      purchasePrice: p.purchase_price,
      suggestPrice: p.suggest_price,
      supplierId: p.supplier_id,
      supplierName: p.supplier_name,
      leadTimeDays: p.lead_time_days,
      coverDays: r.coverDays,
      moq: p.moq,
      totalStock: r.totalStock,
      available: r.available,
      inTransit: r.inTransit,
      avgDaily: r.avgDaily,
      stockDays: r.stockDays,
      safetyStock: r.safetyStock,
      reorderPoint: r.reorderPoint,
      health: r.health,
      urgency: r.urgency,
      suggestQty: r.suggestQty,
      grossMargin: r.suggestPrice > 0 ? Math.round(((r.suggestPrice - p.purchase_price) / r.suggestPrice) * 10000) / 100 : 0,
      trend: r.trend,
    };
  });

  if (health && health !== 'all') list = list.filter((x) => x.health === health);

  const categories = all('SELECT DISTINCT category AS name FROM products ORDER BY category').map((r) => r.name);
  res.json({ list, categories, total: list.length });
});

/** 商品详情：含平台分布、销售曲线、预测、价格历史 */
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const p = get(
    `SELECT p.*, s.name AS supplier_name, s.contact, s.phone, s.lead_time_std, s.payment_terms
     FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?`,
    id
  );
  if (!p) return res.status(404).json({ error: '商品不存在' });

  const settings = getSettings();
  const calc = computeSuggestion(p, settings);
  const stock = getStockInfo(id);
  const series = getDailySeries(id, 90);
  const fc = forecastDemand(id, { window: Number(settings.forecast_window) || 30 });

  const priceHistory = all(
    `SELECT ps.captured_at, ps.price, ps.competitor, ps.source, pl.name AS platform_name, pl.code
     FROM price_snapshots ps JOIN platforms pl ON pl.id = ps.platform_id
     WHERE ps.product_id = ? AND ps.captured_at >= datetime('now','-14 day')
     ORDER BY ps.captured_at ASC`,
    id
  );

  const movements = all(
    `SELECT m.*, pl.name AS platform_name FROM stock_movements m
     LEFT JOIN platforms pl ON pl.id = m.platform_id
     WHERE m.product_id = ? ORDER BY m.created_at DESC LIMIT 20`,
    id
  );

  res.json({
    product: {
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      brand: p.brand,
      unit: p.unit,
      purchasePrice: p.purchase_price,
      suggestPrice: p.suggest_price,
      leadTimeDays: p.lead_time_days,
      safetyDays: p.safety_days,
      coverDays: p.cover_days,
      moq: p.moq,
      supplierName: p.supplier_name,
      supplierContact: p.contact,
      supplierPhone: p.phone,
      paymentTerms: p.payment_terms,
    },
    calc,
    platforms: stock.platforms.map((x) => ({
      platformId: x.platform_id,
      name: x.platform_name,
      code: x.platform_code,
      color: x.color,
      stock: x.stock,
      locked: x.locked,
      price: x.price,
      updatedAt: x.updated_at,
    })),
    series,
    forecast: fc.forecastSeries,
    priceHistory,
    movements,
  });
});

/** 更新商品补货参数（安全天数 / 覆盖天数 / MOQ / 提前期） */
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const p = get('SELECT * FROM products WHERE id = ?', id);
  if (!p) return res.status(404).json({ error: '商品不存在' });

  const fields = {
    safety_days: req.body.safetyDays,
    cover_days: req.body.coverDays,
    moq: req.body.moq,
    lead_time_days: req.body.leadTimeDays,
  };
  const sets = [];
  const params = [];
  for (const [col, val] of Object.entries(fields)) {
    if (val === undefined || val === null || val === '') continue;
    const num = Number(val);
    if (!Number.isFinite(num) || num < 1) {
      return res.status(400).json({ error: `${col} 必须为正整数` });
    }
    sets.push(`${col} = ?`);
    params.push(Math.round(num));
  }
  if (!sets.length) return res.status(400).json({ error: '没有需要更新的字段' });

  run(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  invalidateDashboard();
  res.json({ ok: true, product: get('SELECT * FROM products WHERE id = ?', id) });
});

/** 平台与供应商字典 */
router.get('/meta/dict', (req, res) => {
  res.json({
    platforms: all('SELECT * FROM platforms ORDER BY id'),
    suppliers: all('SELECT * FROM suppliers ORDER BY id'),
  });
});

module.exports = router;
