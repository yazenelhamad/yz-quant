# Deploying on Oracle Cloud Always Free

## 1. Create the VM (Oracle console)

1. **Compute → Instances → Create instance.**
2. Name it (e.g. `yz-quant`). Placement: any availability domain.
3. **Image and shape → Edit.** Image: *Canonical Ubuntu 24.04* (or 22.04). Shape: *Ampere → VM.Standard.A1.Flex*, 2 OCPUs, 12 GB RAM (inside the Always Free allowance). If Oracle says "Out of host capacity", try another availability domain, or fall back to *VM.Standard.E2.1.Micro* (x86, also free; 1 GB RAM is tight but works with `docker compose`).
4. Networking: create a new VCN with a public subnet, **assign a public IPv4 address**.
5. **Add SSH keys**: paste your public key (or generate and download the pair).
6. Create. Note the **Public IP**.

## 2. Open ports 80 and 443 (Oracle console)

**Networking → Virtual cloud networks → your VCN → Security Lists → Default Security List → Add Ingress Rules**, two rules:

| Source CIDR | Protocol | Destination port |
|---|---|---|
| 0.0.0.0/0 | TCP | 80 |
| 0.0.0.0/0 | TCP | 443 |

(The bootstrap script opens the same ports in the VM's own iptables.)

## 3. Pick a hostname

Either point a DNS `A` record at the public IP (recommended, e.g. `quant.yourdomain.com`), or use `<PUBLIC_IP>.sslip.io` for an instant hostname with a valid certificate. Caddy obtains the TLS certificate automatically.

## 4. Bootstrap

```bash
ssh ubuntu@<PUBLIC_IP>
curl -fsSL https://raw.githubusercontent.com/yazenelhamad/yz-quant/main/deploy/oracle/bootstrap.sh | \
  DOMAIN=<hostname> REPO_BRANCH=main bash
```

The script installs Docker, clones the repo, generates `SECRETS_MASTER_KEY`, `SESSION_SECRET` and the Postgres password into `~/yz-quant/.env` (mode 600), starts Postgres + API + Caddy, and prompts for the two users' emails and passwords.

Then open `https://<hostname>`, sign in, **enrol MFA for both users**, and connect each Robinhood Agentic account from Settings. Keep autonomy in `research_only` / `shadow` until the shadow results justify more.

## Day-2

```bash
cd ~/yz-quant
# logs
sudo docker compose --env-file .env -f docker-compose.yml -f deploy/oracle/docker-compose.prod.yml logs -f api
# update to the latest code
git pull && sudo docker compose --env-file .env -f docker-compose.yml -f deploy/oracle/docker-compose.prod.yml up -d --build
# enable the AI committee later: add ANTHROPIC_API_KEY=... to .env, then re-run the up command
# database backup
sudo docker compose --env-file .env -f docker-compose.yml -f deploy/oracle/docker-compose.prod.yml exec -T db pg_dump -U yzquant yzquant | gzip > backup-$(date +%F).sql.gz
```

Back up `.env` separately from the database: broker tokens are useless without `SECRETS_MASTER_KEY`.

Oracle occasionally reclaims idle Always Free instances. This stack is never idle, but upgrading the account to pay-as-you-go (still $0 within the free limits) removes that risk.
