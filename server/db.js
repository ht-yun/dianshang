'use strict';
/**
 * 数据层：SQLite 连接、关系表结构、通用访问封装
 * 使用 Node 22 内置 node:sqlite，无需编译原生模块
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'inventory.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);

// WAL 提升并发读性能，外键约束保证关系完整性
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/** 建表语句：全部为关系型结构，含主外键与索引 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS platforms (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  icon          TEXT,
  color         TEXT,
  commission    REAL NOT NULL DEFAULT 0.05,
  price_factor  REAL NOT NULL DEFAULT 1.0,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  contact         TEXT,
  phone           TEXT,
  lead_time_days  INTEGER NOT NULL DEFAULT 7,
  lead_time_std   REAL NOT NULL DEFAULT 1.5,
  min_order_qty   INTEGER NOT NULL DEFAULT 10,
  payment_terms   TEXT DEFAULT '30天账期',
  rating          REAL NOT NULL DEFAULT 4.5,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sku             TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,
  brand           TEXT,
  unit            TEXT NOT NULL DEFAULT '件',
  purchase_price  REAL NOT NULL,
  suggest_price   REAL NOT NULL,
  supplier_id     INTEGER REFERENCES suppliers(id),
  lead_time_days  INTEGER NOT NULL DEFAULT 7,
  safety_days     INTEGER NOT NULL DEFAULT 7,
  cover_days      INTEGER NOT NULL DEFAULT 14,
  moq             INTEGER NOT NULL DEFAULT 20,
  shelf_life_days INTEGER,
  status          TEXT NOT NULL DEFAULT 'on_sale',
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS platform_inventory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  platform_id INTEGER NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  stock       INTEGER NOT NULL DEFAULT 0,
  locked      INTEGER NOT NULL DEFAULT 0,
  price       REAL NOT NULL DEFAULT 0,
  listing_url TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(product_id, platform_id)
);

CREATE TABLE IF NOT EXISTS sales_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  platform_id INTEGER NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  sale_date   TEXT NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 0,
  amount      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales_history(sale_date);
CREATE INDEX IF NOT EXISTS idx_sales_product ON sales_history(product_id, sale_date);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  platform_id   INTEGER NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  price         REAL NOT NULL,
  market_price  REAL,
  competitor    REAL,
  source        TEXT NOT NULL DEFAULT 'simulated',
  captured_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_price_product ON price_snapshots(product_id, captured_at);

CREATE TABLE IF NOT EXISTS replenish_suggestions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_no   TEXT NOT NULL UNIQUE,
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  available_stock INTEGER NOT NULL,
  in_transit      INTEGER NOT NULL DEFAULT 0,
  avg_daily_sales REAL NOT NULL,
  demand_std      REAL NOT NULL DEFAULT 0,
  lead_time_days  INTEGER NOT NULL,
  safety_stock    INTEGER NOT NULL,
  reorder_point   INTEGER NOT NULL,
  suggest_qty     INTEGER NOT NULL,
  final_qty       INTEGER NOT NULL,
  eoq             INTEGER NOT NULL DEFAULT 0,
  cover_days      REAL NOT NULL DEFAULT 0,
  urgency         TEXT NOT NULL DEFAULT 'normal',
  confidence      REAL NOT NULL DEFAULT 0,
  algorithm       TEXT NOT NULL DEFAULT 'dynamic_ss',
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  reviewed_by     TEXT,
  reviewed_at     TEXT,
  review_note     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sug_status ON replenish_suggestions(status);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no      TEXT NOT NULL UNIQUE,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  status        TEXT NOT NULL DEFAULT 'pending',
  total_amount  REAL NOT NULL DEFAULT 0,
  total_qty     INTEGER NOT NULL DEFAULT 0,
  expected_date TEXT,
  remark        TEXT,
  created_by    TEXT DEFAULT '系统',
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  qty         INTEGER NOT NULL,
  unit_price  REAL NOT NULL,
  amount      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  platform_id INTEGER REFERENCES platforms(id),
  type        TEXT NOT NULL,
  qty         INTEGER NOT NULL,
  ref_no      TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_move_time ON stock_movements(created_at);

CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  level      TEXT NOT NULL DEFAULT 'warning',
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  message    TEXT,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_alert_status ON alerts(status, created_at);

CREATE TABLE IF NOT EXISTS sync_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_id INTEGER REFERENCES platforms(id),
  event_type  TEXT NOT NULL,
  direction   TEXT NOT NULL DEFAULT 'in',
  payload     TEXT,
  status      TEXT NOT NULL DEFAULT 'success',
  latency_ms  INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sync_time ON sync_logs(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  label TEXT
);
`;

db.exec(SCHEMA);

/** 查询多行 */
const all = (sql, ...params) => db.prepare(sql).all(...params);
/** 查询单行，无结果返回 undefined */
const get = (sql, ...params) => db.prepare(sql).get(...params);
/** 执行写操作，返回 { changes, lastInsertRowid } */
const run = (sql, ...params) => db.prepare(sql).run(...params);
/**
 * 事务包装：回调内抛错则整体回滚。
 * 使用 SAVEPOINT 实现可重入，允许在事务内再调用其他带事务的函数（如 seed 内调用 saveSettings）。
 */
let txDepth = 0;
function tx(fn) {
  const depth = txDepth;
  const sp = `sp_${depth}`;
  txDepth += 1;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${sp}`);
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO ${sp}`);
      db.exec(`RELEASE ${sp}`);
    } catch (_) { /* 忽略回滚时的二次异常，保留原始错误 */ }
    throw err;
  } finally {
    txDepth = depth;
  }
}

/** 读取全部系统参数为普通对象 */
function getSettings() {
  const rows = all('SELECT key, value FROM settings');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** 批量写入参数（存在则更新） */
function saveSettings(pairs) {
  const stmt = db.prepare(
    'INSERT INTO settings(key, value, label) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  );
  tx(() => {
    for (const [key, value] of Object.entries(pairs)) {
      if (value === undefined || value === null) continue;
      stmt.run(key, String(value), null);
    }
  });
}

/** 数据库是否已完成初始化（有商品即视为已就绪） */
function isSeeded() {
  try {
    const row = get('SELECT COUNT(*) AS c FROM products');
    return row && row.c > 0;
  } catch (_) {
    return false;
  }
}

module.exports = { db, all, get, run, tx, getSettings, saveSettings, isSeeded, DB_FILE };
