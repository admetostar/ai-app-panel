#!/usr/bin/env bash
# Build the Docker image locally, stream it to ECS, and recreate only the portal.
# The remote Compose .env is preserved; Postgres and persistent volumes are untouched.
set -euo pipefail

HOST="${AAP_DEPLOY_HOST:?'必须通过环境变量指定部署目标：AAP_DEPLOY_HOST=user@host ./deploy/fast-deploy.sh'}"
KEY="${AAP_DEPLOY_KEY:-$HOME/.ssh/ai-app-panel}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_COMPOSE_DIR="/root/aap-deploy/deploy/docker"
IMAGE="ai-app-panel:latest"

if [[ "${OSTYPE:-}" == msys* ]]; then
  PATH="/c/Windows/System32:$PATH"
fi

ssh_remote() {
  ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$@"
}

echo "==> 检查本地 Docker 与 ECS"
LOCAL_PLATFORM="$(docker info --format '{{.OSType}}/{{.Architecture}}')"
REMOTE_PLATFORM="$(ssh_remote "docker info --format '{{.OSType}}/{{.Architecture}}'")"
case "$REMOTE_PLATFORM" in
  linux/x86_64) PLATFORM="linux/amd64" ;;
  linux/aarch64) PLATFORM="linux/arm64" ;;
  *)
    echo "不支持的 ECS Docker 平台：$REMOTE_PLATFORM" >&2
    exit 1
    ;;
esac
if [ "$LOCAL_PLATFORM" != "$REMOTE_PLATFORM" ]; then
  echo "本机与 ECS Docker 平台不一致：$LOCAL_PLATFORM != $REMOTE_PLATFORM" >&2
  exit 1
fi

ssh_remote "set -eu
  test -f /opt/ai-app-panel/deploy/docker/.env
  docker inspect ai-app-panel >/dev/null
  mkdir -p '$REMOTE_COMPOSE_DIR'
  if [ ! -f '$REMOTE_COMPOSE_DIR/.env' ]; then
    install -m 600 /opt/ai-app-panel/deploy/docker/.env '$REMOTE_COMPOSE_DIR/.env'
  fi
  test -f '$REMOTE_COMPOSE_DIR/.env'
"

echo "==> 准备并验证 ECS Compose 配置"
scp -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 \
  "$ROOT/deploy/docker/docker-compose.yml" \
  "$HOST:$REMOTE_COMPOSE_DIR/docker-compose.yml"
ssh_remote "cd '$REMOTE_COMPOSE_DIR' &&
  docker compose --env-file .env -f docker-compose.yml config --quiet"

echo "==> 本地构建 $IMAGE ($PLATFORM)"
docker buildx build \
  --platform "$PLATFORM" \
  --load \
  -f "$ROOT/deploy/docker/Dockerfile" \
  -t "$IMAGE" \
  "$ROOT"

echo "==> 经 SSH 导入镜像到 $HOST"
docker save "$IMAGE" | ssh_remote docker load

echo "==> 更新 ECS Compose 配置并重建 portal"
ssh_remote "cd '$REMOTE_COMPOSE_DIR' &&
  docker compose --env-file .env -f docker-compose.yml up -d --no-build --no-deps portal"

echo "==> 等待健康检查"
HEALTHY=0
for _ in $(seq 1 30); do
  if ssh_remote "curl -fsS --max-time 8 http://127.0.0.1/api/health >/dev/null 2>&1"; then
    HEALTHY=1
    break
  fi
  sleep 2
done

if [ "$HEALTHY" -ne 1 ]; then
  echo "部署后健康检查未通过；请在 ECS 查看 ai-app-panel 容器日志。" >&2
  exit 1
fi

ssh_remote "docker ps --filter name=ai-app-panel --format '{{.Names}} {{.Status}}'
  printf 'health: '
  curl -fsS --max-time 8 http://127.0.0.1/api/health
  echo"
echo "==> 部署完成"
