'use strict';
/**
 * 仿真数据服务 - HTTP 入口
 *
 * 独立进程、零第三方依赖（只用 node:http），不依赖主系统、不连数据库、不联网。
 * 启动：npm start  或  node src/server.js
 *
 * 对外接口一栏：
 *   GET  /                     浏览器调试控制台
 *   GET  /api/health           健康检查（主系统用它做连通性探测）
 *   GET  /api/schema           字段契约（后续替换真实 API 时按此对齐）
 *   GET  /api/categories       可用品类清单
 *   GET  /api/stats            生成器运行统计
 *   GET  /api/products         生成一批随机商品数据 ★核心接口
 *   POST /api/products         同上，参数走 JSON body
 *   GET  /api/products/:id     查询单个商品（含 30 日逐日销量）
 *   GET  /api/products/stream  SSE 持续推送
 *   POST /api/reset            重置商品池
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const cfg = require('./config');
const { ProductGenerator } = require('./generator');
const { CATEGORIES } = require('./catalog');

const generator = new ProductGenerator();
const startedAt = Date.now();

/** 请求自增序号，便于在日志里追踪"第几次调用产生了哪批数据" */
let requestSeq = 0;

// ---------------------------------------------------------------- 工具

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Accept',
    'X-Source': 'mock-product-data-service',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('请求体过大（上限 1MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 从 query / body 归一出生成参数 */
function normalizeParams(src) {
  const intOr = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : d;
  };
  const mode = ['pool', 'stable', 'chaos'].includes(src.mode) ? src.mode : 'pool';
  return {
    count: src.count === undefined || src.count === '' ? undefined : intOr(src.count, undefined),
    mode,
    category: src.category || undefined,
    offset: intOr(src.offset, 0),
    seed: src.seed === undefined || src.seed === '' ? undefined : src.seed,
  };
}

// ---------------------------------------------------------------- 路由

const ROUTES = {
  /** 健康检查：主系统用它判断数据源是否在线 */
  'GET /api/health': (req, res) => sendJson(res, 200, {
    ok: true,
    service: cfg.SERVICE_NAME,
    version: cfg.VERSION,
    status: 'running',
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    pool_size: generator.pool.length,
    // 顺带返回商品池的库存状态分布，接入方一次探测即可掌握数据源概况
    pool: generator.snapshot().by_status,
    requests_served: generator.stats.requests,
    at: new Date().toISOString(),
  }),

  /** 字段契约：接入方按此对齐，未来换真实 API 只需字段名映射 */
  'GET /api/schema': (req, res) => sendJson(res, 200, {
    ok: true,
    entity: 'product',
    fields: {
      item_id: { type: 'string', required: true, desc: '商品唯一编号', example: 'MOCK-7K3F9A' },
      title: { type: 'string', required: true, desc: '商品标题', example: '青禾 无线蓝牙耳机 主动降噪 深空灰' },
      stock: { type: 'integer', required: true, range: [0, 500], desc: '当前可售库存' },
      sales: { type: 'integer', required: true, range: [0, 3000], desc: '近 30 天累计销量' },
      price: { type: 'number', required: true, range: [10, 300], desc: '商品售价（元）' },
      category: { type: 'string', required: true, desc: '商品品类' },
      min_stock: { type: 'integer', required: true, range: [10, 480], desc: '补货阈值，库存低于该值时需补货' },
      stock_status: { type: 'string', required: false, enum: ['out', 'low', 'healthy', 'overstock'], desc: '库存状态（扩展字段）' },
      cover_days: { type: 'number', required: false, desc: '库存可售天数（扩展字段）' },
      updated_at: { type: 'string', required: false, desc: '数据生成时间 ISO8601（扩展字段）' },
    },
    endpoints: {
      list: 'GET /api/products?count=10&mode=pool&category=数码配件&flat=0',
      detail: 'GET /api/products/MOCK-XXXXXX?fields=stock,price',
      stream: 'GET /api/products/stream',
      stats: 'GET /api/stats',
    },
    modes: {
      pool: '从商品池随机抽取，商品身份稳定、数值随时间演进（默认）',
      stable: '固定切片，配合 offset 使用；每次同步命中同一批商品，便于观察库存变化',
      chaos: '每次返回全新商品，模拟源源不断产生新数据',
    },
  }),

  'GET /api/categories': (req, res) => sendJson(res, 200, {
    ok: true,
    count: CATEGORIES.length,
    categories: CATEGORIES.map((c) => ({
      key: c.key,
      price_band: c.priceBand,
      sales_band: c.salesBand,
      product_count: c.items.length,
      sample_titles: c.items.slice(0, 3).map((i) => i.n),
    })),
  }),

  'GET /api/stats': (req, res) => sendJson(res, 200, {
    ok: true,
    stats: generator.getStats(),
    pool: generator.snapshot(),
    at: new Date().toISOString(),
  }),

  /** ★ 核心接口：生成一批随机商品数据 */
  'GET /api/products': (req, res, url) => {
    const started = Date.now();
    requestSeq += 1;
    const params = normalizeParams(Object.fromEntries(url.searchParams.entries()));
    const items = generator.generate(params);
    const flat = url.searchParams.get('flat') === '1';

    // flat=1 返回裸数组，方便直接对接不支持包裹结构的系统
    if (flat) return sendJson(res, 200, items);

    sendJson(res, 200, {
      ok: true,
      source: cfg.SERVICE_NAME,
      meta: {
        request_id: `req-${String(requestSeq).padStart(6, '0')}`,
        generated_at: new Date().toISOString(),
        count: items.length,
        mode: params.mode,
        category: params.category || null,
        elapsed_ms: Date.now() - started,
        served_total: generator.stats.items_served,
        pool_size: generator.pool.length,
      },
      items,
    });
  },

  'POST /api/products': async (req, res) => {
    const started = Date.now();
    requestSeq += 1;
    const body = await readBody(req);
    const params = normalizeParams(body);
    const items = generator.generate(params);
    if (body.flat === true) return sendJson(res, 200, items);
    sendJson(res, 200, {
      ok: true,
      source: cfg.SERVICE_NAME,
      meta: {
        request_id: `req-${String(requestSeq).padStart(6, '0')}`,
        generated_at: new Date().toISOString(),
        count: items.length,
        mode: params.mode,
        elapsed_ms: Date.now() - started,
      },
      items,
    });
  },

  /** SSE：持续推送，模拟源源不断的数据流 */
  'GET /api/products/stream': (req, res, url) => {
    const params = normalizeParams(Object.fromEntries(url.searchParams.entries()));
    if (params.count === undefined) params.count = 5;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ service: cfg.SERVICE_NAME, interval_ms: cfg.STREAM_INTERVAL_MS })}\n\n`);

    const push = () => {
      try {
        const items = generator.generate(params);
        res.write(`event: products\ndata: ${JSON.stringify({ at: new Date().toISOString(), items })}\n\n`);
      } catch (err) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
      }
    };
    push();
    const timer = setInterval(push, cfg.STREAM_INTERVAL_MS);
    req.on('close', () => clearInterval(timer));
  },

  'POST /api/reset': async (req, res) => {
    const body = await readBody(req);
    const size = generator.reset(body.seed === undefined ? null : body.seed);
    console.log(`[mock] 商品池已重置，共 ${size} 个商品`);
    sendJson(res, 200, { ok: true, message: '商品池已重置', pool_size: size, at: new Date().toISOString() });
  },
};

// ---------------------------------------------------------------- 服务

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Accept',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  // 浏览器控制台
  if (pathname === '/' || pathname === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'console.html'), 'utf8');
      return sendText(res, 200, html, 'text/html; charset=utf-8');
    } catch (_) {
      return sendText(res, 500, '控制台页面缺失：public/console.html');
    }
  }

  const key = `${req.method} ${pathname}`;
  const handler = ROUTES[key];

  if (handler) {
    try {
      await handler(req, res, url);
      const isStream = pathname.endsWith('/stream');
      if (!isStream) {
        console.log(`[mock] ${key}${url.search || ''} → ${res.statusCode}`);
      }
    } catch (err) {
      console.error(`[mock] ${key} 处理失败:`, err.message);
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: err.message });
      else res.end();
    }
    return;
  }

  // 单商品查询：GET /api/products/:item_id
  // 必须放在精确匹配之后，否则 /api/products/stream 会被当成一个 item_id
  if (req.method === 'GET') {
    const one = /^\/api\/products\/([^/]+)$/.exec(pathname);
    if (one) {
      const itemId = decodeURIComponent(one[1]);
      const item = generator.getItem(itemId);
      if (!item) {
        return sendJson(res, 404, {
          ok: false,
          error: `商品不存在：${itemId}`,
          hint: `商品编号不在商品池中，也不在最近上架的临时缓存里（保留最近 ${cfg.RECENT_MAX} 个）。请使用 /api/products 返回的 item_id`,
        });
      }
      // ?fields=stock,price 只返回关心的字段，方便前端只取一小块
      const fields = (url.searchParams.get('fields') || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (fields.length > 0) {
        const picked = {};
        for (const f of fields) if (Object.hasOwn(item, f)) picked[f] = item[f];
        return sendJson(res, 200, { ok: true, source: cfg.SERVICE_NAME, item_id: itemId, fields: picked });
      }
      return sendJson(res, 200, {
        ok: true,
        source: cfg.SERVICE_NAME,
        item_id: itemId,
        meta: { pool_size: generator.pool.length, simulated_hours: item.simulated_hours },
        item,
      });
    }
  }

  sendJson(res, 404, {
    ok: false,
    error: `接口不存在: ${req.method} ${pathname}`,
    hint: '可用接口请访问 GET /api/schema',
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[mock] 端口 ${cfg.PORT} 已被占用。请换端口：MOCK_PORT=4101 npm start`);
  } else {
    console.error('[mock] 服务启动失败:', err.message);
  }
  process.exit(1);
});

server.listen(cfg.PORT, cfg.HOST, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║   商品仿真数据生成子系统  v1.0.0                     ║');
  console.log('  ╠══════════════════════════════════════════════════════╣');
  console.log(`  ║   服务已启动 → http://${cfg.HOST}:${cfg.PORT}`.padEnd(56) + '║');
  console.log(`  ║   商品池规模 → ${String(cfg.POOL_SIZE).padEnd(37)}║`);
  console.log('  ║   核心接口   → GET /api/products?count=10           ║');
  console.log('  ║   浏览器控制台 → 直接打开首页                       ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
});

const shutdown = (sig) => {
  console.log(`\n[mock] 收到 ${sig}，正在停止…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
