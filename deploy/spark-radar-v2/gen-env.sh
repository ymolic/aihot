#!/usr/bin/env bash
# 生成 /srv/apps/spark-radar-v2/.env（chmod 600）与 admin-password.txt。
# 只在 oracle-us-apps 上以部署用户运行；输出不打印任何密钥值。
set -euo pipefail
DIR=/srv/apps/spark-radar-v2
mkdir -p "$DIR/secrets"
umask 077

rand() { openssl rand "$1"; }

POSTGRES_PASSWORD=$(rand -hex 24)
ADMIN_PASSWORD=$(rand -base64 18 | tr -d '/+=' | head -c 20)
SESSION_SECRET=$(rand -hex 32)
IMG_PROXY_SIGN_SECRET=$(rand -hex 32)
INGEST_TOKEN=$(rand -hex 24)

cp /srv/apps/spark-radar/app/secrets/ai_api_key "$DIR/secrets/ai_api_key"
chmod 600 "$DIR/secrets/ai_api_key"

cat > "$DIR/.env" <<EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
SITE_URL=https://radar.yydsoh.com
ADMIN_PASSWORD=$ADMIN_PASSWORD
SESSION_SECRET=$SESSION_SECRET
IMG_PROXY_SIGN_SECRET=$IMG_PROXY_SIGN_SECRET
INGEST_TOKEN=$INGEST_TOKEN
LLM_BASE_URL=http://cli-proxy-api:8317/v1
LLM_MODEL=gemini-3.8-flash-high
COLLECT_ENABLED=true
MODEL_CALLS_ENABLED=true
EOF

printf '%s\n' "$ADMIN_PASSWORD" > "$DIR/secrets/admin-password.txt"
chmod 600 "$DIR/.env" "$DIR/secrets/admin-password.txt"
echo "written: $DIR/.env (chmod 600), $DIR/secrets/admin-password.txt"
