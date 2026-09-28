#!/usr/bin/env bash
# yz-quant — Google Cloud Free Tier (e2-micro, 1 GB RAM) startup script.
# Paste into: Compute Engine → Create instance → Advanced options → Management → Automation → Startup script.
# Lightweight mode: no Docker, embedded database (PGlite), Caddy for automatic HTTPS, systemd service.
#
# CHANGE BEFORE PASTING:
SETUP_TOKEN="CHANGE-ME-choose-a-long-setup-passphrase"
REPO_BRANCH="claude/quirky-ptolemy-ht4n67"
# -------------------------------------------------------------------------------------------------
set -euo pipefail
REPO_URL="https://github.com/yazenelhamad/yz-quant.git"
APP_DIR=/opt/yz-quant
exec > >(tee -a /var/log/yz-quant-install.log) 2>&1
if [ -f "$APP_DIR/.installed" ]; then echo "already installed; starting services"; systemctl restart yz-quant caddy || true; exit 0; fi
echo "==> $(date -u) swap (the free VM has 1 GB RAM)"
if [ ! -f /swapfile ]; then fallocate -l 3G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
curl -1sLf 'https://dl.cloudflare.com/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudflare.com/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
apt-get update -y && apt-get install -y caddy
echo "==> public IP from the metadata server"
PUBLIC_IP=$(curl -sf -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)
DOMAIN="${PUBLIC_IP}.sslip.io"
echo "    https://$DOMAIN"
echo "==> clone $REPO_BRANCH"
[ -d "$APP_DIR/.git" ] || git clone --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"
echo "==> install dependencies (slow on the free VM; 10–20 minutes)"
export NODE_OPTIONS=--max-old-space-size=700
npm ci --no-audit --no-fund
echo "==> build the dashboard"
npm run build -w apps/web
echo "==> configuration"
{
  echo "NODE_ENV=production"
  echo "HOST=127.0.0.1"
  echo "PORT=8787"
  echo "APP_ORIGIN=https://$DOMAIN"
  echo "API_ORIGIN=https://$DOMAIN"
  echo "DATABASE_URL=pglite://$APP_DIR/data/pglite"
  echo "ALLOW_EMBEDDED_DB=1"
  echo "SECRETS_MASTER_KEY=$(openssl rand -base64 32)"
  echo "SESSION_SECRET=$(openssl rand -base64 32)"
  echo "SETUP_TOKEN=$SETUP_TOKEN"
  echo "ANTHROPIC_API_KEY="
} > .env
chmod 600 .env
npx tsx scripts/migrate.ts
echo "==> systemd service"
cat > /etc/systemd/system/yz-quant.service <<UNIT
[Unit]
Description=yz-quant trading platform API
After=network-online.target
[Service]
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=NODE_OPTIONS=--max-old-space-size=600
ExecStart=/usr/bin/npx tsx apps/api/src/main.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now yz-quant
echo "==> Caddy (automatic HTTPS)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy same-origin
	}
	reverse_proxy 127.0.0.1:8787
}
CADDY
systemctl restart caddy
touch "$APP_DIR/.installed"
echo "==> done: open https://$DOMAIN/setup and enter your setup token"
