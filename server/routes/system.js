'use strict';
/**
 * 系统接口：算法参数配置、自定义公式校验、同步控制、日志
 */
const express = require('express');
const { all, get, getSettings, saveSettings } = require('../db');
const { validate } = require('../lib/expression');
const sync = require('../services/sync');
const { invalidateDashboard } = require('./dashboard');

const router = express.Router();

/** 参数合法区间，防止误填导致算法异常 */
const RULES = {
  service_level: { min: 0.5, max: 0.999, type: 'number', label: '服务水平' },
  forecast_window: { min: 7, max: 90, type: 'int', label: '预测窗口' },
  safety_days: { min: 1, max: 60, type: 'int', label: '兜底安全天数' },
  cover_days: { min: 1, max: 120, type: 'int', label: '默认覆盖天数' },
  auto_order_threshold: { min: 0, max: 1, type: 'number', label: '自动下单阈值' },
  sync_interval: { min: 5, max: 3600, type: 'int', label: '同步间隔' },
  price_crawl_interval: { min: 30, max: 86400, type: 'int', label: '采集间隔' },
  alert_overstock_days: { min: 30, max: 365, type: 'int', label: '积压阈值' },
  alert_slow_days: { min: 7, max: 365, type: 'int', label: '滞销阈值' },
};

const FORMULA_VARS = {
  available: 186, in_transit: 0, avg_daily: 87.7, demand_std: 28.4, lead_time: 7,
  safety_stock: 183, reorder_point: 798, cover_days: 14, moq: 50, eoq: 1861,
  stock_days: 2.1, target_stock: 2025, service_z: 1.645,
};

router.get('/settings', (req, res) => {
  res.json({
    settings: getSettings(),
    rules: RULES,
    formulaVars: Object.keys(FORMULA_VARS),
  });
});

router.put('/settings', (req, res) => {
  const body = req.body || {};
  const errors = [];
  const updates = {};

  for (const [key, rule] of Object.entries(RULES)) {
    if (body[key] === undefined || body[key] === '') continue;
    const num = Number(body[key]);
    if (!Number.isFinite(num)) { errors.push(`${rule.label} 必须是数字`); continue; }
    if (num < rule.min || num > rule.max) {
      errors.push(`${rule.label} 需介于 ${rule.min} ~ ${rule.max} 之间`);
      continue;
    }
    updates[key] = rule.type === 'int' ? Math.round(num) : num;
  }

  // 布尔开关
  for (const key of ['auto_replenish', 'custom_formula_enabled']) {
    if (body[key] !== undefined) updates[key] = String(body[key]) === '1' || body[key] === true ? '1' : '0';
  }

  // 自定义公式：必须能通过安全求值器
  if (body.custom_formula !== undefined && String(body.custom_formula).trim() !== '') {
    const result = validate(String(body.custom_formula), FORMULA_VARS);
    if (!result.ok) errors.push(`自定义公式错误：${result.error}`);
    else updates.custom_formula = String(body.custom_formula).trim();
  }

  if (body.forecast_weights !== undefined) {
    const parts = String(body.forecast_weights).split(',').map((x) => Number(x.trim()));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
      errors.push('预测权重需为 3 个非负数字，用英文逗号分隔');
    } else {
      const sum = parts.reduce((s, v) => s + v, 0);
      if (Math.abs(sum - 1) > 0.001) {
        // 自动归一化，避免用户困惑
        updates.forecast_weights = parts.map((n) => Math.round((n / sum) * 1000) / 1000).join(',');
      } else {
        updates.forecast_weights = parts.join(',');
      }
    }
  }

  if (errors.length) return res.status(400).json({ error: errors.join('；'), errors });

  if (Object.keys(updates).length) {
    saveSettings(updates);
    invalidateDashboard();
  }

  // 参数变更后立即按新参数重算补货建议
  try {
    sync.markDirty();
    sync.recompute({ force: true });
  } catch (_) { /* 重算失败不影响保存结果 */ }

  res.json({ ok: true, settings: getSettings(), updated: Object.keys(updates) });
});

/** 单独校验自定义公式（前端边输边校验） */
router.post('/settings/validate-formula', (req, res) => {
  const formula = String(req.body.formula || '');
  if (!formula.trim()) return res.json({ ok: false, error: '公式不能为空' });
  const result = validate(formula, FORMULA_VARS);
  res.json({
    ...result,
    vars: FORMULA_VARS,
    sample: result.ok ? Math.round(result.value) : null,
  });
});

/** 同步日志 */
router.get('/sync/logs', (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const logs = all(
    `SELECT l.*, pl.name AS platform_name, pl.color
     FROM sync_logs l LEFT JOIN platforms pl ON pl.id = l.platform_id
     ORDER BY l.id DESC LIMIT ?`,
    limit
  );
  const stats = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
            ROUND(AVG(latency_ms), 0) AS avgLatency
     FROM (SELECT * FROM sync_logs ORDER BY id DESC LIMIT 500)`
  );
  res.json({ list: logs, stats });
});

/** 手动触发全渠道库存同步 */
router.post('/sync/now', (req, res) => {
  const result = sync.syncAllPlatforms();
  invalidateDashboard();
  res.json({ ok: true, ...result, at: new Date().toLocaleString('zh-CN') });
});

/** 模拟一笔平台订单（演示实时事件流） */
router.post('/sync/simulate-order', (req, res) => {
  const evt = sync.randomOrderEvent();
  if (!evt) return res.status(400).json({ error: '没有可用的库存产生订单' });
  sync.markDirty();
  invalidateDashboard();
  res.json({ ok: true, event: evt });
});

/** 系统元信息与算法说明 */
router.get('/meta', (req, res) => {
  res.json({
    name: '电商智能库存补货系统',
    version: '1.0.0',
    runtime: `Node ${process.version}`,
    database: 'SQLite (node:sqlite)',
    algorithm: {
      forecast: 'Holt 双参数指数平滑 + 加权移动平均融合',
      safetyStock: 'SS = z·√(L·σd² + d̄²·σL²)',
      reorderPoint: 'ROP = d̄·L + SS',
      replenishQty: 'Q = Target − 可用 − 在途，按 MOQ 向上取整',
      eoq: 'EOQ = √(2·D·S/H)',
    },
    formulaVars: FORMULA_VARS,
    formulaExample: 'avg_daily * (lead_time + cover_days) + safety_stock - available - in_transit',
  });
});

module.exports = router;
