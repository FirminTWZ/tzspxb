#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 22.13 或更高版本。" >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)'; then
  echo "Node.js 版本过低。请安装 Node.js 22.13 或更高版本。" >&2
  exit 1
fi

if [ ! -d node_modules/xlsx ]; then
  echo "正在安装必要组件…"
  npm install --omit=dev
fi

exec node server.mjs
