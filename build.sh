#!/bin/bash
# 构建产物：dist/ = 可直接部署的目录（运行时代码 + 生产依赖，JS 已混淆）
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="$ROOT/dist"

# 1. 清理旧产物
rm -rf "$DIST"
mkdir -p "$DIST"

# 2. 拷贝运行时必需文件（不含 .env，配置由部署脚本生成）
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$DIST/"
cp "$ROOT/schema.sql" "$DIST/"
for f in server.js db.js lessons.js sync-lessons.js bootstrap-db.js \
         migrate-app.js migrate-classroom.js migrate-enroll.js migrate-admin-roles.js migrate-lessons.js; do
  [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$DIST/"
done

# 3. 安装生产依赖（不含 devDependencies）
cd "$DIST"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
# 防「npm ci 产出空壳目录」：所有子包都是 0 个文件时构建也会返回 0
for p in express mysql2 cors; do
  test -f "node_modules/$p/package.json" || { echo "✗ node_modules/$p 缺失或为空目录" >&2; exit 1; }
done

# 4. 混淆 JS（dist 顶层的业务代码，node_modules 不动）
cd "$ROOT"
node obfuscate.js

echo "✅ Build complete: $DIST ($(du -sh "$DIST" | cut -f1))"
