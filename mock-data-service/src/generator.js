'use strict';
/**
 * 商品业务数据生成器
 *
 * 不是简单的 Math.random 取值，而是一个带时间推进的微型业务模型：
 *
 *   商品池（身份稳定）→ 每次请求推进仿真时钟 → 按小时消耗库存
 *   → 日内波动 / 促销脉冲 / 趋势漂移 → 库存触底后触发"供应商到货"
 *   → 输出当月累计销量、当前库存、动态补货阈值
 *
 * 这样连续两次调用接口，看到的是同一批商品在继续演进（库存下降、销量累积），
 * 而不是两批互不相干的随机数——主系统接入后才能观察到真实的数据流变化。
 *
 * 三种模式：
 *   pool   默认。从商品池随机抽取，商品身份稳定、数值随时间演进。
 *   stable 固定切片。按 offset/count 返回池中固定的一段，主系统反复同步同一批
 *          商品即可观察到「库存逐步下降 → 触发补货」的完整过程。
 *   chaos  每次返回全新商品，模拟"源源不断产生新商品"。
 */
const cfg = require('./config');
const { Rng, hashString, clamp, round } = require('./random');
const { BRANDS, CATEGORIES, CATEGORY_MAP, STOCK_SCENARIOS } = require('./catalog');

/** 一天 24 小时的流量权重（电商真实作息：凌晨低、午间和晚间双高峰） */
const HOUR_WEIGHTS = [
  0.30, 0.22, 0.18, 0.18, 0.22, 0.32, 0.48, 0.68, 0.90, 1.10, 1.28, 1.45,
  1.55, 1.45, 1.30, 1.20, 1.18, 1.26, 1.48, 1.78, 2.02, 1.86, 1.35, 0.72,
];
const HOUR_MEAN = HOUR_WEIGHTS.reduce((s, v) => s + v, 0) / 24;
const HOUR_FACTOR = HOUR_WEIGHTS.map((v) => v / HOUR_MEAN);

/** item_id 字符集（去掉了易混淆的 0/O/1/I） */
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const nowISO = () => new Date().toISOString();

/** 生成形如 MOCK-7K3F9A 的商品编号 */
function makeItemId(rng) {
  let s = '';
  for (let i = 0; i < 6; i += 1) s += ID_CHARS[rng.int(0, ID_CHARS.length - 1)];
  return `MOCK-${s}`;
}

/** 组装商品标题：品牌 + 商品词 + 卖点(1~2) + 规格 */
function makeTitle(rng, cat) {
  const brand = rng.pick(BRANDS);
  const item = rng.pick(cat.items);
  // 卖点从该商品自己的卖点池里取，避免拼出「支架 主动降噪」这种错配
  const attrCount = item.a.length >= 2 && rng.chance(0.78) ? 2 : 1;
  const attrs = rng.sample(item.a, attrCount);
  const spec = rng.chance(0.6) ? ` ${rng.pick(cat.specs)}` : '';
  return `${brand} ${item.n} ${attrs.join(' ')}${spec}`.replace(/\s+/g, ' ').trim();
}

/** 价格收尾：百元以下用 .9 结尾，以上取整——贴近真实店铺定价习惯 */
function stylePrice(p) {
  const v = clamp(p, cfg.PRICE_MIN, cfg.PRICE_MAX);
  if (v < 100) return round(Math.floor(v) + 0.9, 2);
  return Math.round(v);
}

/**
 * 创建一个商品（池模式初始建池 / chaos 模式每次新建都走这里）
 */
function createItem(rng, cat) {
  const itemId = makeItemId(rng);

  // ---- 价格：品类价格带内取对数正态，形成"中间多、两端少" ----
  const [pLo, pHi] = cat.priceBand;
  const priceMid = Math.sqrt(Math.max(pLo, 1) * pHi); // 几何中点，比算术中点更贴合价格分布
  let price = stylePrice(priceMid * rng.lognormal(0, 0.28));

  // ---- 需求水平：按品类销量带抽样 ----
  // 用幂函数把均匀分布压向低端：r^2.1 的中位数约 0.23，
  // 于是「多数商品销量平平、少数商品成为爆款」的长尾形态得以成立。
  const [sLo, sHi] = cat.salesBand;
  const frac = Math.pow(rng.next(), 2.1);
  const monthly = Math.round(clamp(sLo + (sHi - sLo) * frac, 0, cfg.SALES_MAX));
  const avgDaily = Math.max(0.3, monthly / cfg.HISTORY_DAYS);

  // ---- 30 天历史销量：周末抬升 + 随机波动，使预测算法有真实形态可分析 ----
  const daily = [];
  let acc = 0;
  for (let d = cfg.HISTORY_DAYS - 1; d >= 0; d -= 1) {
    const dow = (new Date().getDay() - d + 70) % 7;
    const weekend = dow === 0 || dow === 6 ? 1.22 : 1.0;
    const v = Math.max(0, Math.round(avgDaily * weekend * rng.lognormal(0, 0.24)));
    daily.push(v);
    acc += v;
  }

  // ---- 动态补货阈值：按品类节奏给 3~8 天覆盖，落到 [10,480] 区间 ----
  const coverTarget = rng.float(3, 8);
  const minStock = clamp(Math.round(avgDaily * coverTarget), cfg.MIN_STOCK_MIN, cfg.MIN_STOCK_MAX);

  // ---- 初始库存：按业务场景抽样，天然覆盖断货/紧缺/健康/积压 ----
  const scenario = rng.weighted(STOCK_SCENARIOS);
  const [cLo, cHi] = scenario.coverDays;
  const coverDays = rng.float(cLo, cHi);
  let stock;
  if (scenario.key === 'out') stock = 0;
  else if (scenario.key === 'overstock' || scenario.key === 'slow') stock = cfg.STOCK_MAX;
  else stock = clamp(Math.round(avgDaily * coverDays), 0, cfg.STOCK_MAX);

  return {
    item_id: itemId,
    title: makeTitle(rng, cat),
    category: cat.key,
    price,
    stock,
    // 时间推进模型的状态
    daily,               // 过去 30 天逐日销量
    partial: 0,          // 当日已累积销量
    avgDaily: acc / cfg.HISTORY_DAYS || avgDaily,
    minStock,
    trend: rng.float(0.85, 1.15),   // 需求趋势因子（随机游走）
    promoHours: 0,                  // 促销剩余小时数
    promoFactor: 1,
    hourOfDay: rng.int(0, 23),
    clock: 0,                       // 上次更新时的全局时钟（小时）
    scenario: scenario.key,
    created_at: nowISO(),
  };
}

/** 汇总输出：sales = 30 日滚动 + 当日部分 */
function readItem(item) {
  const sales = Math.round(clamp(item.daily.reduce((s, v) => s + v, 0) + item.partial, 0, cfg.SALES_MAX));
  const avgDaily = item.daily.reduce((s, v) => s + v, 0) / cfg.HISTORY_DAYS || item.avgDaily;
  const coverDays = avgDaily > 0.05 ? item.stock / avgDaily : Infinity;

  let stockStatus = 'healthy';
  if (item.stock <= 0) stockStatus = 'out';
  else if (item.stock < item.minStock) stockStatus = 'low';
  else if (coverDays > 30) stockStatus = 'overstock';

  return {
    item_id: item.item_id,
    title: item.title,
    stock: Math.round(item.stock),
    sales,
    price: round(item.price, 2),
    category: item.category,
    min_stock: Math.round(item.minStock),
    // ---- 以下为扩展字段，主系统可直接使用，也可忽略 ----
    stock_status: stockStatus,
    cover_days: Number.isFinite(coverDays) ? round(coverDays, 1) : null,
    updated_at: nowISO(),
  };
}

/**
 * 按库存状态轮转交错商品池
 * 让任意连续切片都覆盖断货/紧缺/健康/积压多种状态，而不是扎堆同一种
 */
function interleaveByStatus(pool) {
  const groups = new Map();
  for (const item of pool) {
    const key = readItem(item).stock_status;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const buckets = [...groups.values()];
  const out = [];
  let remaining = pool.length;
  let i = 0;
  while (remaining > 0) {
    const bucket = buckets[i % buckets.length];
    if (bucket.length > 0) {
      out.push(bucket.shift());
      remaining -= 1;
    }
    i += 1;
  }
  return out;
}

class ProductGenerator {
  constructor() {
    this.rng = new Rng();
    this.pool = [];
    this.clock = 0;
    // chaos 模式生成的商品不进池（否则商品池会被压测无限撑大），
    // 但"刚上架就查不到"也不合理，故保留最近 N 个供单商品查询接口回查。
    this.recent = new Map();
    this.stats = {
      started_at: nowISO(),
      requests: 0,
      items_served: 0,
      ticks: 0,
      restocks: 0,
      pool_builds: 0,
      recent_evicted: 0,
    };
    // 用固定种子建池：服务重启后商品编号与标题保持不变，
    // 避免主系统里同一个商品因为数据源重启而"换了个身份"
    this.reset(cfg.POOL_SEED || null);
  }

  /** 重建商品池（重置演示状态） */
  reset(seed = null) {
    const rng = seed === null ? new Rng() : new Rng(seed);
    this.pool = [];
    this.clock = 0;
    this.usedTitles = new Set();
    if (this.recent) this.recent.clear();
    this.stats.pool_builds += 1;

    const weightedCats = CATEGORIES.map((c) => ({ ...c, w: c.w }));
    for (let i = 0; i < cfg.POOL_SIZE; i += 1) {
      const cat = rng.weighted(weightedCats);
      const item = createItem(rng, cat);
      // 标题去重：撞名时补一个规格后缀，避免列表看起来"重复铺货"
      let guard = 0;
      while (this.usedTitles.has(item.title) && guard < 12) {
        item.title = makeTitle(rng, cat);
        guard += 1;
      }
      this.usedTitles.add(item.title);
      this.pool.push(item);
    }
    // 按库存状态交错排列商品池：
    // stable 模式取的是池中固定切片，若池子按创建顺序排列，
    // 某一段切片可能全是"库存 500"的积压商品，接入后的看板会显得单调。
    // 交错后任意切片都能覆盖断货/紧缺/健康/积压多种状态，演示更真实。
    this.pool = interleaveByStatus(this.pool);
    return this.pool.length;
  }

  /**
   * 推进仿真时钟
   * 每次请求都至少前进 1 小时，保证连续两次调用的返回值必然不同
   */
  advanceClock() {
    const step = Math.max(1, Math.round(cfg.HOURS_PER_TICK * this.rng.float(0.8, 1.6)));
    this.clock += step;
    this.stats.ticks += step;
    return this.clock;
  }

  /** 单步推进一个商品，返回本次售出数量 */
  step(item, hours, rng = this.rng) {
    let soldTotal = 0;
    for (let h = 0; h < hours; h += 1) {
      const hourFactor = HOUR_FACTOR[item.hourOfDay];

      // 促销脉冲：偶发 1~4 天的活动，把需求抬到 1.6~2.6 倍
      if (item.promoHours > 0) {
        item.promoHours -= 1;
      } else if (rng.chance(0.004)) {
        item.promoHours = rng.int(24, 96);
        item.promoFactor = rng.float(1.6, 2.6);
      }
      const promo = item.promoHours > 0 ? item.promoFactor : 1;

      const hourlyRate = (item.avgDaily / 24) * hourFactor * item.trend * promo;
      // 泊松抽样：订单到达本身就是离散事件，比直接取期望值更真实
      const demand = rng.poisson(Math.max(0, hourlyRate));
      const sold = Math.min(demand, item.stock);
      if (sold > 0) {
        item.stock -= sold;
        item.partial += sold;
        soldTotal += sold;
      }

      item.hourOfDay = (item.hourOfDay + 1) % 24;
      // 跨天：滚动销量窗口
      if (item.hourOfDay === 0) this.rollDay(item, rng);
    }
    return soldTotal;
  }

  /** 日切：滚动 30 日窗口、趋势随机游走、价格漂移、可能的供应商到货 */
  rollDay(item, rng = this.rng) {
    item.daily.push(item.partial);
    item.daily.shift();
    item.partial = 0;

    const avg = item.daily.reduce((s, v) => s + v, 0) / cfg.HISTORY_DAYS;
    item.avgDaily = Math.max(0.25, avg);

    // 趋势因子做有界随机游走
    item.trend = clamp(item.trend + this.rng.normal(0, 0.035), 0.62, 1.65);

    // 补货阈值跟随近期需求水平
    const coverTarget = clamp(item.minStock / Math.max(item.avgDaily, 0.1), 3, 8);
    item.minStock = clamp(Math.round(item.avgDaily * coverTarget), cfg.MIN_STOCK_MIN, cfg.MIN_STOCK_MAX);

    // 价格缓慢漂移（真实店铺会跟着活动调价），限制在品类带的合理区间
    const cat = CATEGORY_MAP.get(item.category);
    const [pLo, pHi] = cat ? cat.priceBand : [cfg.PRICE_MIN, cfg.PRICE_MAX];
    const drifted = clamp(
      item.price * (1 + rng.normal(0, 0.012)),
      Math.max(pLo, cfg.PRICE_MIN),
      Math.min(pHi, cfg.PRICE_MAX)
    );
    // 漂移后仍套用店铺定价习惯（.9 结尾 / 整数），避免出现 228.76 这类尾数
    item.price = stylePrice(drifted);

    // 库存低于阈值时，有一定概率"供应商到货"——模拟真实补货节奏，
    // 避免库存永久归零导致后续数据失去观察价值
    if (item.stock < item.minStock) {
      const arrive = item.stock <= 0 ? 0.55 : 0.22;
      if (rng.chance(arrive)) {
        const target = item.minStock * rng.float(1.6, 3.2);
        const add = Math.max(1, Math.round(target - item.stock));
        item.stock = clamp(item.stock + add, 0, cfg.STOCK_MAX);
        this.stats.restocks += 1;
      }
    }

    // 长期滞销商品偶发清仓，让"积压"状态不会永远卡死
    if (item.stock >= cfg.STOCK_MAX && rng.chance(0.12)) {
      item.stock = Math.round(item.stock * rng.float(0.55, 0.85));
    }
  }

  /**
   * 生成一批数据
   * @param {object} opts
   * @param {number} [opts.count] 条数；不传则在 BATCH_MIN~BATCH_MAX 间随机
   * @param {'pool'|'stable'|'chaos'} [opts.mode]
   * @param {string} [opts.category] 指定品类
   * @param {number} [opts.offset] stable 模式的起始下标
   * @param {number|string} [opts.seed] 传入则该次结果可复现
   */
  generate(opts = {}) {
    const mode = opts.mode === 'chaos' || opts.mode === 'stable' ? opts.mode : 'pool';
    const rng = opts.seed !== undefined && opts.seed !== null ? new Rng(opts.seed) : this.rng;

    const count = clamp(
      Number.isFinite(Number(opts.count)) && Number(opts.count) > 0
        ? Math.round(Number(opts.count))
        : rng.int(cfg.BATCH_MIN, cfg.BATCH_MAX),
      1,
      cfg.MAX_COUNT
    );

    this.stats.requests += 1;

    if (mode === 'chaos') {
      // 全新随机商品：每次都是新身份，适合"源源不断产生数据"的演示
      const items = [];
      for (let i = 0; i < count; i += 1) {
        const cat = opts.category && CATEGORY_MAP.get(opts.category)
          ? CATEGORY_MAP.get(opts.category)
          : rng.weighted(CATEGORIES);
        const item = createItem(rng, cat);
        // chaos 模式下也推进一段随机时间，让库存呈现"已经营一段时间"的状态
        this.step(item, rng.int(0, 6), rng);
        // 记下当前时刻：否则之后按 ID 查询时会按 clock-0 一次性追平一大段，
        // 查到的库存与刚返回的数值对不上。
        item.clock = this.clock;
        this.rememberRecent(item);
        items.push(readItem(item));
      }
      this.stats.items_served += items.length;
      return items;
    }

    // ---- 池模式 ----
    this.advanceClock();

    // 候选集：按品类过滤后抽取
    let candidates = this.pool;
    if (opts.category) {
      const filtered = this.pool.filter((x) => x.category === opts.category);
      if (filtered.length > 0) candidates = filtered;
    }

    let picked;
    if (mode === 'stable') {
      // 固定切片：同一 offset/count 每次都命中同一批商品，只有数值在变
      const offset = Math.max(0, Math.round(Number(opts.offset) || 0));
      const size = Math.min(count, candidates.length);
      picked = [];
      for (let i = 0; i < size; i += 1) {
        picked.push(candidates[(offset + i) % candidates.length]);
      }
    } else {
      picked = rng.sample(candidates, Math.min(count, candidates.length));
    }

    const items = [];
    for (const item of picked) {
      // 惰性推进：只推进被读取的商品，最多补 MAX_TICK_HOURS，避免长时间空闲后跳变
      const dt = Math.min(Math.max(0, this.clock - item.clock), cfg.MAX_TICK_HOURS);
      if (dt > 0) {
        this.step(item, dt);
        item.clock = this.clock;
      }
      items.push(readItem(item));
    }

    this.stats.items_served += items.length;
    return items;
  }

  /**
   * 记住最近上架的临时商品（chaos 模式）
   * 用 Map 的插入顺序做 FIFO 淘汰，容量上限 RECENT_MAX，保证内存有界。
   */
  rememberRecent(item) {
    this.recent.delete(item.item_id);
    this.recent.set(item.item_id, item);
    while (this.recent.size > cfg.RECENT_MAX) {
      const oldest = this.recent.keys().next().value;
      this.recent.delete(oldest);
      this.stats.recent_evicted += 1;
    }
  }

  /**
   * 按 item_id 查询单个商品（单商品查询接口用）
   *
   * 刻意不推进全局时钟：查询是只读行为，若顺手把时钟往前推，
   * 下一个调 /api/products 的人会拿到被"偷跑"过的库存，仿真就不自洽了。
   * 这里只把该商品惰性追平到当前时钟，与批量接口的读取规则保持一致。
   *
   * 查找顺序：商品池 → 最近上架的临时商品。
   *
   * @returns {object|null} 两处都找不到时返回 null
   */
  getItem(itemId) {
    const id = String(itemId || '').trim();
    if (!id) return null;
    const pooled = this.pool.find((x) => x.item_id === id);
    const item = pooled || this.recent.get(id);
    if (!item) return null;

    const dt = Math.min(Math.max(0, this.clock - item.clock), cfg.MAX_TICK_HOURS);
    if (dt > 0) {
      this.step(item, dt);
      item.clock = this.clock;
    }

    const base = readItem(item);
    return {
      ...base,
      // 以下为内部模拟状态的透出，便于接入方核对"这个数是怎么来的"
      daily_sales: item.daily.slice(),
      avg_daily: round(item.avgDaily, 2),
      trend: round(item.trend, 3),
      promo_active: item.promoHours > 0,
      scenario: item.scenario,
      pooled: Boolean(pooled),
      simulated_hours: item.clock,
      created_at: item.created_at,
    };
  }

  /** 池状态概览 */
  snapshot() {
    const byStatus = { out: 0, low: 0, healthy: 0, overstock: 0 };
    const byCategory = {};
    for (const item of this.pool) {
      const r = readItem(item);
      byStatus[r.stock_status] = (byStatus[r.stock_status] || 0) + 1;
      byCategory[item.category] = (byCategory[item.category] || 0) + 1;
    }
    return {
      pool_size: this.pool.length,
      recent_arrivals: this.recent.size,
      by_status: byStatus,
      by_category: byCategory,
    };
  }

  getStats() {
    return {
      ...this.stats,
      pool_size: this.pool.length,
      clock_hours: this.clock,
      simulated_days: round(this.clock / 24, 2),
      uptime_seconds: Math.round(process.uptime()),
    };
  }
}

module.exports = { ProductGenerator, readItem, createItem, HOUR_FACTOR };
