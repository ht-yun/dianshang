/**
 * API 请求封装：统一错误处理、超时保护与自动重试
 *
 * 为什么要加超时：fetch 本身没有超时机制。弱网或服务端假死时，
 * Promise 永远不会落地，页面会一直停在"加载中"，用户只能手动刷新。
 * 这里统一 12s 超时，GET 请求失败自动重试 1 次（写操作不重试，避免重复下单）。
 */
const BASE = '/api';
const TIMEOUT_MS = 12000;
const RETRY_DELAY_MS = 400;

/** 兼容性更好的超时信号 */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 发起一次请求，失败时抛出带 retryable 标记的错误 */
async function once(url, options) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: options.signal || timeoutSignal(TIMEOUT_MS) });
  } catch (err) {
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const e = new Error(isTimeout ? '请求超时，网络可能不稳定' : `网络请求失败：${err.message}`);
    e.retryable = true;
    e.cause = err;
    throw e;
  }

  const ct = res.headers.get('content-type') || '';
  let data;
  try {
    data = ct.includes('application/json') ? await res.json() : await res.text();
  } catch (err) {
    const e = new Error('响应内容解析失败');
    e.retryable = res.ok;
    throw e;
  }

  if (!res.ok) {
    const msg = (typeof data === 'object' && data && data.error) || `请求失败（${res.status}）`;
    const e = new Error(msg);
    e.status = res.status;
    // 5xx 可能是瞬时故障，可重试；4xx 是逻辑错误，重试无意义
    e.retryable = res.status >= 500;
    throw e;
  }
  return data;
}

async function request(path, options = {}) {
  const url = path.startsWith('http') ? path : BASE + path;
  const opts = { ...options };
  if (opts.body && typeof opts.body === 'object') {
    opts.body = JSON.stringify(opts.body);
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  }

  const method = (opts.method || 'GET').toUpperCase();
  const maxRetry = method === 'GET' ? 1 : 0;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      return await once(url, opts);
    } catch (err) {
      lastErr = err;
      if (!err.retryable || attempt === maxRetry) throw err;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body: body || {} }),
  put: (p, body) => request(p, { method: 'PUT', body: body || {} }),
  patch: (p, body) => request(p, { method: 'PATCH', body: body || {} }),
  del: (p) => request(p, { method: 'DELETE' }),

  // 业务接口
  overview: () => request('/dashboard/overview'),
  matrix: () => request('/dashboard/matrix'),
  products: (params = '') => request(`/products${params}`),
  product: (id) => request(`/products/${id}`),
  updateProduct: (id, body) => request(`/products/${id}`, { method: 'PATCH', body }),
  dict: () => request('/products/meta/dict'),

  suggestions: (params = '') => request(`/replenish/suggestions${params}`),
  generateSuggestions: () => request('/replenish/generate', { method: 'POST', body: {} }),
  reviewSuggestion: (id, body) => request(`/replenish/suggestions/${id}`, { method: 'PATCH', body }),
  batchApprove: (ids) => request('/replenish/batch-approve', { method: 'POST', body: { ids } }),
  explain: (productId) => request(`/replenish/explain/${productId}`),

  orders: (params = '') => request(`/orders${params}`),
  order: (id) => request(`/orders/${id}`),
  createOrders: (ids, remark) => request('/orders/from-suggestions', { method: 'POST', body: { ids, remark } }),
  updateOrderStatus: (id, status) => request(`/orders/${id}/status`, { method: 'PATCH', body: { status } }),
  exportOrder: (id) => request(`/orders/${id}/export`),

  alerts: (params = '') => request(`/alerts${params}`),
  scanAlerts: () => request('/alerts/scan', { method: 'POST', body: {} }),
  closeAlert: (id) => request(`/alerts/${id}/close`, { method: 'PATCH', body: {} }),
  closeAllAlerts: () => request('/alerts/close-all', { method: 'POST', body: {} }),

  priceComparison: (productId) => request(`/price/comparison${productId ? `?productId=${productId}` : ''}`),
  crawlPrices: (opts = {}) => request('/price/crawl', { method: 'POST', body: opts }),
  priceHistory: (productId) => request(`/price/history/${productId}`),

  settings: () => request('/system/settings'),
  saveSettings: (body) => request('/system/settings', { method: 'PUT', body }),
  validateFormula: (formula) => request('/system/settings/validate-formula', { method: 'POST', body: { formula } }),
  syncLogs: (limit = 50) => request(`/system/sync/logs?limit=${limit}`),
  syncNow: () => request('/system/sync/now', { method: 'POST', body: {} }),
  simulateOrder: () => request('/system/sync/simulate-order', { method: 'POST', body: {} }),
  meta: () => request('/system/meta'),

  // 数据源接入（仿真数据子系统）
  datasource: () => request('/datasource'),
  dsHealth: (url) => request(`/datasource/health?url=${encodeURIComponent(url)}`),
  dsTest: (body) => request('/datasource/test', { method: 'POST', body }),
  dsSave: (body) => request('/datasource/config', { method: 'POST', body }),
  dsPull: (body) => request('/datasource/pull', { method: 'POST', body }),
  dsProducts: () => request('/datasource/products'),
  dsUpstream: (sku) => request(`/datasource/upstream/${encodeURIComponent(sku)}`),
  dsClear: () => request('/datasource/clear', { method: 'POST', body: {} }),
};
