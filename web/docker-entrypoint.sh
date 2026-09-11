#!/bin/sh
set -e

# Executed automatically by the official nginx image entrypoint through /docker-entrypoint.d/*.sh before nginx starts.
# Generate runtime config.js from environment variables. Each analytics provider has an independent variable;
# unset providers remain disabled, load no scripts, and send no external requests. Multiple providers may be enabled together.

# GA4 and Baidu IDs contain only letters, numbers, and hyphens. Remove other characters
# so quotes and similar values cannot break the JavaScript strings in config.js as a defense-in-depth measure.
sanitize_id() {
    printf '%s' "$1" | tr -cd 'A-Za-z0-9-'
}

GA4_ID=$(sanitize_id "${ANALYTICS_GA4_ID:-}")
BAIDU_ID=$(sanitize_id "${ANALYTICS_BAIDU_ID:-}")

APP_TITLE="${APP_TITLE:-炸天帮画布}"

cat > /usr/share/nginx/html/config.js <<EOF
window.__RUNTIME_CONFIG__ = {
  APP_TITLE: "${APP_TITLE}",
  ANALYTICS_GA4_ID: "${GA4_ID}",
  ANALYTICS_BAIDU_ID: "${BAIDU_ID}"
};
EOF

# 启动内置转换代理后端
echo "[Entrypoint] Starting internal BFF server..."
node /app/server.mjs &
