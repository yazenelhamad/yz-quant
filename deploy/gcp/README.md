# Deploying on Google Cloud Free Tier (e2-micro)

The free VM has 1 GB RAM, so this path runs the platform in lightweight mode: no Docker, embedded PGlite database, Caddy for HTTPS, a systemd service. Back up `/opt/yz-quant/data` and `/opt/yz-quant/.env` regularly.

## Console steps

1. Google Cloud console → **Compute Engine → VM instances → Create instance** (enable the Compute Engine API if asked; a billing account with a card is required for the free tier).
2. Region **us-central1**, **us-west1** or **us-east1** (the free tier is only in these). Machine type **e2-micro**.
3. Boot disk: **Ubuntu 24.04 LTS**, **30 GB standard persistent disk** (the free allowance).
4. Firewall: tick **Allow HTTP traffic** and **Allow HTTPS traffic**.
5. **Advanced options → Management → Automation → Startup script**: paste `deploy/gcp/startup.sh` after changing `SETUP_TOKEN` (and `REPO_BRANCH` if needed).
6. Create. Wait about 20 minutes (dependency install and dashboard build are slow on 1 GB), then open `https://<EXTERNAL_IP>.sslip.io/setup` and enter the token and the two users.

Progress is in `/var/log/yz-quant-install.log` (SSH via the console's browser SSH button if needed). Update later with `cd /opt/yz-quant && git pull && npm ci && npm run build -w apps/web && sudo systemctl restart yz-quant`.
