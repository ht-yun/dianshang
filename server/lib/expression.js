'use strict';
/**
 * 安全数学表达式求值器
 * 用于「自定义补货公式」：用户可写 avg_daily * (lead_time + cover_days) - available
 * 采用递归下降解析，不使用 eval / new Function，从根本上杜绝代码注入。
 *
 * 支持：数字、变量、+ - * / % ^、括号、一元正负号、白名单函数 sqrt/abs/min/max/ceil/floor/round
 */

const FUNCS = {
  sqrt: (x) => Math.sqrt(x),
  abs: (x) => Math.abs(x),
  ceil: (x) => Math.ceil(x),
  floor: (x) => Math.floor(x),
  round: (x) => Math.round(x),
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
};

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue; }
    if (/[0-9.]/.test(ch)) {
      let num = '';
      while (i < src.length && /[0-9.]/.test(src[i])) { num += src[i]; i += 1; }
      if ((num.match(/\./g) || []).length > 1) throw new Error(`数字格式错误: ${num}`);
      tokens.push({ type: 'num', value: Number(num) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let id = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) { id += src[i]; i += 1; }
      tokens.push({ type: 'ident', value: id });
      continue;
    }
    if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ type: ch });
      i += 1;
      continue;
    }
    throw new Error(`非法字符: ${ch}`);
  }
  return tokens;
}

/** 解析并求值，vars 为变量字典 */
function evaluate(src, vars = {}) {
  if (typeof src !== 'string' || !src.trim()) throw new Error('公式为空');
  if (src.length > 500) throw new Error('公式过长（上限 500 字符）');

  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (type) => {
    const t = next();
    if (!t || t.type !== type) throw new Error(`公式语法错误：缺少 "${type}"`);
    return t;
  };

  // expression := term (('+'|'-') term)*
  // term       := unary (('*'|'/'|'%') unary)*
  // unary      := ('+'|'-') unary | power
  // power      := primary ('^' unary)?
  // primary    := number | ident '(' args ')' | ident | '(' expression ')'
  function parseExpression() {
    let left = parseTerm();
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = next().type;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    while (peek() && (peek().type === '*' || peek().type === '/' || peek().type === '%')) {
      const op = next().type;
      const right = parseUnary();
      if (op === '*') left *= right;
      else if (op === '/') {
        if (right === 0) throw new Error('公式除数为 0');
        left /= right;
      } else {
        if (right === 0) throw new Error('公式取模除数为 0');
        left %= right;
      }
    }
    return left;
  }

  function parseUnary() {
    const t = peek();
    if (t && t.type === '-') { next(); return -parseUnary(); }
    if (t && t.type === '+') { next(); return parseUnary(); }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (peek() && peek().type === '^') {
      next();
      return Math.pow(base, parseUnary());
    }
    return base;
  }

  function parsePrimary() {
    const t = next();
    if (!t) throw new Error('公式意外结束');

    if (t.type === 'num') return t.value;

    if (t.type === '(') {
      const v = parseExpression();
      expect(')');
      return v;
    }

    if (t.type === 'ident') {
      const name = t.value;
      // 函数调用
      if (peek() && peek().type === '(') {
        const fn = FUNCS[name];
        if (!fn) throw new Error(`不支持的函数: ${name}`);
        next(); // 吃掉 '('
        const args = [];
        if (peek() && peek().type !== ')') {
          args.push(parseExpression());
          while (peek() && peek().type === ',') { next(); args.push(parseExpression()); }
        }
        expect(')');
        return fn(...args);
      }
      // 变量
      if (!IDENT_RE.test(name)) throw new Error(`非法变量名: ${name}`);
      if (!(name in vars)) throw new Error(`未知变量: ${name}`);
      const val = Number(vars[name]);
      if (!Number.isFinite(val)) throw new Error(`变量 ${name} 取值无效`);
      return val;
    }

    throw new Error(`公式语法错误: "${t.type}"`);
  }

  const result = parseExpression();
  if (pos !== tokens.length) throw new Error('公式语法错误：存在多余字符');
  if (!Number.isFinite(result)) throw new Error('公式计算结果无效（可能溢出）');
  return result;
}

/** 校验公式能否在给定变量下求值，返回 { ok, value, error } */
function validate(src, vars) {
  try {
    const value = evaluate(src, vars);
    return { ok: true, value, error: null };
  } catch (err) {
    return { ok: false, value: null, error: err.message };
  }
}

module.exports = { evaluate, validate, FUNCS };
