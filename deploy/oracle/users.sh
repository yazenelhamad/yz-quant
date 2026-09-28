#!/usr/bin/env bash
# Provision (or reset the password of) the two authorised users inside the running API container.
set -euo pipefail
cd "$(dirname "$0")/../.."
COMPOSE="sudo docker compose --env-file .env -f docker-compose.yml -f deploy/oracle/docker-compose.prod.yml"
read -rp "User A email: " A_EMAIL
read -rp "User A display name: " A_NAME
read -rsp "User A password (min 12 chars, 3 character classes): " A_PASS; echo
read -rp "User B email: " B_EMAIL
read -rp "User B display name: " B_NAME
read -rsp "User B password: " B_PASS; echo
USERS=$(python3 - "$A_EMAIL" "$A_NAME" "$A_PASS" "$B_EMAIL" "$B_NAME" "$B_PASS" <<'PY'
import json,sys
a=sys.argv[1:]
print(json.dumps([{"email":a[0],"displayName":a[1],"role":"admin","password":a[2]},{"email":a[3],"displayName":a[4],"role":"trader","password":a[5]}]))
PY
)
$COMPOSE exec -T -e BOOTSTRAP_USERS="$USERS" api npx tsx scripts/bootstrap-users.ts
