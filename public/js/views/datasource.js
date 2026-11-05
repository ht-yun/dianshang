/**
 * 数据源接入：双系统联动的控制台
 *
 * 左侧配置并操作仿真数据子系统，右侧展示连通性与同步结果，
 * 顶部用拓扑图说明「数据生产者 → 适配层 → 主系统业务」的分层关系。
 */
import { api } from '../api.js';
import { esc, num, toast, skeleton, confirmDialog } from '../utils.js';
import { openModal, setModalBody, closeModal } from '../ui.js';

/** 拓扑节点：把一个数据流画成可读的分层结构 */
function topoNode(title, sub, tone = '', dimmed = false) {
  let bg = 'linear-gradient(145deg,rgba(255,255,255,.78),rgba(255,255,255,.55))';
  let border = 'rgba(148,163,184,.28)';
  let opacity = '1';
  if (tone === 'source') {
    bg = 'linear-gradient(145deg,rgba(37,99,235,.10),rgba(37,99,235,.04))';
    border = 'rgba(37,99,235,.30)';
  } else if (tone === 'adapter') {
    bg = 'linear-gradient(145deg,rgba(124,58,237,.10),rgba(124,58,237,.04))';
    border = 'rgba(124,58,237,.28)';
  }
  // 离线时整块降透明度，避免"蓝色高亮"让人误以为数据源在工作
  if (dimmed) opacity = '.45';
  return `
    <div style="flex:1;min-width:128px;padding:12px 14px;border-radius:10px;opacity:${opacity};
      background:${bg};border:1px solid ${border}">
      <div style="font-size:12.5px;font-weight:600;margin-bottom:3px">${esc(title)}</div>
      <div style="font-size:10.5px;color:var(--text-3);line-height:1.5">${esc(sub)}</div>
    </div>`;
}

const arrow = '<div class="topo-arrow" style="color:var(--text-3);font-size:15px;padding:0 2px;flex:none">→</div>';

/** 三种拉取模式的业务含义：直接写进下拉标签，避免让用户去猜 pool/chaos 是什么 */
const MODE_TEXT = {
  stable: {
    label: '同一批商品演进',
    desc: '每次命中商品池里固定的一批商品，库存逐步下降，适合长期演示补货触发',
  },
  pool: {
    label: '随机抽取',
    desc: '每次随机挑一批商品，商品集合会变化，数值依然连续演进',
  },
  chaos: {
    label: '每次上架全新商品',
    desc: '每次都是全新货号，商品表会持续增长 —— 仅用于「新商品上架」演示',
  },
};

function topologyHtml(online) {
  return `
    <div class="card mb-14">
      <div class="card-head">
        <div class="card-title">双系统联动架构</div>
        <span class="card-sub">数据生产与业务消费彻底解耦，数据源可随时替换</span>
      </div>
      <div style="display:flex;align-items:stretch;gap:4px;flex-wrap:wrap">
        ${topoNode('仿真数据子系统', online ? '在线 · :4100' : '离线 · 待启动', 'source', !online)}
        ${arrow}
        ${topoNode('HTTP / JSON', '标准 REST 契约', 'adapter')}
        ${arrow}
        ${topoNode('数据源适配层', '字段映射 · 拆单 · 增量入库', 'adapter')}
        ${arrow}
        ${topoNode('商品 / 库存 / 销量', '主系统核心业务表')}
        ${arrow}
        ${topoNode('补货算法 → 看板', '预测 · 建议 · 预警')}
      </div>
      <div style="margin-top:11px;padding:9px 12px;border-radius:8px;background:rgba(255,255,255,.55);
        border:1px dashed rgba(148,163,184,.3);font-size:11.5px;color:var(--text-3);line-height:1.65">
        <b style="color:var(--text-2)">可替换性：</b>
        适配层只依赖 <code style="font-family:var(--mono);color:var(--cyan)">item_id / title / stock / sales / price / category / min_stock</code>
        这七个字段。将来对接真实电商 API，只需在适配层重写字段映射，
        补货算法、预警、采购单与看板均无需改动。
      </div>
    </div>`;
}

function statusKpi(s) {
  const h = s.health || {};
  const online = Boolean(h.online);
  return `
    <div class="kpi-grid mb-14">
      <div class="kpi">
        <div class="kpi-label">连接状态</div>
        <div class="kpi-value" style="color:${online ? 'var(--success,#22C55E)' : 'var(--danger,#E11D48)'}">
          ${online ? '在线' : '离线'}
        </div>
        <div class="kpi-foot">${online ? '健康检查通过' : esc(h.error || '未探测')}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">响应延迟</div>
        <div class="kpi-value">${online && h.latency_ms != null ? h.latency_ms : '—'}<span style="font-size:12px;color:var(--text-3);margin-left:2px">${online ? 'ms' : ''}</span></div>
        <div class="kpi-foot">${online ? '本地 HTTP 往返' : '未获得有效响应'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">已接入商品</div>
        <div class="kpi-value">${s.products.imported}<span style="font-size:12px;color:var(--text-3);margin-left:2px">/ ${s.products.total}</span></div>
        <div class="kpi-foot">仿真商品 / 商品总数</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">数据源商品池</div>
        <div class="kpi-value">${h.pool_size != null ? h.pool_size : '—'}</div>
        <div class="kpi-foot">可抽取的商品总数</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">定时同步</div>
        <div class="kpi-value" style="color:${s.config.enabled ? 'var(--cyan,#0E7490)' : 'var(--text-3)'}">
          ${s.config.enabled ? '运行中' : '已关闭'}
        </div>
        <div class="kpi-foot">每 ${s.config.interval} 秒拉取一次</div>
      </div>
    </div>`;
}

function configCard(s) {
  const c = s.config;
  return `
    <div class="card mb-14">
      <div class="card-head">
        <div class="card-title">连接配置</div>
        <span class="card-sub">指向仿真数据服务，也可填任意符合契约的 HTTP 地址</span>
      </div>
      <div class="field">
        <label>数据源地址</label>
        <input class="input" id="ds_url" value="${esc(c.url)}" placeholder="http://127.0.0.1:4100">
        <div class="hint">只允许 http/https。数据源需提供 <code>GET /api/products</code></div>
      </div>
      <div class="grid grid-2">
        <div class="field">
          <label>拉取模式</label>
          <select class="input" id="ds_mode">
            ${Object.entries(MODE_TEXT).map(([k, v]) => (
              `<option value="${k}" ${c.mode === k ? 'selected' : ''}>${k} · ${v.label}</option>`
            )).join('')}
          </select>
          <div class="hint" id="ds_mode_hint">${esc((MODE_TEXT[c.mode] || MODE_TEXT.stable).desc)}</div>
        </div>
        <div class="field">
          <label>单次拉取条数</label>
          <input class="input" id="ds_batch" type="number" min="1" max="100" value="${c.batch}">
          <div class="hint">建议 8~15 条，过多会让商品列表过于杂乱</div>
        </div>
        <div class="field">
          <label>同步间隔（秒）</label>
          <input class="input" id="ds_interval" type="number" min="10" max="3600" value="${c.interval}">
          <div class="hint">开启定时同步后按此间隔自动拉取</div>
        </div>
        <div class="field">
          <label>切片起始偏移</label>
          <input class="input" id="ds_offset" type="number" min="0" value="${c.offset}">
          <div class="hint">stable 模式下换一批商品，如 12、24、36</div>
        </div>
      </div>

      <label class="switch" style="margin:6px 0 4px">
        <input type="checkbox" id="ds_enabled" ${c.enabled ? 'checked' : ''}>
        <span class="track"></span>
        <span style="font-size:12.5px">启用定时同步（外部数据源接管库存主数据）</span>
      </label>
      <div class="hint" style="margin:2px 0 14px 48px">
        启用后主系统内置的订单模拟会自动停止 —— 库存只能有一个来源，
        两套数据同时改写会产生无法解释的跳变。
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" id="ds_pull">立即同步</button>
        <button class="btn btn-ghost" id="ds_save">保存配置</button>
        <button class="btn btn-ghost" id="ds_test">测试连接</button>
        <button class="btn btn-danger" id="ds_clear" style="margin-left:auto">清除仿真商品</button>
      </div>
    </div>`;
}

/**
 * 新商品上架演示（chaos 模式）
 *
 * 这是「数据源源源不断产生新数据」最直观的一屏：点一下，商品表多出一批全新货号，
 * 它们立刻进入补货算法与看板统计，但已保存的拉取模式不变。
 */
function arrivalsCard(s) {
  const last = (s.runtime && s.runtime.last_result) || null;
  const fromChaos = last && last.mode === 'chaos';
  const arrivals = fromChaos && Array.isArray(last.created_items) ? last.created_items : [];

  const list = arrivals.length === 0
    ? `<div style="font-size:12px;color:var(--text-3)">
         ${fromChaos ? '本次没有新增商品（返回的货号都已在系统中）'
           : `还没有通过本页上架过新商品${last ? `（上次同步用的是 ${esc(last.mode || 'stable')} 模式）` : ''}`}
       </div>`
    : `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(232px,1fr));gap:7px">
        ${arrivals.map((a) => `
          <div style="display:flex;gap:8px;align-items:center;padding:7px 9px;border-radius:8px;
            background:rgba(34,211,238,.06);border:1px solid rgba(34,211,238,.18)">
            <span class="badge" style="background:rgba(14,116,144,.12);color:#0E7490;font-size:10px;flex:none">新</span>
            <div style="min-width:0;flex:1">
              <div style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</div>
              <div style="font-size:10.5px;color:var(--text-3);font-family:var(--mono)">
                ${esc(a.sku)} · ¥${a.price} · 库存 ${a.stock}
              </div>
            </div>
          </div>`).join('')}
      </div>`;

  return `
    <div class="card mb-14">
      <div class="card-head">
        <div class="card-title">新商品上架演示</div>
        <span class="card-sub">临时以 chaos 模式拉取，不改变已保存的拉取模式</span>
      </div>
      <div style="display:flex;gap:9px;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="margin-bottom:0;width:112px">
          <label>上架数量</label>
          <input class="input" id="ds_arrive_count" type="number" min="1" max="50" value="5">
        </div>
        <button class="btn btn-primary" id="ds_arrive">上架一批新商品</button>
      </div>
      <div class="hint" style="margin-top:9px;line-height:1.65">
        chaos 模式每个商品都是全新货号，接入后立刻进入补货算法与看板统计，
        用来演示「新商品上架 → 自动纳入补货策略」。
        注意：若把 <code>chaos</code> 设为默认模式并开启定时同步，商品表会持续增长。
      </div>
      ${fromChaos ? `
        <div style="margin-top:14px;padding-top:13px;border-top:1px solid var(--line)">
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:9px">
            本次上架 <b style="color:var(--text-2)">${arrivals.length}</b> 个新商品${last.created ? `，商品表新增 ${last.created} 条` : ''}
          </div>
          ${list}
        </div>` : `<div style="margin-top:13px">${list}</div>`}
    </div>`;
}

function statusCard(s) {
  const h = s.health || {};
  const online = Boolean(h.online);
  const r = s.runtime || {};
  return `
    <div class="card mb-14">
      <div class="card-head">
        <div class="card-title">服务信息</div>
        <span class="card-sub">最近一次探测结果</span>
      </div>
      ${online ? `
        <div class="info-grid">
          <div class="info-item"><span>服务名称</span><b>${esc(h.service || '-')}</b></div>
          <div class="info-item"><span>版本</span><b>v${esc(h.version || '-')}</b></div>
          <div class="info-item"><span>运行时长</span><b>${h.uptime_seconds != null ? Math.floor(h.uptime_seconds / 60) + ' 分钟' : '-'}</b></div>
          <div class="info-item"><span>商品池</span><b>${h.pool_size ?? '-'} 个</b></div>
        </div>` : `
        <div style="padding:14px;border-radius:9px;background:rgba(244,63,94,.08);
          border:1px solid rgba(244,63,94,.28);font-size:12px;line-height:1.75;color:var(--text-2)">
          <b style="color:#E11D48">数据源未启动</b><br>
          ${esc(h.error || '无法连接')}<br>
          <span style="color:var(--text-3)">请在另一个终端执行：</span>
          <code style="font-family:var(--mono);color:var(--cyan);font-size:11.5px">cd mock-data-service &amp;&amp; npm start</code>
        </div>`}

      <div style="margin-top:14px">
        <div style="font-size:11.5px;color:var(--text-3);margin-bottom:8px">最近同步结果</div>
        ${r.last_result ? `
          <div class="info-grid">
            <div class="info-item"><span>拉取条数</span><b>${r.last_result.fetched ?? '-'}</b></div>
            <div class="info-item"><span>新增 / 更新</span><b>${r.last_result.created ?? 0} / ${r.last_result.updated ?? 0}</b></div>
            <div class="info-item"><span>耗时</span><b>${r.last_result.latency_ms ?? '-'} ms</b></div>
            <div class="info-item"><span>请求编号</span><b style="font-family:var(--mono);font-size:11px">${esc(r.last_result.request_id || '-')}</b></div>
          </div>` : `
          <div style="font-size:12px;color:var(--text-3)">尚未执行过同步</div>`}
        ${r.last_error ? `<div style="margin-top:9px;font-size:11.5px;color:#E11D48">${esc(r.last_error)}</div>` : ''}
      </div>
    </div>`;
}

function logsCard(s) {
  const rows = s.recent_logs || [];
  return `
    <div class="card mb-14">
      <div class="card-head">
        <div class="card-title">同步记录</div>
        <span class="card-sub">最近 10 次拉取</span>
      </div>
      ${rows.length === 0 ? '<div class="empty" style="padding:22px">暂无同步记录，点击「立即同步」试一次</div>' : `
      <div class="table-wrap">
        <table class="data">
          <thead><tr>
            <th style="min-width:132px">时间</th>
            <th style="min-width:66px">状态</th>
            <th class="num" style="min-width:66px">耗时</th>
            <th>详情</th>
          </tr></thead>
          <tbody>
            ${rows.map((l) => {
              let detail = '';
              try {
                const p = JSON.parse(l.payload || '{}');
                detail = p.error || `拉取 ${p.fetched ?? 0} 条 · 新增 ${p.created ?? 0} · 更新 ${p.updated ?? 0}`;
              } catch (_) { detail = '-'; }
              return `<tr>
                <td class="sku">${esc(l.created_at)}</td>
                <td><span class="badge ${l.status === 'success' ? 'badge-success' : 'badge-critical'}">${l.status === 'success' ? '成功' : '失败'}</span></td>
                <td class="num">${l.latency_ms} ms</td>
                <td class="pmeta" style="color:var(--text-2)">${esc(detail)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`}
    </div>`;
}

function productsCard(list) {
  return `
    <div class="card">
      <div class="card-head">
        <div class="card-title">已接入的仿真商品</div>
        <span class="card-sub">这些商品已进入补货算法的计算范围，点「上游对照」可核对原始数据</span>
      </div>
      ${list.length === 0 ? '<div class="empty" style="padding:28px">还没有接入任何仿真商品</div>' : `
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th style="min-width:108px">商品编号</th>
              <th style="min-width:230px">商品标题</th>
              <th style="min-width:76px">品类</th>
              <th class="num" style="min-width:66px">库存</th>
              <th class="num" style="min-width:78px">30日销量</th>
              <th class="num" style="min-width:70px">售价</th>
              <th style="min-width:84px">接入时间</th>
              <th style="min-width:84px">操作</th>
            </tr>
          </thead>
          <tbody>
            ${list.map((p) => `<tr>
              <td class="sku">${esc(p.sku)}</td>
              <td class="pname" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</td>
              <td><span class="badge badge-muted">${esc(p.category)}</span></td>
              <td class="num">${num(p.stock)}</td>
              <td class="num">${num(p.sales_30d)}</td>
              <td class="num">¥${p.suggest_price}</td>
              <td class="pmeta">${esc((p.imported_at || '').slice(5, 16))}</td>
              <td><button class="btn btn-ghost btn-sm" data-upstream="${esc(p.sku)}">上游对照</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`}
    </div>`;
}

/** 数据源商品池的库存状态分布：一眼看出数据源能提供多少种业务场景 */
function poolCard(s) {
  const pool = s.health && s.health.pool;
  if (!pool) return '';
  const total = Object.values(pool).reduce((a, b) => a + b, 0) || 1;
  const defs = [
    { key: 'out', label: '断货', color: '#E11D48' },
    { key: 'low', label: '紧缺', color: '#D97706' },
    { key: 'healthy', label: '健康', color: '#22C55E' },
    { key: 'overstock', label: '积压', color: '#8B5CF6' },
  ];
  return `
    <div class="card" style="margin-top:14px">
      <div class="card-head">
        <div class="card-title">数据源商品池</div>
        <span class="card-sub">共 ${total} 个可抽取商品</span>
      </div>
      ${defs.map((d) => {
        const v = pool[d.key] || 0;
        const w = (v / total) * 100;
        return `<div style="display:flex;align-items:center;gap:9px;margin-bottom:9px">
          <span style="font-size:11.5px;color:var(--text-2);width:32px;flex:none">${d.label}</span>
          <div class="bar" style="flex:1"><i style="width:${w.toFixed(1)}%;background:${d.color}"></i></div>
          <span style="font-size:11.5px;font-family:var(--mono);color:var(--text-2);width:34px;text-align:right;flex:none">${v}</span>
        </div>`;
      }).join('')}
    </div>`;
}

/** 差异单元格：0 表示本地与上游一致，非 0 用琥珀色提示"数据源又演进了" */
function diffCell(v, digits = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '<span style="color:var(--text-3)">—</span>';
  if (n === 0) return '<span style="color:#22C55E">0</span>';
  const txt = (n > 0 ? '+' : '') + (digits ? n.toFixed(digits) : num(n));
  return `<span style="color:#D97706">${txt}</span>`;
}

/**
 * 上游原始值 vs 主系统本地值
 * 这是「数据确实来自数据源」最直接的证据：同步刚完成时三行差异全是 0。
 */
async function openUpstream(sku) {
  openModal('上游数据对照', '<div style="font-size:12.5px;color:var(--text-3);padding:8px 0">正在向数据源查询…</div>');
  let r;
  try {
    r = await api.dsUpstream(sku);
  } catch (err) {
    openModal(
      '上游对照失败',
      `<div style="font-size:12.5px;color:#E11D48;line-height:1.8">${esc(err.message)}</div>
       <div class="hint" style="margin-top:9px">若数据源已重启且该商品是 chaos 模式上架的，
       它可能已不在最近上架缓存中（保留最近 300 个）。</div>`,
      '<button class="btn btn-primary" data-close>关闭</button>'
    );
    return;
  }

  const u = r.upstream || {};
  const l = r.local;
  const d = r.diff || {};
  const rows = [
    ['库存', num(u.stock), l ? num(l.stock) : '—', d.stock],
    ['30 日销量', num(u.sales), l ? num(l.sales_30d) : '—', d.sales],
    ['售价', `¥${u.price}`, l ? `¥${l.suggest_price}` : '—', d.price],
  ];

  openModal(
    `上游对照 · ${sku}`,
    `<div class="info-grid" style="margin-bottom:13px">
      <div class="info-item"><span>数据源</span><b style="font-family:var(--mono);font-size:11px">${esc(r.source)}</b></div>
      <div class="info-item"><span>上游库存状态</span><b>${esc(u.stock_status || '-')}</b></div>
      <div class="info-item"><span>商品来源</span><b>${u.pooled ? '商品池' : '最近上架缓存'}</b></div>
      <div class="info-item"><span>上游仿真时长</span><b>${u.simulated_hours ?? '-'} 小时</b></div>
    </div>
    <div style="font-size:11.5px;color:var(--text-3);margin-bottom:8px">${esc(u.title || '')}</div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr>
          <th style="min-width:96px">字段</th>
          <th class="num" style="min-width:96px">数据源</th>
          <th class="num" style="min-width:96px">主系统</th>
          <th class="num" style="min-width:86px">差异</th>
        </tr></thead>
        <tbody>
          ${rows.map(([name, a, b, dv]) => `<tr>
            <td>${name}</td>
            <td class="num">${a}</td>
            <td class="num">${b}</td>
            <td class="num">${diffCell(dv, name === '售价' ? 2 : 0)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="hint" style="margin-top:11px;line-height:1.7">
      差异全是 0，说明本地库存与销量确实来自数据源本次同步的结果。
      若出现差异，通常是数据源在上次同步后又推进了仿真时间 —— 点「立即同步」即可拉平。
    </div>`,
    '<button class="btn btn-primary" data-close>关闭</button>'
  );
}

export async function mountDatasource(root) {
  root.innerHTML = skeleton(4);

  let status = null;
  let items = [];

  async function load() {
    const [st, pl] = await Promise.all([api.datasource(), api.dsProducts()]);
    status = st;
    items = pl.list;
  }

  function paint() {
    root.innerHTML = `
      ${topologyHtml(status.health && status.health.online)}
      ${statusKpi(status)}
      <div class="grid grid-21">
        <div>${configCard(status)}${arrivalsCard(status)}</div>
        <div>${statusCard(status)}${poolCard(status)}</div>
      </div>
      ${logsCard(status)}
      ${productsCard(items)}`;
    bind();
  }

  async function refresh() {
    await load();
    paint();
  }

  function bind() {
    const $ = (id) => root.querySelector(`#${id}`);

    // 切换模式时立刻更新说明，避免选到 chaos 却不知道后果
    $('ds_mode').addEventListener('change', (e) => {
      const m = MODE_TEXT[e.currentTarget.value] || MODE_TEXT.stable;
      $('ds_mode_hint').textContent = m.desc;
    });

    // 新商品上架（一次性 chaos 拉取，不改动已保存模式）
    $('ds_arrive').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const count = Math.min(50, Math.max(1, Number($('ds_arrive_count').value) || 5));
      btn.disabled = true;
      btn.textContent = '上架中…';
      try {
        const r = await api.dsPull({ mode: 'chaos', count });
        await refresh();
        const list = r.created_items || [];
        // 优先用拉取接口自带的总数：它与本次入库在同一事务后即时取得，
        // 不会因为刷新请求的时序而与「新增商品」数目对不上
        const totalNow = r.total ?? status.products.total;
        openModal(
          `新商品上架完成 · ${list.length} 个`,
          `<div class="info-grid" style="margin-bottom:13px">
            <div class="info-item"><span>拉取条数</span><b>${r.fetched}</b></div>
            <div class="info-item"><span>新增商品</span><b>${r.created}</b></div>
            <div class="info-item"><span>耗时</span><b>${r.latency_ms} ms</b></div>
            <div class="info-item"><span>商品总数</span><b>${totalNow}</b></div>
          </div>
          ${list.length === 0 ? '<div class="hint">本次返回的货号都已在系统中</div>' : `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th style="min-width:104px">货号</th><th>商品标题</th>
                <th class="num" style="min-width:70px">库存</th><th class="num" style="min-width:70px">售价</th></tr></thead>
              <tbody>${list.map((a) => `<tr>
                <td class="sku">${esc(a.sku)}</td>
                <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</td>
                <td class="num">${num(a.stock)}</td>
                <td class="num">¥${a.price}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>`}
          <div class="hint" style="margin-top:11px;line-height:1.7">
            这批商品已写入商品表并分摊到各平台，已进入补货算法的计算范围；
            可在下方列表点「上游对照」核对本地值与数据源原始值是否一致。
          </div>`,
          '<button class="btn btn-primary" data-close>知道了</button>'
        );
      } catch (err) {
        toast(err.message, 'danger', '上架失败');
      } finally {
        btn.disabled = false;
        btn.textContent = '上架一批新商品';
      }
    });

    // 每行「上游对照」
    root.querySelectorAll('[data-upstream]').forEach((b) => {
      b.addEventListener('click', () => openUpstream(b.dataset.upstream));
    });

    // 保存配置
    $('ds_save').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api.dsSave({
          url: $('ds_url').value.trim(),
          mode: $('ds_mode').value,
          batch: Number($('ds_batch').value),
          interval: Number($('ds_interval').value),
          offset: Number($('ds_offset').value),
        });
        toast('数据源配置已保存', 'success');
        await refresh();
      } catch (err) {
        toast(err.message, 'danger', '保存失败');
      } finally {
        btn.disabled = false;
      }
    });

    // 定时同步开关
    $('ds_enabled').addEventListener('change', async (e) => {
      const on = e.currentTarget.checked;
      try {
        await api.dsSave({ enabled: on });
        toast(
          on ? '已启用定时同步，内置订单模拟已停止' : '已关闭定时同步，内置订单模拟已恢复',
          on ? 'success' : 'info',
          '数据源状态变更'
        );
        await refresh();
      } catch (err) {
        toast(err.message, 'danger', '操作失败');
        e.currentTarget.checked = !on;
      }
    });

    // 立即同步
    $('ds_pull').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '同步中…';
      try {
        const r = await api.dsPull({ count: Number($('ds_batch').value), mode: $('ds_mode').value });
        const sug = r.suggestions ? `，新增补货建议 ${r.suggestions.created} 条` : '';
        toast(
          `拉取 ${r.fetched} 条（新增 ${r.created} / 更新 ${r.updated}），${r.latency_ms}ms${sug}`,
          'success',
          '同步完成'
        );
        await refresh();
      } catch (err) {
        toast(err.message, 'danger', '同步失败');
        btn.disabled = false;
        btn.textContent = '立即同步';
      }
    });

    // 测试连接
    $('ds_test').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await api.dsTest({ url: $('ds_url').value.trim(), mode: $('ds_mode').value });
        if (!r.ok) {
          toast(r.health && r.health.error ? r.health.error : r.error || '连接失败', 'danger', '连接失败');
        } else {
          openModal(
            '数据源连接正常',
            `<div style="font-size:12.5px;line-height:1.8;margin-bottom:12px">
               延迟 <b>${r.health.latency_ms}ms</b> ·
               服务 <b>${esc(r.health.service)}</b> v${esc(r.health.version)} ·
               商品池 <b>${r.health.pool_size}</b> 个
             </div>
             <div style="font-size:11.5px;color:var(--text-3);margin-bottom:7px">接口返回样例（前 3 条，未写入数据库）</div>
             <pre style="font-family:var(--mono);font-size:11px;line-height:1.65;background:rgba(0,0,0,.28);
               padding:12px;border-radius:8px;overflow:auto;max-height:320px;color:var(--text-2)">${esc(JSON.stringify(r.sample, null, 2))}</pre>`,
            '<button class="btn btn-primary" data-close>知道了</button>'
          );
        }
      } catch (err) {
        toast(err.message, 'danger', '测试失败');
      } finally {
        btn.disabled = false;
      }
    });

    // 清除仿真商品
    $('ds_clear').addEventListener('click', async () => {
      const ok = await confirmDialog(
        '清除仿真商品',
        `将从主系统删除全部 ${status.products.imported} 个仿真商品及其库存、销量、建议记录，此操作不可撤销。`,
        '确认清除',
        true
      );
      if (!ok) return;
      try {
        const r = await api.dsClear();
        toast(r.message, 'success');
        await refresh();
      } catch (err) {
        toast(err.message, 'danger', '清除失败');
      }
    });
  }

  await load();
  paint();
}
