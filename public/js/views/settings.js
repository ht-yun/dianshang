/**
 * 算法设置：补货参数、自定义公式、同步策略
 * 所有参数变更后会立即按新参数重算补货建议
 */
import { api } from '../api.js';
import { esc, toast, debounce, skeleton } from '../utils.js';

export async function mountSettings(root) {
  root.innerHTML = skeleton(4);
  const data = await api.settings();
  const s = data.settings;

  const sw = (id, checked, label, hint) => `
    <label class="switch" style="margin-bottom:8px">
      <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
      <span class="track"></span>
      <span style="font-size:12.5px">${label}</span>
    </label>
    ${hint ? `<div class="hint" style="margin:-2px 0 14px 48px">${hint}</div>` : ''}
  `;

  root.innerHTML = `
    <div class="grid grid-21">
      <div>
        <div class="card mb-14">
          <div class="card-head">
            <div class="card-title">补货算法参数</div>
            <span class="card-sub">修改后立即按新参数重算全部商品</span>
          </div>

          <div class="grid grid-2">
            <div class="field">
              <label>服务水平（库存满足率）</label>
              <input class="input" id="service_level" type="number" min="0.5" max="0.999" step="0.005"
                value="${esc(s.service_level)}">
              <div class="hint">越高越不容易缺货，但安全库存与资金占用同步上升。0.95 → z=1.645</div>
            </div>
            <div class="field">
              <label>预测窗口（天）</label>
              <input class="input" id="forecast_window" type="number" min="7" max="90" step="1"
                value="${esc(s.forecast_window)}">
              <div class="hint">参与需求预测的历史天数，窗口越长越平滑</div>
            </div>
            <div class="field">
              <label>预测权重（7日,14日,30日）</label>
              <input class="input" id="forecast_weights" value="${esc(s.forecast_weights)}">
              <div class="hint">三个权重之和会自动归一化，近期权重应更高</div>
            </div>
            <div class="field">
              <label>默认覆盖天数</label>
              <input class="input" id="cover_days" type="number" min="1" max="120" value="${esc(s.cover_days)}">
              <div class="hint">补货后要覆盖的天数；商品级设置优先于此值</div>
            </div>
            <div class="field">
              <label>兜底安全天数</label>
              <input class="input" id="safety_days" type="number" min="1" max="60" value="${esc(s.safety_days)}">
              <div class="hint">无历史销量数据的新品使用此天数估算安全库存</div>
            </div>
            <div class="field">
              <label>积压预警阈值（天）</label>
              <input class="input" id="alert_overstock_days" type="number" min="30" max="365" value="${esc(s.alert_overstock_days)}">
              <div class="hint">可售天数超过此值判定为库存积压</div>
            </div>
            <div class="field">
              <label>滞销预警阈值（天）</label>
              <input class="input" id="alert_slow_days" type="number" min="7" max="365" value="${esc(s.alert_slow_days)}">
              <div class="hint">连续无销量的天数达到此值触发滞销预警</div>
            </div>
            <div class="field">
              <label>价格采集间隔（秒）</label>
              <input class="input" id="price_crawl_interval" type="number" min="30" max="86400" value="${esc(s.price_crawl_interval)}">
              <div class="hint">定时采集各平台售价的频率</div>
            </div>
          </div>

          ${sw('auto_replenish', s.auto_replenish === '1', '库存变化时自动生成补货建议与预警',
            '关闭后仅能通过「重新计算」按钮手动触发')}
        </div>

        <div class="card mb-14">
          <div class="card-head">
            <div class="card-title">自定义补货公式 <span class="card-sub">适配企业个性化规则</span></div>
          </div>

          ${sw('custom_formula_enabled', s.custom_formula_enabled === '1', '启用自定义公式覆盖默认算法',
            '启用后，补货量将完全按下方公式计算；公式出错会自动回落默认算法，不会中断业务')}

          <div class="field">
            <label>补货量公式</label>
            <textarea class="input" id="custom_formula" rows="3" spellcheck="false">${esc(s.custom_formula)}</textarea>
            <div class="hint" id="formula-status">支持 + - * / % ^ 与括号，以及 sqrt/abs/min/max/ceil/floor/round 函数</div>
          </div>

          <div style="font-size:11.5px;color:var(--text-3);line-height:1.9">
            <b style="color:var(--text-2)">可用变量：</b>
            ${(Array.isArray(data.formulaVars)
              ? data.formulaVars
              : Object.keys(data.formulaVars || {
                available: 0, in_transit: 0, avg_daily: 0, demand_std: 0, lead_time: 0,
                safety_stock: 0, reorder_point: 0, cover_days: 0, moq: 0, eoq: 0,
                stock_days: 0, target_stock: 0, service_z: 0,
              })).map((v) => `<code style="font-family:var(--mono);background:var(--surface-3);padding:1px 5px;border-radius:4px;margin-right:4px;display:inline-block;margin-bottom:4px">${v}</code>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">同步与性能</div></div>
          <div class="grid grid-2">
            <div class="field">
              <label>平台事件模拟间隔（秒）</label>
              <input class="input" id="sync_interval" type="number" min="5" max="3600" value="${esc(s.sync_interval)}">
              <div class="hint">演示用：每隔多少秒产生一笔模拟平台订单，重启服务后生效</div>
            </div>
            <div class="field">
              <label>自动下单阈值</label>
              <input class="input" id="auto_order_threshold" type="number" min="0" max="1" step="0.05"
                value="${esc(s.auto_order_threshold)}">
              <div class="hint">置信度高于此值的建议可批量自动通过</div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div class="card mb-14">
          <div class="card-head"><div class="card-title">算法说明</div></div>
          <div style="font-size:12px;line-height:1.9;color:var(--text-2)">
            <div style="margin-bottom:12px">
              <div style="color:var(--cyan);font-family:var(--mono);font-size:11.5px;margin-bottom:3px">需求预测</div>
              Holt 双参数指数平滑（水平+趋势）与加权移动平均融合，兼顾趋势跟踪与抗噪稳定性。
            </div>
            <div style="margin-bottom:12px">
              <div style="color:var(--cyan);font-family:var(--mono);font-size:11.5px;margin-bottom:3px">SS = z·√(L·σd² + d̄²·σL²)</div>
              动态安全库存，同时考虑需求波动与供应商交期波动，替代落后的固定安全库存。
            </div>
            <div style="margin-bottom:12px">
              <div style="color:var(--cyan);font-family:var(--mono);font-size:11.5px;margin-bottom:3px">ROP = d̄·L + SS</div>
              再订货点，库存跌破此线即触发补货流程。
            </div>
            <div style="margin-bottom:12px">
              <div style="color:var(--cyan);font-family:var(--mono);font-size:11.5px;margin-bottom:3px">Q = Target − 可用 − 在途</div>
              补货量按最小起订量（MOQ）向上取整，在途库存自动抵扣避免重复采购。
            </div>
            <div>
              <div style="color:var(--cyan);font-family:var(--mono);font-size:11.5px;margin-bottom:3px">EOQ = √(2·D·S/H)</div>
              经济订货批量，作为单次订货规模的上限参考。
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">当前生效配置</div></div>
          <div id="cur-config" style="font-size:11.5px;line-height:1.9;color:var(--text-2);font-family:var(--mono)"></div>
        </div>
      </div>
    </div>

    <div style="position:sticky;bottom:0;margin-top:18px;padding:14px 0;background:linear-gradient(180deg,transparent,var(--bg) 40%)">
      <div style="display:flex;gap:9px;justify-content:flex-end">
        <button class="btn" id="btn-reset">重置为默认</button>
        <button class="btn btn-primary" id="btn-save">保存并重新计算</button>
      </div>
    </div>
  `;

  renderCurrentConfig(s);

  /* ---------- 公式实时校验 ---------- */
  const formulaEl = root.querySelector('#custom_formula');
  const statusEl = root.querySelector('#formula-status');
  const checkFormula = debounce(async () => {
    const f = formulaEl.value.trim();
    if (!f) { statusEl.textContent = '公式为空，启用后将回落到默认算法'; statusEl.style.color = 'var(--text-3)'; return; }
    try {
      const r = await api.validateFormula(f);
      if (r.ok) {
        statusEl.innerHTML = `<span style="color:#047857">✓ 公式合法</span> · 按当前样例参数计算，补货量 ≈ <b style="font-family:var(--mono)">${r.sample}</b> 件`;
      } else {
        statusEl.innerHTML = `<span style="color:#E11D48">✗ ${esc(r.error)}</span>`;
      }
    } catch (err) {
      statusEl.innerHTML = `<span style="color:#E11D48">✗ ${esc(err.message)}</span>`;
    }
  }, 320);
  formulaEl.addEventListener('input', checkFormula);

  /* ---------- 保存 ---------- */
  const IDS = ['service_level', 'forecast_window', 'forecast_weights', 'cover_days', 'safety_days',
    'alert_overstock_days', 'alert_slow_days', 'price_crawl_interval', 'sync_interval',
    'auto_order_threshold', 'custom_formula'];

  root.querySelector('#btn-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '保存中…';

    const payload = {};
    for (const id of IDS) {
      const elx = root.querySelector(`#${id}`);
      if (elx) payload[id] = elx.value.trim();
    }
    payload.auto_replenish = root.querySelector('#auto_replenish').checked ? '1' : '0';
    payload.custom_formula_enabled = root.querySelector('#custom_formula_enabled').checked ? '1' : '0';

    try {
      const r = await api.saveSettings(payload);
      toast(`已保存 ${r.updated.length} 项参数，补货建议已按新参数重算`, 'success', '设置已生效');
      renderCurrentConfig(r.settings);
    } catch (err) {
      toast(err.message, 'danger', '保存失败');
    } finally {
      btn.disabled = false;
      btn.textContent = '保存并重新计算';
    }
  });

  root.querySelector('#btn-reset').addEventListener('click', async () => {
    const defaults = {
      service_level: '0.95',
      forecast_window: '30',
      forecast_weights: '0.5,0.3,0.2',
      cover_days: '14',
      safety_days: '7',
      alert_overstock_days: '90',
      alert_slow_days: '60',
      price_crawl_interval: '300',
      sync_interval: '60',
      auto_order_threshold: '0.6',
      custom_formula: 'avg_daily * (lead_time + cover_days) + safety_stock - available - in_transit',
      auto_replenish: '1',
      custom_formula_enabled: '0',
    };
    try {
      await api.saveSettings(defaults);
      toast('已重置为系统默认参数', 'success');
      await mountSettings(root);
    } catch (err) {
      toast(err.message, 'danger');
    }
  });
}

function renderCurrentConfig(s) {
  const box = document.getElementById('cur-config');
  if (!box) return;
  const rows = [
    ['服务水平', `${(Number(s.service_level) * 100).toFixed(1)}%`],
    ['预测窗口', `${s.forecast_window} 天`],
    ['预测权重', s.forecast_weights],
    ['默认覆盖天数', `${s.cover_days} 天`],
    ['兜底安全天数', `${s.safety_days} 天`],
    ['积压阈值', `${s.alert_overstock_days} 天`],
    ['自动生成建议', s.auto_replenish === '1' ? '开启' : '关闭'],
    ['自定义公式', s.custom_formula_enabled === '1' ? '已启用' : '未启用'],
  ];
  box.innerHTML = rows.map(([k, v]) => `
    <div style="display:flex;justify-content:space-between;padding:2px 0">
      <span style="color:var(--text-3)">${k}</span><span>${esc(v)}</span>
    </div>
  `).join('');
}
