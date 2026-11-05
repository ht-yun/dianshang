'use strict';
/**
 * 种子数据生成器
 * 生成 90 天带趋势/季节性/噪声的真实感销售数据，
 * 并刻意构造「断货风险 / 预警 / 健康 / 积压」四类库存状态，便于演示。
 * 使用固定种子的伪随机数，保证每次生成结果可复现。
 */
const { all, get, run, tx, saveSettings, isSeeded } = require('./db');

/** mulberry32：确定性伪随机数生成器 */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(20261101);
const rand = (min, max) => min + rng() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

/** 平台定义：price_factor 模拟各平台定价差异 */
const PLATFORMS = [
  { code: 'taobao', name: '淘宝天猫', icon: '淘', color: '#FF6A00', commission: 0.05, price_factor: 1.0 },
  { code: 'jd', name: '京东', icon: '京', color: '#EAB308', commission: 0.06, price_factor: 1.06 },
  { code: 'pdd', name: '拼多多', icon: '拼', color: '#E22E1F', commission: 0.03, price_factor: 0.92 },
  { code: 'douyin', name: '抖音商城', icon: '抖', color: '#161823', commission: 0.08, price_factor: 0.97 },
];

const SUPPLIERS = [
  { code: 'SUP-01', name: '深圳市启源电子科技有限公司', contact: '陈志强', phone: '0755-8823****', lead_time_days: 7, lead_time_std: 1.2, min_order_qty: 50, payment_terms: '30天账期', rating: 4.8 },
  { code: 'SUP-02', name: '义乌市恒达日用百货厂', contact: '李美玲', phone: '0579-8561****', lead_time_days: 5, lead_time_std: 0.8, min_order_qty: 100, payment_terms: '现款现货', rating: 4.5 },
  { code: 'SUP-03', name: '广州雅丽化妆品制造有限公司', contact: '黄文静', phone: '020-3877****', lead_time_days: 12, lead_time_std: 2.4, min_order_qty: 30, payment_terms: '预付30%', rating: 4.2 },
  { code: 'SUP-04', name: '杭州鲜丰食品供应链有限公司', contact: '吴建国', phone: '0571-8890****', lead_time_days: 4, lead_time_std: 0.6, min_order_qty: 60, payment_terms: '15天账期', rating: 4.7 },
  { code: 'SUP-05', name: '宁波万隆服饰织造有限公司', contact: '周晓芳', phone: '0574-8732****', lead_time_days: 15, lead_time_std: 3.1, min_order_qty: 80, payment_terms: '45天账期', rating: 4.0 },
];

/**
 * 商品定义
 * stockDays: 初始库存可售天数（刻意设置差异：<3 断货 / 3-10 预警 / 15-45 健康 / >90 积压）
 * trend: 每日销量的线性趋势（正=上升）
 */
const PRODUCTS = [
  { sku: 'DG-1001', name: '65W氮化镓快充数据线 1.5m', category: '数码配件', brand: '启源', unit: '条', purchase_price: 18.5, suggest_price: 49.9, sup: 1, lt: 7, sd: 7, cover: 14, moq: 50, base: 62, trend: 0.55, vol: 0.28, stockDays: 2.1 },
  { sku: 'DG-1002', name: '主动降噪无线蓝牙耳机 Pro', category: '数码配件', brand: '启源', unit: '副', purchase_price: 132.0, suggest_price: 299.0, sup: 1, lt: 7, sd: 10, cover: 18, moq: 30, base: 34, trend: 0.42, vol: 0.35, stockDays: 2.6 },
  { sku: 'DG-1003', name: '10000mAh 磁吸无线充电宝', category: '数码配件', brand: '启源', unit: '个', purchase_price: 78.0, suggest_price: 189.0, sup: 1, lt: 7, sd: 8, cover: 16, moq: 30, base: 28, trend: 0.18, vol: 0.3, stockDays: 6.5 },
  { sku: 'DG-1004', name: '铝合金折叠手机支架', category: '数码配件', brand: '启源', unit: '个', purchase_price: 9.8, suggest_price: 29.9, sup: 1, lt: 7, sd: 7, cover: 14, moq: 60, base: 45, trend: -0.12, vol: 0.32, stockDays: 26 },
  { sku: 'DG-1005', name: 'PD30W 智能快充充电头', category: '数码配件', brand: '启源', unit: '个', purchase_price: 26.0, suggest_price: 69.0, sup: 1, lt: 7, sd: 7, cover: 14, moq: 40, base: 38, trend: 0.08, vol: 0.26, stockDays: 12 },

  { sku: 'JJ-2001', name: '原木浆抽纸 30包家庭装', category: '家居日用', brand: '恒达', unit: '箱', purchase_price: 28.0, suggest_price: 59.9, sup: 2, lt: 5, sd: 6, cover: 12, moq: 100, base: 96, trend: 0.22, vol: 0.24, stockDays: 3.4 },
  { sku: 'JJ-2002', name: '三合一除菌洗衣凝珠 100颗', category: '家居日用', brand: '恒达', unit: '盒', purchase_price: 21.5, suggest_price: 49.9, sup: 2, lt: 5, sd: 6, cover: 12, moq: 100, base: 71, trend: 0.15, vol: 0.27, stockDays: 18 },
  { sku: 'JJ-2003', name: '加厚抽绳垃圾袋 200只', category: '家居日用', brand: '恒达', unit: '卷', purchase_price: 6.2, suggest_price: 19.9, sup: 2, lt: 5, sd: 6, cover: 12, moq: 150, base: 118, trend: -0.05, vol: 0.22, stockDays: 105 },
  { sku: 'JJ-2004', name: '可折叠收纳箱 66L 加厚款', category: '家居日用', brand: '恒达', unit: '个', purchase_price: 17.0, suggest_price: 45.0, sup: 2, lt: 5, sd: 6, cover: 12, moq: 80, base: 26, trend: 0.3, vol: 0.34, stockDays: 8.2 },

  { sku: 'MZ-3001', name: '氨基酸温和洗面奶 120g', category: '美妆个护', brand: '雅丽', unit: '支', purchase_price: 24.0, suggest_price: 69.0, sup: 3, lt: 12, sd: 12, cover: 20, moq: 30, base: 42, trend: 0.36, vol: 0.3, stockDays: 4.8 },
  { sku: 'MZ-3002', name: '玻尿酸补水面膜 10片装', category: '美妆个护', brand: '雅丽', unit: '盒', purchase_price: 19.5, suggest_price: 59.0, sup: 3, lt: 12, sd: 12, cover: 20, moq: 30, base: 55, trend: 0.48, vol: 0.38, stockDays: 2.4 },
  { sku: 'MZ-3003', name: '声波电动牙刷替换刷头 4支', category: '美妆个护', brand: '雅丽', unit: '盒', purchase_price: 15.0, suggest_price: 45.0, sup: 3, lt: 12, sd: 12, cover: 20, moq: 40, base: 33, trend: 0.06, vol: 0.29, stockDays: 22 },

  { sku: 'SP-4001', name: '每日坚果混合装 750g/30包', category: '食品饮料', brand: '鲜丰', unit: '箱', purchase_price: 52.0, suggest_price: 109.0, sup: 4, lt: 4, sd: 5, cover: 10, moq: 60, base: 64, trend: 0.4, vol: 0.26, stockDays: 5.1 },
  { sku: 'SP-4002', name: '冻干速溶黑咖啡 60颗', category: '食品饮料', brand: '鲜丰', unit: '盒', purchase_price: 39.0, suggest_price: 89.0, sup: 4, lt: 4, sd: 5, cover: 10, moq: 60, base: 48, trend: 0.62, vol: 0.33, stockDays: 2.9 },
  { sku: 'SP-4003', name: '0糖0脂气泡水 330ml×24罐', category: '食品饮料', brand: '鲜丰', unit: '箱', purchase_price: 33.0, suggest_price: 69.9, sup: 4, lt: 4, sd: 5, cover: 10, moq: 80, base: 87, trend: -0.22, vol: 0.25, stockDays: 128 },

  { sku: 'FS-5001', name: '260g重磅纯棉基础T恤', category: '服饰配件', brand: '万隆', unit: '件', purchase_price: 26.0, suggest_price: 79.0, sup: 5, lt: 15, sd: 14, cover: 25, moq: 80, base: 52, trend: -0.34, vol: 0.4, stockDays: 145 },
  { sku: 'FS-5002', name: '冰丝防晒冰袖 均码', category: '服饰配件', brand: '万隆', unit: '副', purchase_price: 5.5, suggest_price: 19.9, sup: 5, lt: 15, sd: 14, cover: 25, moq: 100, base: 74, trend: -0.48, vol: 0.45, stockDays: 41 },
  { sku: 'FS-5003', name: '加大容量帆布托特包', category: '服饰配件', brand: '万隆', unit: '个', purchase_price: 22.0, suggest_price: 65.0, sup: 5, lt: 15, sd: 14, cover: 25, moq: 80, base: 24, trend: 0.14, vol: 0.36, stockDays: 33 },
];

const HISTORY_DAYS = 90;

/** 生成日期字符串 YYYY-MM-DD */
function dateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function dateTimeStr(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${dateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 生成某商品某天的日销量
 * 组合：基础销量 + 线性趋势 + 周末效应 + 正态化噪声 + 偶发促销脉冲
 */
function dailySales(p, dayIndex, totalDays, platformFactor) {
  const progress = dayIndex / Math.max(1, totalDays - 1);
  // 趋势：从起点到终点线性变化，trend 为每日每百件的增量系数
  const trendPart = p.base * (1 + p.trend * (progress - 0.5));
  // 周末效应：周六周日销量提升 18%
  const date = new Date(Date.now() - (totalDays - 1 - dayIndex) * 86400000);
  const dow = date.getDay();
  const weekend = dow === 0 || dow === 6 ? 1.18 : 1.0;
  // 噪声：两次均匀分布相减近似正态分布，再按波动率缩放
  const noise = 1 + ((rng() + rng() + rng()) / 3 - 0.5) * 2 * p.vol;
  // 促销脉冲：5% 概率出现 1.6~2.4 倍爆发
  const promo = rng() < 0.05 ? rand(1.6, 2.4) : 1;
  const qty = Math.round(trendPart * weekend * noise * promo * platformFactor);
  return Math.max(0, qty);
}

function seed() {
  const startedAt = Date.now();

  tx(() => {
    // 清空旧数据，保证可重复初始化
    // ds_product_snapshots 必须一起清：它是「该 SKU 的历史销量已回填」的标记，
    // 若只清 sales_history 而留着快照，重新接入时会被误判为已回填而跳过，
    // 结果仿真商品一条销量历史都没有，补货算法直接退化为无数据。
    const tables = ['purchase_order_items', 'purchase_orders', 'replenish_suggestions', 'price_snapshots',
      'sales_history', 'stock_movements', 'alerts', 'sync_logs', 'ds_product_snapshots',
      'platform_inventory', 'products', 'suppliers', 'platforms'];
    for (const t of tables) run(`DELETE FROM ${t}`);
    run("DELETE FROM sqlite_sequence WHERE name IN ('purchase_order_items','purchase_orders','replenish_suggestions','price_snapshots','sales_history','stock_movements','alerts','sync_logs','platform_inventory','products','suppliers','platforms')");

    // ---- 系统参数 ----
    saveSettings({
      service_level: '0.95',
      forecast_window: '30',
      forecast_weights: '0.5,0.3,0.2',
      safety_days: '7',
      cover_days: '14',
      auto_replenish: '1',
      auto_order_threshold: '0.6',
      sync_interval: '60',
      price_crawl_interval: '300',
      custom_formula_enabled: '0',
      custom_formula: 'avg_daily * (lead_time + cover_days) + safety_stock - available - in_transit',
      alert_overstock_days: '90',
      alert_slow_days: '60',
    });

    // ---- 平台 ----
    const platformIds = {};
    for (const p of PLATFORMS) {
      const r = run(
        'INSERT INTO platforms(code,name,icon,color,commission,price_factor) VALUES(?,?,?,?,?,?)',
        p.code, p.name, p.icon, p.color, p.commission, p.price_factor
      );
      platformIds[p.code] = Number(r.lastInsertRowid);
    }

    // ---- 供应商：键使用 1..N 序号，与 PRODUCTS.sup 对应 ----
    const supplierIds = {};
    SUPPLIERS.forEach((s, i) => {
      const r = run(
        `INSERT INTO suppliers(code,name,contact,phone,lead_time_days,lead_time_std,min_order_qty,payment_terms,rating)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        s.code, s.name, s.contact, s.phone, s.lead_time_days, s.lead_time_std, s.min_order_qty, s.payment_terms, s.rating
      );
      supplierIds[i + 1] = Number(r.lastInsertRowid);
    });

    // ---- 商品 / 平台库存 / 销售历史 / 价格快照 ----
    const platformList = Object.entries(platformIds); // [code, id]
    // 各平台销量占比：淘宝 34%，京东 22%，拼多多 32%，抖音 12%
    const shareMap = { taobao: 0.34, jd: 0.22, pdd: 0.32, douyin: 0.12 };

    const insertSale = require('./db').db.prepare(
      'INSERT INTO sales_history(product_id,platform_id,sale_date,qty,amount) VALUES(?,?,?,?,?)'
    );

    for (const p of PRODUCTS) {
      const pr = run(
        `INSERT INTO products(sku,name,category,brand,unit,purchase_price,suggest_price,supplier_id,
          lead_time_days,safety_days,cover_days,moq,shelf_life_days)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        p.sku, p.name, p.category, p.brand, p.unit, p.purchase_price, p.suggest_price,
        supplierIds[p.sup], p.lt, p.sd, p.cover, p.moq,
        p.category === '食品饮料' ? 240 : null
      );
      const productId = Number(pr.lastInsertRowid);

      // 先算各平台近 7 天日均，用于分配初始库存
      let totalDaily = 0;
      const perPlatformDaily = {};
      for (const [code] of platformList) {
        const f = shareMap[code] || 0.2;
        let sum = 0;
        for (let d = HISTORY_DAYS - 7; d < HISTORY_DAYS; d++) sum += dailySales(p, d, HISTORY_DAYS, f);
        perPlatformDaily[code] = sum / 7;
        totalDaily += sum / 7;
      }

      for (const [code, pid] of platformList) {
        const f = shareMap[code] || 0.2;
        const platFactor = PLATFORMS.find((x) => x.code === code).price_factor;
        const stock = Math.max(0, Math.round(perPlatformDaily[code] * p.stockDays * rand(0.85, 1.15)));
        const price = Math.round(p.suggest_price * platFactor * rand(0.97, 1.03) * 100) / 100;
        run(
          `INSERT INTO platform_inventory(product_id,platform_id,stock,locked,price,listing_url)
           VALUES(?,?,?,?,?,?)`,
          productId, pid, stock, randInt(0, 5), price,
          `https://example-mall.com/item/${p.sku.toLowerCase()}-${code}`
        );
      }

      // 销售历史：逐日写入 4 个平台
      const today = new Date();
      for (let d = 0; d < HISTORY_DAYS; d++) {
        const date = new Date(today.getTime() - (HISTORY_DAYS - 1 - d) * 86400000);
        const ds = dateStr(date);
        for (const [code, pid] of platformList) {
          const f = shareMap[code] || 0.2;
          const qty = dailySales(p, d, HISTORY_DAYS, f);
          if (qty === 0) continue;
          const platFactor = PLATFORMS.find((x) => x.code === code).price_factor;
          const amount = Math.round(qty * p.suggest_price * platFactor * rand(0.95, 1.05) * 100) / 100;
          insertSale.run(productId, pid, ds, qty, amount);
        }
      }

      // 价格快照：最近 14 天，每天各平台一条
      for (let d = 13; d >= 0; d--) {
        const t = new Date(today.getTime() - d * 86400000);
        const captured = dateTimeStr(t);
        for (const [code, pid] of platformList) {
          const platFactor = PLATFORMS.find((x) => x.code === code).price_factor;
          const market = Math.round(p.suggest_price * 1.15 * 100) / 100;
          // 价格随时间轻微漂移，模拟平台调价
          const drift = 1 + (rand(-1, 1) * 0.015 * (14 - d) / 14);
          const price = Math.round(p.suggest_price * platFactor * drift * 100) / 100;
          const competitor = Math.round(price * rand(0.88, 1.12) * 100) / 100;
          run(
            `INSERT INTO price_snapshots(product_id,platform_id,price,market_price,competitor,source,captured_at)
             VALUES(?,?,?,?,?,?,?)`,
            productId, pid, price, market, competitor, 'simulated', captured
          );
        }
      }
    }

    // ---- 近 3 天库存流水（入库/出库/同步），让流水页有内容 ----
    const prods = all('SELECT id, purchase_price, sku FROM products');
    const now = new Date();
    for (let d = 2; d >= 0; d--) {
      for (const pr2 of prods) {
        if (rng() < 0.55) continue;
        const t = new Date(now.getTime() - d * 86400000 - randInt(0, 20) * 3600000);
        const type = pick(['out', 'out', 'out', 'sync', 'in', 'adjust']);
        const qty = type === 'in' ? randInt(20, 120) : type === 'adjust' ? randInt(-8, 8) : randInt(1, 25);
        run(
          'INSERT INTO stock_movements(product_id,platform_id,type,qty,ref_no,note,created_at) VALUES(?,?,?,?,?,?,?)',
          pr2.id, randInt(1, 4), type, qty,
          type === 'in' ? `PO-${dateStr(t).replace(/-/g, '')}-${randInt(100, 999)}` : `ORD-${randInt(100000, 999999)}`,
          type === 'in' ? '采购入库' : type === 'sync' ? '平台库存同步' : type === 'adjust' ? '人工盘点调整' : '订单出库',
          dateTimeStr(t)
        );
      }
    }

    // ---- 同步日志 ----
    for (let i = 0; i < 40; i++) {
      const t = new Date(now.getTime() - randInt(1, 180) * 60000);
      const plat = PLATFORMS[randInt(0, PLATFORMS.length - 1)];
      const evt = pick(['order_paid', 'stock_update', 'price_change', 'inventory_pull']);
      run(
        'INSERT INTO sync_logs(platform_id,event_type,direction,payload,status,latency_ms,created_at) VALUES(?,?,?,?,?,?,?)',
        platformIds[plat.code], evt, rng() < 0.75 ? 'in' : 'out',
        JSON.stringify({ sku: `SKU-${randInt(1000, 9999)}`, qty: randInt(1, 30) }),
        rng() < 0.96 ? 'success' : 'retry', randInt(28, 460), dateTimeStr(t)
      );
    }
  });

  const stat = {
    platforms: get('SELECT COUNT(*) c FROM platforms').c,
    suppliers: get('SELECT COUNT(*) c FROM suppliers').c,
    products: get('SELECT COUNT(*) c FROM products').c,
    sales: get('SELECT COUNT(*) c FROM sales_history').c,
    prices: get('SELECT COUNT(*) c FROM price_snapshots').c,
  };
  console.log(`[seed] 初始化完成 ${Date.now() - startedAt}ms`, stat);
  return stat;
}

/** 若数据库为空则自动初始化 */
function ensureSeed() {
  if (!isSeeded()) {
    console.log('[seed] 检测到空数据库，正在生成演示数据…');
    seed();
    return true;
  }
  return false;
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  if (force || !isSeeded()) {
    seed();
  } else {
    console.log('[seed] 数据库已有数据，跳过。如需重建请执行 npm run reset');
  }
}

module.exports = { seed, ensureSeed, PLATFORMS };
