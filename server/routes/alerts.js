'use strict';
/**
 * 预警中心接口
 */
const express = require('express');
const { all, get, run } = require('../db');
const { scanAlerts, listAlerts, alertStats } = require('../services/alerts');
const { invalidateDashboard } = require('./dashboard');

const router = express.Router();

router.get('/', (req, res) => {
  const { level = 'all', status = 'open', limit = 100 } = req.query;
  res.json({
    list: listAlerts({ level, status, limit: Number(limit) || 100 }),
    stats: alertStats(),
  });
});

/** 手动触发全量扫描 */
router.post('/scan', (req, res) => {
  const result = scanAlerts();
  invalidateDashboard();
  res.json({ ok: true, created: result.created, items: result.items, stats: alertStats() });
});

/** 关闭单条预警 */
router.patch('/:id/close', (req, res) => {
  const id = Number(req.params.id);
  const row = get('SELECT * FROM alerts WHERE id = ?', id);
  if (!row) return res.status(404).json({ error: '预警不存在' });
  run("UPDATE alerts SET status='closed' WHERE id = ?", id);
  invalidateDashboard();
  res.json({ ok: true, stats: alertStats() });
});

/** 全部关闭 */
router.post('/close-all', (req, res) => {
  run("UPDATE alerts SET status='closed' WHERE status='open'");
  invalidateDashboard();
  res.json({ ok: true, stats: alertStats() });
});

module.exports = router;
