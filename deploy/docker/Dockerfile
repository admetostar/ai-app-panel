# ai-app-panel — 单镜像（Docker 形态；FPK 复用同一镜像）
# 构建：docker build -f deploy/docker/Dockerfile -t ai-app-panel:latest .
# 运行：见 docker-compose.yml；数据卷 /data（证书、密钥、头像与托管应用文件）

# ---------- 构建阶段 ----------
# 构建（RUN --mount=type=cache 依赖 BuildKit，Docker 23+ 默认前端已支持）
FROM node:22-alpine AS build
# CN 网络优化：alpine 源与 npm registry 走国内镜像
RUN sed -i 's#https://dl-cdn.alpinelinux.org#https://mirrors.cloud.tencent.com#g' /etc/apk/repositories \
 && npm config set registry https://registry.npmmirror.com
RUN corepack enable
WORKDIR /app
# manifest 先行：只声明不变时命中依赖层，源码变更不再触发全量拉包
# （轻量机小管道曾因每次全量下载数百 MB 包整机饿死，758ec46 事故）
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
# packages/aap-sdk 是纯 Python+脚本目录（无 package.json），不参与依赖层：
# 运行阶段从 /app/packages/aap-sdk 原样拷贝（PYTHONPATH 指向）
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# pnpm store 走 BuildKit 缓存挂载：即使依赖层失效（lockfile 变更），命中部分免重下
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY packages ./packages
COPY apps ./apps
COPY docs ./docs
COPY scripts ./scripts
COPY README.md ./README.md
# 依次构建：shared（被 server/web 引用）→ server → web
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm skills:sync \
 && pnpm --filter @aap/shared build \
 && pnpm --filter @aap/server build \
 && pnpm --filter @aap/web build
# 产出自包含的服务端部署目录（含 workspace 依赖 @aap/shared）
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @aap/server --prod deploy --legacy /out

# ---------- 运行阶段 ----------
FROM node:22-alpine
RUN sed -i 's#https://dl-cdn.alpinelinux.org#https://mirrors.cloud.tencent.com#g' /etc/apk/repositories \
 && apk add --no-cache tini python3 py3-pip py3-flask \
 # py3-pip：AWPK Python 应用的 manifest.requirements 在上传时由 pip --target 安装
 # （alpine 的 python3 不带 pip）；musl 仅能装 wheel，无 musllinux wheel 的 C 扩展包
 # 会在上传时报错——属预期行为
 # 沙箱可选降权：预建非特权用户；运行时加 SANDBOX_UID=10001 SANDBOX_GID=10001 生效
 # （需保证数据卷对 10001 可写，如：docker run 时对挂载目录 chown 10001:10001）
 && addgroup -g 10001 ai-app-panel && adduser -D -u 10001 -G ai-app-panel ai-app-panel
WORKDIR /out
# pnpm deploy 产物：package.json + node_modules（含 @aap/shared 构建产物）
COPY --from=build /out ./
# 服务端编译产物与 PostgreSQL 迁移
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/drizzle-pg ./drizzle-pg
# 前端构建产物（server 生产托管 + SPA 兜底）
COPY --from=build /app/apps/web/dist ./public
# AWPK Python 运行时 SDK（aap 对象 + runner）
COPY --from=build /app/packages/aap-sdk ./aap-sdk
ENV PYTHONPATH=/out/aap-sdk \
    PYTHON_BIN=python3

# 开发指南与平台文档（右上角「开发指南」页数据源；同时保留下载用 skill 压缩包）
COPY --from=build /app/apps/server/assets/app-develop.skill-v0.3.md ./assets/app-develop.skill-v0.3.md
COPY --from=build /app/apps/server/assets/awpk-app-develop.skill ./assets/awpk-app-develop.skill
COPY --from=build /app/apps/server/assets/awpk-app-develop.zip ./assets/awpk-app-develop.zip
COPY --from=build /app/apps/server/assets/awpk-app-develop.md ./assets/awpk-app-develop.md
COPY --from=build /app/README.md ./assets/README.md
COPY --from=build /app/docs/app-develop-internal.skill.md ./assets/app-develop-internal.skill.md

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIST=/out/public \
    PORT=8080 \
    HTTPS_PORT=8443 \
    TZ=Asia/Shanghai
VOLUME ["/data"]
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
