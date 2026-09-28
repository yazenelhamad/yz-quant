#!/usr/bin/env bash
# Standalone Oracle installer (same steps as cloud-init.yml). Usage:
#   curl -fsSL <raw url>/deploy/oracle/install.sh | SETUP_TOKEN=... REPO_BRANCH=... bash
set -euo pipefail
SETUP_TOKEN="${SETUP_TOKEN:?set SETUP_TOKEN}"
REPO_BRANCH="${REPO_BRANCH:-main}"
REPO_URL="https://github.com/yazenelhamad/yz-quant.git"
APP_DIR=/opt/yz-quant
exec > >(tee -a /var/log/yz-quant-install.log) 2>&1
echo "==> $(date -u) installing Docker"
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh
echo "==> opening ports 80/443 in the OS firewall"
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT || true
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT || true
command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save || true
echo "==> discovering public IP from the instance metadata service"
PUBLIC_IP=$(curl -sf -H "Authorization: Bearer Oracle" http://169.254.169.254/opc/v2/vnics/ | python3 -c 'import sys,json; v=json.load(sys.stdin); print(next((x["publicIp"] for x in v if x.get("publicIp")), ""))' || true)
if [ -z "$PUBLIC_IP" ]; then PUBLIC_IP=$(curl -sf https://checkip.amazonaws.com || curl -sf https://api.ipify.org); fi
PUBLIC_IP=$(echo "$PUBLIC_IP" | tr -d '[:space:]')
[ -n "$PUBLIC_IP" ] || { echo "could not determine the public IP"; exit 1; }
DOMAIN="${PUBLIC_IP}.sslip.io"
echo "    public IP $PUBLIC_IP -> https://$DOMAIN"
echo "==> cloning $REPO_BRANCH"
if [ ! -d "$APP_DIR/.git" ]; then git clone --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"; fi
cd "$APP_DIR"
if [ ! -f .env ]; then
  {
    echo "NODE_ENV=production"
    echo "DOMAIN=$DOMAIN"
    echo "APP_ORIGIN=https://$DOMAIN"
    echo "API_ORIGIN=https://$DOMAIN"
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "SECRETS_MASTER_KEY=$(openssl rand -base64 32)"
    echo "SESSION_SECRET=$(openssl rand -base64 32)"
    echo "SETUP_TOKEN=$SETUP_TOKEN"
    echo "ANTHROPIC_API_KEY="
  } > .env
  chmod 600 .env
fi
echo "==> starting the stack (first build takes several minutes)"
docker compose --env-file .env -f docker-compose.yml -f deploy/oracle/docker-compose.prod.yml up -d --build
echo "==> done: open https://$DOMAIN/setup and enter your setup token"
