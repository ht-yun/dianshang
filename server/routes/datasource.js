'use strict';
/**
 * 数据源接入路由
 *
 * 提供双系统联动的全部操作：配置、连通性探测、手动同步、定时同步开关、
 * 已接入商品清单与清理。所有接口失败都以结构化 JSON 返回，不抛 500。
 */
const express = require('express');
const ds = require('../services/datasource');
const sync = require('../services/sync');
const { saveSettings } = require('../db');

const router = express.Router();

/** 校验数据源地址：只允许 http(s)，防止误填成 file:// 之类的怪异协议 */
function validUrl(input) {
  try {
    const u = new URL(String(input));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/** 内部订单模拟引擎的启停：数据源接管后必须停掉，避免两套库存来源互相覆盖 */
function applyEngineState(enabled) {
  if (enabled) {
    sync.stopEngine();
  } else {
    sync.startEngine({ orderInterval: process.env.SIM_ORDER_INTERVAL || 15 });
  }
}

// ---- 总览状态：前端页面首屏数据来源 ----
router.get('/', async (req, res) => {
  try {
    res.json(await ds.status());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- 探测任意地址的连通性（用于保存前先测一下）----
router.get('/health', async (req, res) => {
  const cfg = ds.getConfig();
  const url = String(req.query.url || cfg.url).replace(/\/+$/, '');
  if (!validUrl(url)) return res.status(400).json({ error: '数据源地址必须是 http:// 或 https:// 开头' });
  res.json(await ds.checkHealth(url));
});

// ---- 保存配置 ----
router.post('/config', (req, res) => {
  const body = req.body || {};
  const pairs = {};

  if (body.url !== undefined) {
    const url = String(body.url).trim().replace(/\/+$/, '');
    if (!validUrl(url)) return res.status(400).json({ error: '数据源地址必须是 http:// 或 https:// 开头' });
    pairs.datasource_url = url;
  }
  if (body.mode !== undefined) {
    if (!['pool', 'stable', 'chaos'].includes(body.mode)) {
      return res.status(400).json({ error: 'mode 只能是 pool / stable / chaos' });
    }
    pairs.datasource_mode = body.mode;
  }
  if (body.batch !== undefined) {
    const n = Number(body.batch);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return res.status(400).json({ error: '单次拉取条数需在 1~100 之间' });
    }
    pairs.datasource_batch = String(Math.round(n));
  }
  if (body.offset !== undefined) {
    const n = Number(body.offset);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'offset 必须是非负整数' });
    pairs.datasource_offset = String(Math.round(n));
  }
  if (body.interval !== undefined) {
    const n = Number(body.interval);
    if (!Number.isFinite(n) || n < 10 || n > 3600) {
      return res.status(400).json({ error: '同步间隔需在 10~3600 秒之间' });
    }
    pairs.datasource_interval = String(Math.round(n));
  }
  if (body.enabled !== undefined) {
    pairs.datasource_enabled = body.enabled ? '1' : '0';
  }

  saveSettings(pairs);

  // 间隔或开关变化后需要重建定时器
  const cfg = ds.getConfig();
  if (pairs.datasource_enabled !== undefined || pairs.datasource_interval !== undefined) {
    ds.stopAuto();
    applyEngineState(cfg.enabled);
    if (cfg.enabled) ds.startAuto();
  }
  res.json({ ok: true, message: '配置已保存', config: ds.getConfig() });
});

// ---- 连通性测试 + 抽样预览（不写库）----
router.post('/test', async (req, res) => {
  const body = req.body || {};
  const cfg = ds.getConfig();
  const url = String(body.url || cfg.url).replace(/\/+$/, '');
  if (!validUrl(url)) return res.status(400).json({ error: '数据源地址必须是 http:// 或 https:// 开头' });

  const health = await ds.checkHealth(url);
  if (!health.online) return res.json({ ok: false, health });

  try {
    const { fetchProducts } = ds;
    // 抽样只取 3 条，快速展示字段结构
    const { items, meta } = await fetchProducts({ url, count: 3, mode: body.mode || cfg.mode });
    res.json({ ok: true, health, sample: items, meta });
  } catch (err) {
    res.json({ ok: false, health, error: err.message });
  }
});

// ---- 手动触发一次同步 ----
router.post('/pull', async (req, res) => {
  const body = req.body || {};
  const cfg = ds.getConfig();
  const count = body.count !== undefined ? Number(body.count) : undefined;
  if (count !== undefined && (!Number.isFinite(count) || count < 1 || count > 100)) {
    return res.status(400).json({ error: 'count 需在 1~100 之间' });
  }

  const result = await ds.pull({ count, mode: body.mode });
  if (!result.ok) return res.status(502).json(result);
  res.json(result);
});

// ---- 已接入的外部商品 ----
router.get('/products', (req, res) => {
  const list = ds.listImported(Number(req.query.limit) || 200);
  res.json({ total: list.length, list });
});

// ---- 上游原始值 vs 本地值对照（证明库存/销量确实来自数据源）----
router.get('/upstream/:sku', async (req, res) => {
  try {
    res.json(await ds.itemDetail(req.params.sku));
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ---- 清除外部接入商品 ----
router.post('/clear', (req, res) => {
  try {
    const r = ds.clearImported();
    res.json({ ok: true, ...r, message: r.removed ? `已清除 ${r.removed} 个仿真商品` : '没有需要清除的仿真商品' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
