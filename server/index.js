'use strict';
/**
 * 电商智能库存补货系统 - 服务入口
 *
 * 启动流程：初始化数据库 → 若无数据则生成演示数据 → 启动事件同步引擎 → 监听端口
 * 访问：http://localhost:3000
 */
const path = require('node:path');
const express = require('express');

const { ensureSeed } = require('./seed');
const sync = require('./services/sync');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// ---- 基础中间件 ----
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 简易访问日志（仅记录 API，避免静态资源刷屏）
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (ms > 300 || res.statusCode >= 400) {
      console.log(`[api] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// 同源策略：允许本地开发的其他端口访问（生产可收紧）
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- 路由 ----
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/products', require('./routes/products'));
app.use('/api/replenish', require('./routes/replenish'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/price', require('./routes/price'));
app.use('/api/system', require('./routes/system'));
app.use('/api/datasource', require('./routes/datasource'));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), at: new Date().toISOString() });
});

// ---- 静态资源 ----
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    // 图表库体积大，长缓存；其余短缓存保证改样式后立刻生效
    if (filePath.includes('vendor')) res.setHeader('Cache-Control', 'public, max-age=604800');
    else res.setHeader('Cache-Control', 'no-cache');
  },
}));

// 前端为 hash 路由，其余页面路径回落到首页；
// 但静态资源目录不做回退——否则写错的脚本路径会被 index.html 顶替，
// 浏览器只会报 MIME 类型错误，难以定位真实问题
app.get(/^\/(?!api|js|css|vendor|data).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---- 404 与错误处理 ----
app.use('/api', (req, res) => {
  res.status(404).json({ error: `接口不存在: ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? '服务器内部错误' : err.message,
    detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
  });
});

// ---- 启动 ----
function bootstrap() {
  const created = ensureSeed();
  if (created) console.log('[init] 演示数据已生成（18 个商品 / 4 个平台 / 90 天销售历史）');

  // 启动前先跑一次补货计算与预警扫描，保证首屏打开就有数据
  try {
    sync.markDirty();
    sync.recompute({ force: true });
    console.log('[init] 已完成首轮补货计算与库存健康扫描');
  } catch (err) {
    console.error('[init] 首轮计算失败:', err.message);
  }

  // 库存数据来源二选一：外部数据源优先，其次才是内置订单模拟。
  // 两者同时运行会互相覆盖库存，产生无法解释的跳变，所以必须先判断再启动。
  try {
    const datasource = require('./services/datasource');
    const dsCfg = datasource.getConfig();
    if (dsCfg.enabled) {
      // 上次退出时已启用外部数据源 → 恢复定时同步，不启动内置模拟
      datasource.startAuto();
      datasource.pull().then((r) => {
        if (r.ok) console.log(`[init] 数据源首轮同步完成：${r.fetched} 条商品，${r.created} 新增 / ${r.updated} 更新`);
        else console.warn(`[init] 数据源首轮同步失败：${r.error}`);
      }).catch(() => { /* pull 内部已捕获，此处仅兜底 */ });
    } else if (process.env.NO_ENGINE !== '1') {
      sync.startEngine({ orderInterval: process.env.SIM_ORDER_INTERVAL || 15 });
    }
  } catch (err) {
    console.error('[init] 数据源初始化失败，回落为内置模拟:', err.message);
    if (process.env.NO_ENGINE !== '1') {
      sync.startEngine({ orderInterval: process.env.SIM_ORDER_INTERVAL || 15 });
    }
  }

  const server = app.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════╗');
    console.log('  ║   电商智能库存补货系统  v1.0.0                   ║');
    console.log('  ╠══════════════════════════════════════════════════╣');
    console.log(`  ║   服务已启动 → ${url.padEnd(32)}║`);
    console.log('  ║   按 Ctrl+C 停止服务                             ║');
    console.log('  ╚══════════════════════════════════════════════════╝');
    console.log('');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[error] 端口 ${PORT} 已被占用，请设置环境变量 PORT 换一个端口，例如：PORT=3001 npm start`);
    } else {
      console.error('[error] 服务启动失败:', err.message);
    }
    process.exit(1);
  });

  // 优雅关闭
  const shutdown = (signal) => {
    console.log(`\n[shutdown] 收到 ${signal}，正在停止…`);
    sync.stopEngine();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap();
