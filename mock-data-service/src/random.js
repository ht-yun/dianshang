'use strict';
/**
 * 随机数工具库
 *
 * 业务仿真需要的不只是均匀分布：销量是长尾分布、价格是分档分布、
 * 库存消耗带泊松噪声。这里封装了支撑这些需求的采样函数。
 *
 * 设计要点：
 *   - 默认使用系统熵源（Math.random），保证每次请求结果都不同
 *   - 传入 seed 时切换为 mulberry32，可复现同一批数据，便于排查问题
 */

/** mulberry32：轻量可播种伪随机数发生器，返回 [0,1) */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  /** @param {number|string|null} seed 传种子则结果可复现，否则用系统熵源 */
  constructor(seed = null) {
    if (seed === null || seed === undefined || seed === '') {
      this._fn = Math.random;
      this.seeded = false;
    } else {
      const num = typeof seed === 'number' ? seed : hashString(String(seed));
      this._fn = mulberry32(num);
      this.seeded = true;
      this.seed = num;
    }
  }

  /** [0,1) 均匀分布 */
  next() {
    return this._fn();
  }

  /** 整数 [min, max] 闭区间 */
  int(min, max) {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    return lo + Math.floor(this._fn() * (hi - lo + 1));
  }

  /** 浮点 [min, max) */
  float(min, max) {
    return min + this._fn() * (max - min);
  }

  /** 以概率 p 返回 true */
  chance(p) {
    return this._fn() < p;
  }

  /** 数组随机取一个 */
  pick(arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[Math.floor(this._fn() * arr.length)];
  }

  /** 数组随机取 n 个（不重复，返回新数组） */
  sample(arr, n) {
    const pool = [...arr];
    const out = [];
    const take = Math.min(n, pool.length);
    for (let i = 0; i < take; i += 1) {
      const idx = Math.floor(this._fn() * pool.length);
      out.push(pool.splice(idx, 1)[0]);
    }
    return out;
  }

  /** 按权重抽样：items 为 [{ w: 权重, ... }] */
  weighted(items) {
    const total = items.reduce((s, it) => s + (Number(it.w) || 0), 0);
    if (total <= 0) return this.pick(items);
    let r = this._fn() * total;
    for (const it of items) {
      r -= Number(it.w) || 0;
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  }

  /**
   * 标准正态（Box-Muller 变换）
   * 用于给销量、价格加"看起来自然"的抖动——真实业务数据很少有均匀分布
   */
  normal(mu = 0, sigma = 1) {
    let u = 0;
    let v = 0;
    // 避免 log(0) 得到 -Infinity
    while (u === 0) u = this._fn();
    while (v === 0) v = this._fn();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mu + sigma * z;
  }

  /** 对数正态：天然右偏，贴合"多数商品销量平平、少数爆款"的电商现实 */
  lognormal(mu = 0, sigma = 1) {
    return Math.exp(this.normal(mu, sigma));
  }

  /** 泊松分布（Knuth 算法），适合建模单位时间内的订单到达数 */
  poisson(lambda) {
    if (!(lambda > 0)) return 0;
    if (lambda > 30) {
      // λ 较大时用正态近似，避免长循环
      return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))));
    }
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k += 1;
      p *= this._fn();
    } while (p > L);
    return k - 1;
  }
}

/** 字符串散列（FNV-1a 变体），用于把 item_id 映射成稳定的伪随机属性 */
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 数值夹取 */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 保留 n 位小数（避免 0.1+0.2 这类浮点噪声进入 JSON） */
function round(v, n = 2) {
  const p = 10 ** n;
  return Math.round(v * p) / p;
}

module.exports = { Rng, mulberry32, hashString, clamp, round };
