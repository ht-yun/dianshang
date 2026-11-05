/**
 * 应用入口：hash 路由、实时事件通道、全局操作
 */
import { api } from './api.js';
import { disposeCharts, bindChartResize, toast } from './utils.js';
import { emit } from './bus.js';
import { initOverlays, closeDrawer, closeModal } from './ui.js';
import { mountDashboard } from './views/dashboard.js';
import { mountInventory } from './views/inventory.js';
import { mountPricing } from './views/pricing.js';
import { mountReplenish } from './views/replenish.js';
import { mountOrders } from './views/orders.js';
import { mountAlerts } from './views/alerts.js';
import { mountSettings } from './views/settings.js';
import { mountDatasource } from './views/datasource.js';

const ROUTES = {
  dashboard: { title: '数据看板', sub: '全渠道库存与补货态势总览', mount: mountDashboard },
  inventory: { title: '商品库存', sub: '多平台库存明细、健康度与销售预测', mount: mountInventory },
  pricing: { title: '价格监控', sub: '跨平台售价采集、竞品比价与毛利结构', mount: mountPricing },
  replenish: { title: '智能补货', sub: 'AI 补货建议生成与人工核验', mount: mountReplenish },
  orders: { title: '供应商订单', sub: '采购单自动生成、状态流转与入库', mount: mountOrders },
  alerts: { title: '预警中心', sub: '库存水位与价格异常实时告警', mount: mountAlerts },
  datasource: { title: '数据源接入', sub: '仿真数据子系统联动与外部数据接入', mount: mountDatasource },
  settings: { title: '算法设置', sub: '补货参数、自定义公式与同步策略', mount: mountSettings },
};

const viewEl = document.getElementById('view');
let currentView = null;
let currentMount = null;
let currentCleanup = null;
// 渲染序号：超时后旧请求才返回时，用它判断是否已经被新一轮渲染取代，避免旧内容覆盖新页面
let renderSeq = 0;

/** 首屏骨架：JS 未执行时由 index.html 提供，路由切换时用它占位 */
const SKELETON = `
  <div class="boot-skeleton">
    <div class="bs-hero"></div>
    <div class="bs-row">
      <div class="bs-card"></div><div class="bs-card"></div>
      <div class="bs-card"></div><div class="bs-card"></div>
    </div>
    <div class="bs-row bs-row-wide">
      <div class="bs-card bs-tall"></div><div class="bs-card bs-tall"></div>
    </div>
    <div class="bs-text">正在加载…</div>
  </div>`;

/** 给 Promise 套一层超时，防止后端假死时页面无限等待 */
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function parseHash() {
  const raw = (location.hash || '#/dashboard').replace(/^#\/?/, '');
  const key = raw.split('?')[0] || 'dashboard';
  return ROUTES[key] ? key : 'dashboard';
}

async function render(force = false) {
  const key = parseHash();
  if (key === currentView && !force) return;

  // 路由切换时清理浮层，避免抽屉/弹窗跨页面残留
  closeDrawer();
  closeModal();

  disposeCharts();
  if (typeof currentCleanup === 'function') {
    try { currentCleanup(); } catch (_) { /* 忽略清理异常 */ }
    currentCleanup = null;
  }
  currentView = key;
  const seq = ++renderSeq;

  const route = ROUTES[key];
  document.getElementById('page-title').textContent = route.title;
  document.getElementById('page-sub').textContent = route.sub;
  document.title = `${route.title} · 智能库存补货系统`;

  document.querySelectorAll('.nav-item').forEach((a) => {
    a.classList.toggle('active', a.dataset.view === key);
  });

  viewEl.innerHTML = SKELETON;
  viewEl.scrollTop = 0;

  try {
    const cleanup = await withTimeout(route.mount(viewEl), 20000, '页面加载超时');
    if (seq !== renderSeq) return; // 已被新一轮渲染取代
    if (typeof cleanup === 'function') currentCleanup = cleanup;
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error(err);
    const isTimeout = /超时/.test(err.message);
    viewEl.innerHTML = `
      <div class="card" style="border-color:rgba(244,63,94,.35);max-width:560px">
        <div class="card-title" style="margin-bottom:10px">${isTimeout ? '页面加载超时' : '页面加载失败'}</div>
        <p style="font-size:13px;color:var(--text-2);line-height:1.7">
          ${err.message}
          <br>
          <span style="color:var(--text-3);font-size:12px">
            ${isTimeout
              ? '服务器响应较慢或网络不稳定，通常是临时现象，重新加载即可'
              : '请确认后端服务已启动（默认 http://localhost:3000）'}
          </span>
        </p>
        <button class="btn btn-primary" style="margin-top:14px" onclick="location.reload()">重新加载</button>
      </div>`;
  }

  // 移动端切换后收起侧栏
  document.getElementById('sidebar').classList.remove('open');
  currentMount = route.mount;
}

/* ---------------- 实时通道 ---------------- */
let eventSource = null;

function connectStream() {
  if (eventSource) eventSource.close();
  const state = document.getElementById('conn-state');
  if (!state) return;
  try {
    eventSource = new EventSource('/api/dashboard/stream');

    eventSource.addEventListener('connected', () => {
      state.className = 'live-dot on';
      state.querySelector('span').textContent = '实时通道已连接';
    });

    eventSource.addEventListener('order.paid', (e) => {
      const d = JSON.parse(e.data);
      document.getElementById('last-sync').textContent = `刚刚同步 · ${d.at.split(' ')[1] || ''}`;
      emit('order.paid', d);
    });

    eventSource.addEventListener('stock.changed', (e) => emit('stock.changed', JSON.parse(e.data)));
    eventSource.addEventListener('sync.done', (e) => {
      const d = JSON.parse(e.data);
      document.getElementById('last-sync').textContent = `同步完成 ${d.at.split(' ')[1] || ''}`;
      emit('sync.done', d);
    });
    eventSource.addEventListener('inventory.recomputed', (e) => emit('recomputed', JSON.parse(e.data)));

    eventSource.onerror = () => {
      state.className = 'live-dot off';
      state.querySelector('span').textContent = '实时通道重连中…';
    };
  } catch (err) {
    state.className = 'live-dot off';
    state.querySelector('span').textContent = '实时通道不可用';
  }
}

/* ---------------- 全局按钮 ---------------- */
function bindGlobalActions() {
  document.getElementById('menu-btn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  document.getElementById('btn-sync').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api.syncNow();
      toast(`已同步 ${r.platforms} 个平台，${r.changed} 条库存发生变化`, 'success', '同步完成');
      emit('sync.done', r);
      if (currentMount) render(true);
    } catch (err) {
      toast(err.message, 'danger', '同步失败');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-simulate').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api.simulateOrder();
      toast(`${r.event.sku} 在${r.event.platformName}成交 ${r.event.qty} 件，剩余库存 ${r.event.stockAfter}`, 'info', '模拟订单事件');
      emit('order.paid', r.event);
    } catch (err) {
      toast(err.message, 'danger', '模拟失败');
    } finally {
      btn.disabled = false;
    }
  });
}

/** 刷新角标：待审建议数与预警数 */
export async function refreshBadges() {
  try {
    const [sug, al] = await Promise.all([api.suggestions('?status=pending'), api.alerts('?status=open&limit=1')]);
    const b1 = document.getElementById('badge-replenish');
    const b2 = document.getElementById('badge-alerts');
    const pending = sug.summary?.pending || 0;
    const alerts = al.stats?.total || 0;
    b1.hidden = pending === 0;
    b1.textContent = pending;
    b2.hidden = alerts === 0;
    b2.textContent = alerts;
  } catch (_) { /* 角标失败不影响主流程 */ }
}

/* ---------------- 启动 ---------------- */
function boot() {
  initOverlays();
  bindGlobalActions();
  bindChartResize();
  connectStream();

  /**
   * SSE 是长连接，每个标签页占一条。HTTP/1.1 下浏览器对同一域名只有 6 条并发连接，
   * 同时开多个标签页时普通请求会被长连接挤到排队，表现为"页面加载不出来"。
   * 页面切到后台就主动释放，回到前台再重连。
   */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    } else if (!eventSource) {
      connectStream();
    }
  });

  window.addEventListener('hashchange', () => render());
  render();
  refreshBadges();
  // 每 45 秒刷新一次角标
  setInterval(refreshBadges, 45000);
}

boot();
