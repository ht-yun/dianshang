/**
 * 实时事件总线
 * 独立成模块的原因：视图需要订阅实时事件，而事件由 app.js 派发。
 * 若视图直接 import app.js，就会与 app.js → 视图 形成循环依赖。
 * 一旦入口脚本带了 ?v= 之类的查询串，循环里的 app.js 会以另一个 URL
 * 被再实例化一次，模块体在视图模块求值完成前就执行 boot()，
 * 触发 "Cannot access 'X' before initialization"。抽出总线即切断该环。
 */
const handlers = new Set();

/** 订阅实时事件，返回取消订阅函数 */
export function onRealtime(fn) {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

/** 派发事件：单个订阅者报错不影响其他订阅者 */
export function emit(type, data) {
  for (const fn of handlers) {
    try {
      fn(type, data);
    } catch (err) {
      console.error(err);
    }
  }
}
