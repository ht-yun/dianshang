'use strict';
/**
 * 需求预测模块
 *
 * 预测模型：Holt 双参数指数平滑（水平 + 趋势），与加权移动平均（7/14/30 日）融合。
 *   level_t   = α·y_t + (1-α)(level_{t-1} + trend_{t-1})
 *   trend_t   = β·(level_t - level_{t-1}) + (1-β)·trend_{t-1}
 *   forecast  = level_t + trend_t
 * 融合的意义：Holt 捕捉趋势变化快，WMA 抗噪稳定，两者加权后既能跟趋势又能防异常值带偏。
 */
const { all } = require('../db');

/** 算术平均 */
const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

/** 样本标准差（n-1 分母） */
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/** 最小二乘线性回归，用于提取趋势斜率 */
function linearRegression(ys) {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] || 0 };
  const xs = ys.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: my - slope * mx };
}

/** 变异系数：波动率，用于置信度评估 */
function cv(arr) {
  const m = mean(arr);
  return m <= 0 ? 0 : std(arr) / m;
}

/**
 * 标准正态分布反函数（Acklam 近似，精度 ~1e-9）
 * 用于把服务水平（95%）换算成安全系数 z（1.645）
 */
function normalInverse(p) {
  if (p <= 0 || p >= 1) throw new Error('服务水平必须介于 0 和 1 之间');
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q;
  let r;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * 取商品的全渠道日销量序列（按日期升序，缺失日期补 0）
 * @returns {{dates: string[], values: number[], revenue: number[]}}
 */
function getDailySeries(productId, days = 90) {
  const rows = all(
    `SELECT sale_date AS d, SUM(qty) AS qty, SUM(amount) AS amt
     FROM sales_history
     WHERE product_id = ? AND sale_date >= date('now', ?)
     GROUP BY sale_date ORDER BY sale_date ASC`,
    productId, `-${days} day`
  );
  const map = new Map(rows.map((r) => [r.d, r]));

  // 补齐缺失日期（零销量日必须计入，否则均值会被高估）
  const dates = [];
  const values = [];
  const revenue = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    dates.push(key);
    const hit = map.get(key);
    values.push(hit ? hit.qty : 0);
    revenue.push(hit ? hit.amt : 0);
  }
  return { dates, values, revenue };
}

/**
 * 核心预测：返回日均需求、波动、趋势与预测序列
 * @param {number} productId
 * @param {object} opts { window, alpha, beta, weights:[w7,w14,w30], forecastDays }
 */
function forecastDemand(productId, opts = {}) {
  const window = Math.max(7, Number(opts.window) || 30);
  const alpha = Number(opts.alpha) || 0.35; // 水平平滑系数
  const beta = Number(opts.beta) || 0.12;   // 趋势平滑系数
  const w = Array.isArray(opts.weights) && opts.weights.length === 3 ? opts.weights : [0.5, 0.3, 0.2];
  const forecastDays = Number(opts.forecastDays) || 7;

  const { dates, values, revenue } = getDailySeries(productId, Math.max(window, 30));
  const recent = values.slice(-window);

  if (!recent.length) {
    return {
      dates, values, avgDaily: 0, demandStd: 0, trend: 0, slope: 0, cv: 0,
      holt: 0, wma: 0, forecastSeries: [], totalRevenue: 0, sampleDays: 0,
    };
  }

  // ---- Holt 双参数指数平滑 ----
  let level = recent[0];
  let trend = 0;
  const fitted = [level];
  for (let i = 1; i < recent.length; i++) {
    const prevLevel = level;
    level = alpha * recent[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    fitted.push(level + trend);
  }
  const holt = Math.max(0, level + trend);

  // ---- 加权移动平均：近 7 / 14 / 30 日 ----
  const tail = (n) => values.slice(-Math.min(n, values.length));
  const m7 = mean(tail(7));
  const m14 = mean(tail(14));
  const m30 = mean(tail(30));
  const wma = Math.max(0, m7 * w[0] + m14 * w[1] + m30 * w[2]);

  // ---- 趋势斜率（线性回归）----
  const { slope } = linearRegression(recent);

  // ---- 融合：Holt 权重 0.65，WMA 权重 0.35，并做合理性夹逼 ----
  const blended = holt * 0.65 + wma * 0.35;
  // 防止趋势外推过度（不超过近期 7 日均值的 1.8 倍，不低于其 0.4 倍）
  const upper = Math.max(m7 * 1.8, 1);
  const lower = Math.max(m7 * 0.4, 0.5);
  const avgDaily = Math.min(Math.max(blended, lower), upper);

  const demandStd = std(recent);
  const trendPct = m7 > 0 ? (slope * 7) / m7 : 0; // 近 7 天的趋势变化率

  // ---- 未来 N 天预测序列（用于折线图展示）----
  const forecastSeries = [];
  for (let h = 1; h <= forecastDays; h++) {
    const d = new Date(Date.now() + h * 86400000);
    forecastSeries.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      qty: Math.max(0, Math.round(level + trend * h)),
    });
  }

  return {
    dates,
    values,
    revenue,
    avgDaily: Math.round(avgDaily * 100) / 100,
    demandStd: Math.round(demandStd * 100) / 100,
    trend: Math.round(trendPct * 1000) / 1000,
    slope: Math.round(slope * 1000) / 1000,
    cv: Math.round(cv(recent) * 1000) / 1000,
    holt: Math.round(holt * 100) / 100,
    wma: Math.round(wma * 100) / 100,
    m7: Math.round(m7 * 100) / 100,
    m14: Math.round(m14 * 100) / 100,
    m30: Math.round(m30 * 100) / 100,
    forecastSeries,
    totalRevenue: Math.round(revenue.reduce((s, v) => s + v, 0) * 100) / 100,
    sampleDays: recent.length,
  };
}

module.exports = { forecastDemand, getDailySeries, mean, std, cv, linearRegression, normalInverse };
