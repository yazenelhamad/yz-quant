#!/usr/bin/env bash
# One-shot server bootstrap for an Oracle Cloud Always Free VM (Ubuntu 22.04/24.04, x86 or Ampere ARM).
# Installs Docker + compose, opens the OS firewall, clones the repo, generates secrets, starts the stack
# behind Caddy with automatic HTTPS, and provisions the two users.
#
#   curl -fsSL https://raw.githubusercontent.com/yazenelhamad/yz-quant/claude/quirky-ptolemy-ht4n67/deploy/oracle/bootstrap.sh | \
#     DOMAIN=<host> REPO_BRANCH=claude/quirky-ptolemy-ht4n67 bash
#
# DOMAIN: a DNS name pointing at the VM's public IP, or "<public-ip>.sslip.io" if you have no domain yet.
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN (e.g. quant.example.com or 203.0.113.10.sslip.io)}"
REPO_URL="${REPO_URL:-https://github.com/yazenelhamad/yz-quant.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
APP_DIR="${APP_DIR:-$HOME/yz-quant}"

echo "==> Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
fi

echo "==> Opening ports 80/443 in the OS firewall (Oracle images ship with iptables rules)"
if command -v iptables >/dev/null 2>&1; then
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT || true
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT || true
  if command -v netfilter-persistent >/dev/null 2>&1; then sudo netfilter-persistent save || true; fi
fi
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
fi

echo "==> Fetching the repository ($REPO_BRANCH)"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$REPO_BRANCH" && git -C "$APP_DIR" checkout "$REPO_BRANCH" && git -C "$APP_DIR" pull --ff-only origin "$REPO_BRANCH"
else
  git clone --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

echo "==> Generating secrets (kept in $APP_DIR/.env, mode 600)"
if [ ! -f .env ]; then
  cat > .env <<ENV
NODE_ENV=production
DOMAIN=$DOMAIN
APP_ORIGIN=https://$DOMAIN
API_ORIGIN=https://$DOMAIN
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SECRETS_MASTER_KEY=$(openssl rand -base64 32)
SESSION_SECRET=$(openssl rand -base64 32)
ANTHROPIC_API_KEY=
ENV
  chmod 600 .env
  echo "    created .env (add ANTHROPIC_API_KEY later if you want the AI committee)"
else
  echo "    .env already exists; leaving it untouched"
fi

echo "==> Building and starting the stack (this takes a few minutes the first time)"
sudo docker compose --env-file .env -f docker-compose.yml -f deploy/oracle/docker-compose.prod.yml up -d --build

echo "==> Waiting for the API"
for i in $(seq 1 60); do
  if sudo docker compose --env-file .env -f docker-compose.yml -f deploy/oracle/docker-compose.prod.yml exec -T api sh -c 'wget -qO- http://127.0.0.1:8787/api/ping' >/dev/null 2>&1; then break; fi
  sleep 3
done

echo
echo "==> Provisioning the two users (run this now, or later with: deploy/oracle/users.sh)"
bash deploy/oracle/users.sh || true

echo
echo "Done. Open https://$DOMAIN"
echo "Logs:   sudo docker compose --env-file .env -f docker-compose.yml -f deploy/oracle/docker-compose.prod.yml logs -f api"
echo "Update: cd $APP_DIR && git pull && sudo docker compose --env-file .env -f docker-compose.yml -f deploy/oracle/docker-compose.prod.yml up -d --build"
