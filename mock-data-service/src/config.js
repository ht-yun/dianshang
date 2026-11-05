'use strict';
/**
 * 仿真数据服务配置
 * 全部支持环境变量覆盖，便于在同一台机器上跑多个实例做压测。
 */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

module.exports = {
  // ---- 服务 ----
  PORT: num(process.env.MOCK_PORT, 4100),
  HOST: process.env.MOCK_HOST || '127.0.0.1',
  SERVICE_NAME: 'mock-product-data-service',
  VERSION: '1.0.0',

  // ---- 商品池 ----
  // 池内商品身份（item_id / 标题 / 品类）保持稳定，数值随时间演进，
  // 这样主系统可以反复同步同一批商品并观察到库存变化，而不是每次都面对全新商品。
  POOL_SIZE: num(process.env.MOCK_POOL_SIZE, 240),

  // 建池种子：固定后商品身份在服务重启后依然不变（货号不会凭空换掉），
  // 只有库存/销量等数值重新开始演进。设为 0 表示每次启动都随机生成新的商品池。
  POOL_SEED: num(process.env.MOCK_POOL_SEED, 20261102),

  // 池模式每次返回的条数区间（未显式指定 count 时在该区间内随机）
  BATCH_MIN: num(process.env.MOCK_BATCH_MIN, 5),
  BATCH_MAX: num(process.env.MOCK_BATCH_MAX, 15),
  MAX_COUNT: num(process.env.MOCK_MAX_COUNT, 200),

  // chaos 模式（新商品上架）产生的商品不进商品池，但需要能被单商品查询接口回查，
  // 否则"刚上架就查不到"。这里用有界缓存保留最近 N 个，防止长时间运行内存膨胀。
  RECENT_MAX: num(process.env.MOCK_RECENT_MAX, 300),

  // ---- 业务时间模型 ----
  // 每次请求推进的仿真"小时数"。真实业务里库存是连续消耗的，
  // 这里把一次调用视为一个业务时间片，保证连续两次调用数据必然不同。
  HOURS_PER_TICK: num(process.env.MOCK_HOURS_PER_TICK, 1),

  // 一次请求最多推进多少小时（防止长时间不调用后数据跳变过大）
  MAX_TICK_HOURS: 12,

  // 历史数据天数（用于生成 sales 所依据的 30 日销量窗口）
  HISTORY_DAYS: 30,

  // ---- 数值边界（严格按需求约束）----
  STOCK_MAX: 500,
  SALES_MAX: 3000,
  PRICE_MIN: 10,
  PRICE_MAX: 300,
  MIN_STOCK_MIN: 10,
  MIN_STOCK_MAX: 480,

  // SSE 推送间隔（毫秒）
  STREAM_INTERVAL_MS: num(process.env.MOCK_STREAM_INTERVAL, 2000),
};
