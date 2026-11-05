'use strict';
/**
 * 供应商采购单接口
 *
 * 业务链路：审核通过的补货建议 → 按供应商自动分组拆单 → 采购单状态流转
 *   pending(待确认) → confirmed(已确认) → shipped(已发货) → received(已入库)
 *   任一未入库状态可 cancelled(已取消)
 * 入库动作会把采购数量按各平台近期销量占比回写到平台库存，并写库存流水。
 */
const express = require('express');
const { all, get, run, tx } = require('../db');
const { round2 } = require('../services/replenish');
const { invalidateDashboard } = require('./dashboard');

const router = express.Router();

const STATUS_TEXT = {
  pending: '待确认',
  confirmed: '已确认',
  shipped: '已发货',
  received: '已入库',
  cancelled: '已取消',
};

/** 生成采购单号：PO + 日期 + 3 位流水 */
function nextOrderNo() {
  const d = new Date();
  const prefix = `PO${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const row = get("SELECT order_no FROM purchase_orders WHERE order_no LIKE ? ORDER BY order_no DESC LIMIT 1", `${prefix}%`);
  const seq = row ? Number(row.order_no.slice(-3)) + 1 : 1;
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

/** 采购单列表 */
router.get('/', (req, res) => {
  const { status } = req.query;
  const cond = [];
  const params = [];
  if (status && status !== 'all') { cond.push('o.status = ?'); params.push(status); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const orders = all(
    `SELECT o.*, s.name AS supplier_name, s.contact, s.phone, s.lead_time_days, s.payment_terms,
            (SELECT COUNT(*) FROM purchase_order_items i WHERE i.order_id = o.id) AS item_count
     FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id
     ${where} ORDER BY o.id DESC`,
    ...params
  );

  const summary = {
    total: get('SELECT COUNT(*) c FROM purchase_orders').c,
    pending: get("SELECT COUNT(*) c FROM purchase_orders WHERE status='pending'").c,
    shipping: get("SELECT COUNT(*) c FROM purchase_orders WHERE status IN ('confirmed','shipped')").c,
    amount: round2(get("SELECT COALESCE(SUM(total_amount),0) amt FROM purchase_orders WHERE status != 'cancelled'").amt),
  };

  res.json({ list: orders.map((o) => ({ ...o, status_text: STATUS_TEXT[o.status] || o.status })), summary });
});

/** 采购单详情 */
router.get('/:id', (req, res) => {
  const o = get(
    `SELECT o.*, s.name AS supplier_name, s.contact, s.phone, s.payment_terms
     FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ?`,
    Number(req.params.id)
  );
  if (!o) return res.status(404).json({ error: '采购单不存在' });
  const items = all(
    `SELECT i.*, p.sku, p.name, p.category, p.unit
     FROM purchase_order_items i JOIN products p ON p.id = i.product_id
     WHERE i.order_id = ? ORDER BY i.id`,
    o.id
  );
  res.json({ order: { ...o, status_text: STATUS_TEXT[o.status] || o.status }, items });
});

/**
 * 由补货建议生成采购单（按供应商自动拆单）
 * body: { ids: number[], remark?: string }
 */
router.post('/from-suggestions', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (!ids.length) return res.status(400).json({ error: '请选择至少一条已审核通过的补货建议' });

  const rows = all(
    `SELECT r.*, p.sku, p.name, p.purchase_price, p.moq, p.unit, p.supplier_id,
            s.name AS supplier_name, s.lead_time_days, s.min_order_qty
     FROM replenish_suggestions r
     JOIN products p ON p.id = r.product_id
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE r.id IN (${ids.map(() => '?').join(',')})`,
    ...ids
  );

  const invalid = rows.filter((r) => r.status !== 'approved');
  if (invalid.length) {
    return res.status(400).json({
      error: `以下建议尚未审核通过，无法下单：${invalid.map((r) => r.sku).join('、')}`,
    });
  }
  const noSupplier = rows.filter((r) => !r.supplier_id);
  if (noSupplier.length) {
    return res.status(400).json({ error: `以下商品未绑定供应商：${noSupplier.map((r) => r.sku).join('、')}` });
  }

  // 按供应商分组
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.supplier_id)) groups.set(r.supplier_id, []);
    groups.get(r.supplier_id).push(r);
  }

  const created = [];
  tx(() => {
    for (const [supplierId, items] of groups) {
      const supplier = get('SELECT * FROM suppliers WHERE id = ?', supplierId);
      const maxLead = Math.max(...items.map((i) => i.lead_time_days || supplier.lead_time_days));
      const expected = new Date(Date.now() + maxLead * 86400000);
      const expectedDate = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`;

      const totalAmount = round2(items.reduce((s, i) => s + i.final_qty * i.purchase_price, 0));
      const totalQty = items.reduce((s, i) => s + i.final_qty, 0);

      const ins = run(
        `INSERT INTO purchase_orders(order_no, supplier_id, status, total_amount, total_qty, expected_date, remark, created_by)
         VALUES(?,?,?,?,?,?,?,?)`,
        nextOrderNo(), supplierId, 'pending', totalAmount, totalQty, expectedDate,
        req.body.remark || '由智能补货建议自动生成', '运营'
      );
      const orderId = Number(ins.lastInsertRowid);

      for (const i of items) {
        run(
          'INSERT INTO purchase_order_items(order_id, product_id, qty, unit_price, amount) VALUES(?,?,?,?,?)',
          orderId, i.product_id, i.final_qty, i.purchase_price, round2(i.final_qty * i.purchase_price)
        );
        run("UPDATE replenish_suggestions SET status='ordered' WHERE id = ?", i.id);
      }

      created.push({
        id: orderId,
        orderNo: get('SELECT order_no FROM purchase_orders WHERE id = ?', orderId).order_no,
        supplierName: supplier.name,
        itemCount: items.length,
        totalQty,
        totalAmount,
        expectedDate,
      });
    }
  });

  invalidateDashboard();
  res.json({ ok: true, orders: created, count: created.length });
});

/** 采购单状态流转 */
router.patch('/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const order = get('SELECT * FROM purchase_orders WHERE id = ?', id);
  if (!order) return res.status(404).json({ error: '采购单不存在' });

  const next = String(req.body.status || '');
  const allowed = {
    pending: ['confirmed', 'cancelled'],
    confirmed: ['shipped', 'cancelled'],
    shipped: ['received'],
    received: [],
    cancelled: [],
  };
  if (!allowed[order.status]) return res.status(400).json({ error: '当前状态不可变更' });
  if (!allowed[order.status].includes(next)) {
    return res.status(400).json({
      error: `不允许从「${STATUS_TEXT[order.status]}」变更为「${STATUS_TEXT[next] || next}」`,
    });
  }

  const items = all('SELECT * FROM purchase_order_items WHERE order_id = ?', id);

  tx(() => {
    run("UPDATE purchase_orders SET status=?, updated_at=datetime('now','localtime') WHERE id=?", next, id);

    // 入库：把采购量按各平台近期销量占比回写到平台库存
    if (next === 'received') {
      for (const item of items) {
        const ratios = all(
          `SELECT platform_id, COALESCE(SUM(qty),0) AS q
           FROM sales_history WHERE product_id = ? AND sale_date >= date('now','-14 day')
           GROUP BY platform_id`,
          item.product_id
        );
        const totalSales = ratios.reduce((s, r) => s + r.q, 0);
        const invs = all('SELECT id, platform_id FROM platform_inventory WHERE product_id = ?', item.product_id);
        if (!invs.length) continue;

        let remain = item.qty;
        invs.forEach((inv, idx) => {
          const ratio = totalSales > 0
            ? (ratios.find((r) => r.platform_id === inv.platform_id)?.q || 0) / totalSales
            : 1 / invs.length;
          const add = idx === invs.length - 1 ? remain : Math.floor(item.qty * ratio);
          remain -= add;
          if (add <= 0) return;
          run("UPDATE platform_inventory SET stock = stock + ?, updated_at=datetime('now','localtime') WHERE id=?", add, inv.id);
          run(
            "INSERT INTO stock_movements(product_id, platform_id, type, qty, ref_no, note, created_at) VALUES(?,?,?,?,?,?, datetime('now','localtime'))",
            item.product_id, inv.platform_id, 'in', add, order.order_no, '采购入库'
          );
        });
      }
      // 同步关闭相关补货建议的后续提醒
      run("UPDATE alerts SET status='closed' WHERE type IN ('stock_low','out_of_stock','below_rop') AND product_id IN (SELECT product_id FROM purchase_order_items WHERE order_id=?)", id);
    }
  });

  invalidateDashboard();
  res.json({
    ok: true,
    status: next,
    statusText: STATUS_TEXT[next],
    message: next === 'received' ? '已入库，库存已按各渠道销量占比回写' : '状态更新成功',
  });
});

/** 采购单详情导出为文本（便于复制给供应商） */
router.get('/:id/export', (req, res) => {
  const o = get(
    `SELECT o.*, s.name AS supplier_name, s.contact, s.phone FROM purchase_orders o
     JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ?`,
    Number(req.params.id)
  );
  if (!o) return res.status(404).json({ error: '采购单不存在' });
  const items = all(
    `SELECT i.*, p.sku, p.name, p.unit FROM purchase_order_items i
     JOIN products p ON p.id = i.product_id WHERE i.order_id = ?`,
    o.id
  );

  const lines = [
    `采购单号：${o.order_no}`,
    `供应商：${o.supplier_name}`,
    `联系人：${o.contact || '-'}  ${o.phone || ''}`,
    `下单日期：${o.created_at}`,
    `期望到货：${o.expected_date || '-'}`,
    `状态：${STATUS_TEXT[o.status]}`,
    '----------------------------------------',
    'SKU            商品名称                  数量    单价      金额',
  ];
  for (const i of items) {
    lines.push(
      `${i.sku.padEnd(15)}${i.name.slice(0, 22).padEnd(24)}${String(i.qty).padStart(6)}${String(i.unit).padEnd(4)}${i.unit_price.toFixed(2).padStart(9)}${i.amount.toFixed(2).padStart(11)}`
    );
  }
  lines.push('----------------------------------------');
  lines.push(`合计数量：${o.total_qty}    合计金额：¥${o.total_amount.toFixed(2)}`);

  res.json({ text: lines.join('\n'), orderNo: o.order_no });
});

module.exports = router;
