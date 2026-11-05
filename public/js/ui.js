/**
 * 全局 UI 控制：抽屉、模态框、侧栏
 */

let drawerOnClose = null;

export function openDrawer(title, html) {
  const mask = document.getElementById('drawer-mask');
  const drawer = document.getElementById('drawer');
  document.getElementById('drawer-title').textContent = title;
  document.getElementById('drawer-body').innerHTML = html;
  mask.hidden = false;
  drawer.hidden = false;
  document.body.style.overflow = 'hidden';
}

export function setDrawerBody(html) {
  document.getElementById('drawer-body').innerHTML = html;
}

export function closeDrawer() {
  document.getElementById('drawer-mask').hidden = true;
  document.getElementById('drawer').hidden = true;
  document.body.style.overflow = '';
  if (drawerOnClose) {
    const fn = drawerOnClose;
    drawerOnClose = null;
    fn();
  }
}

export function onDrawerClose(fn) {
  drawerOnClose = fn;
}

export function openModal(title, html, footHtml = '') {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = html;
  const foot = document.getElementById('modal-foot');
  foot.innerHTML = footHtml;
  document.getElementById('modal-mask').hidden = false;
  // 底部按钮统一支持 data-close：否则调用方传了 <button data-close> 却点了没反应
  foot.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', closeModal);
  });
}

export function setModalBody(html) {
  document.getElementById('modal-body').innerHTML = html;
}

export function setModalFoot(html) {
  document.getElementById('modal-foot').innerHTML = html;
}

export function closeModal() {
  document.getElementById('modal-mask').hidden = true;
  document.getElementById('modal-body').innerHTML = '';
  document.getElementById('modal-foot').innerHTML = '';
}

/** 绑定一次性的通用关闭逻辑 */
export function initOverlays() {
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('drawer-mask').addEventListener('click', closeDrawer);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-mask').addEventListener('click', (e) => {
    if (e.target.id === 'modal-mask') closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('modal-mask');
    if (!modal.hidden) { closeModal(); return; }
    if (!document.getElementById('drawer').hidden) closeDrawer();
  });
}
