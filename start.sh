#!/usr/bin/env bash
# 电商智能库存补货系统 - macOS / Linux 启动脚本
set -e
cd "$(dirname "$0")"

echo ""
echo "  ============================================"
echo "    电商智能库存补货系统  v1.0.0"
echo "  ============================================"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  [错误] 未检测到 Node.js，请先安装 Node.js 22.5+：https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "  [错误] 当前 Node.js 版本 $(node -v)，需要 22.5.0 或更高（内置 SQLite 模块）"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  [1/2] 首次运行，正在安装依赖..."
  npm install --no-audit --no-fund
else
  echo "  [1/2] 依赖已就绪"
fi

echo "  [2/2] 正在启动服务..."
echo ""
echo "  访问地址：http://localhost:3000"
echo "  停止服务：Ctrl+C"
echo ""

# 尝试自动打开浏览器
(sleep 2 && (open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null || true)) &

node --no-warnings server/index.js
