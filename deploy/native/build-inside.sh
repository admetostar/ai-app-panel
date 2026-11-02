#!/usr/bin/env bash
# 在 node:22-bookworm（glibc Debian）容器内执行：构建原生部署产物。
# 由宿主机 build-native.sh 通过 docker run 挂载调用；产物写到 /out-native/out。
# PostgreSQL 客户端驱动为纯 JavaScript；仅安装 Python 运行时供托管应用使用。
set -euo pipefail
apt-get update -qq
apt-get install -y -qq python3 >/dev/null
corepack enable
cd /app
pnpm install --frozen-lockfile
pnpm skills:sync
pnpm --filter @aap/shared build
pnpm --filter @aap/server build
pnpm --filter @aap/web build
pnpm --filter @aap/server --prod deploy --legacy /out-native/out
echo BUILD_INSIDE_OK
