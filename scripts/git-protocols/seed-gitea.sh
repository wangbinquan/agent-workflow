#!/usr/bin/env bash
# RFC-054 W3-4 — bootstrap the gitea test container after `docker compose up`.
#
# Idempotent: re-running against an already-seeded container is a no-op (every
# create call short-circuits on 409 / 422). That matters for the workflow,
# which `up`s then `seed`s in the same step — a partial previous run shouldn't
# brick the second attempt.
#
# Emits 5 lines to stdout that the spec / workflow ingest as env vars:
#   GITEA_BASE_URL=http://127.0.0.1:3001
#   GITEA_ADMIN_USER=fixture-admin
#   GITEA_ADMIN_TOKEN=<sha256>
#   GITEA_REPO_HTTPS_URL=http://fixture-admin:<token>@127.0.0.1:3001/fixture-admin/sample.git
#   GITEA_REPO_SSH_URL=ssh://git@127.0.0.1:2222/fixture-admin/sample.git
#
# The workflow / dev pipes this to `>> $GITHUB_ENV` (or `source <(...)`) so
# downstream steps can read them.

set -euo pipefail

GITEA_URL="${GITEA_URL:-http://127.0.0.1:3001}"
ADMIN_USER="${ADMIN_USER:-fixture-admin}"
ADMIN_PASS="${ADMIN_PASS:-fixturePass#1}"
ADMIN_EMAIL="${ADMIN_EMAIL:-fixture-admin@example.invalid}"
REPO_NAME="${REPO_NAME:-sample}"

log() { printf '[seed-gitea] %s\n' "$*" >&2; }

# Wait for gitea API to respond (compose healthcheck should already have
# blocked, but belt + suspenders for direct `bash seed-gitea.sh` callers).
for i in $(seq 1 60); do
  if curl -sf "$GITEA_URL/api/v1/version" > /dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 60 ]; then
    log "gitea never became ready"
    exit 1
  fi
  sleep 1
done
log "gitea responding"

# 1. Create the admin user via the gitea CLI inside the container.
# This is the bootstrap step — once the install lock is on, the API
# requires an existing user to create others, but the CLI bypasses
# auth and lets us seed the very first one.
# Gitea ships its config at /data/gitea/conf/app.ini (NOT /etc/gitea/app.ini
# — that's the template directory). The path was verified by `find / -name app.ini`
# inside the running container; if a future gitea release relocates it, the
# next `seed-gitea.sh` run will fail loudly here with the same MustInstalled
# fatal log — change this path AND keep the failure mode visible.
if docker exec aw-gitea-test su git -c \
    "/usr/local/bin/gitea --config /data/gitea/conf/app.ini admin user create \
       --username '$ADMIN_USER' \
       --password '$ADMIN_PASS' \
       --email '$ADMIN_EMAIL' \
       --admin \
       --must-change-password=false" 2>&1 | tee /tmp/gitea-create-user.log; then
  log "admin user created"
else
  # User already exists (re-run case) — confirm via API.
  if curl -sf -u "$ADMIN_USER:$ADMIN_PASS" "$GITEA_URL/api/v1/user" > /dev/null; then
    log "admin user already exists (re-run, ok)"
  else
    log "user create failed AND user not present — seed-gitea aborting"
    exit 1
  fi
fi

# 2. Create an API token for the admin so downstream curl calls don't
# leak basic-auth password in logs.
TOKEN_NAME="fixture-token-$(date +%s)"
TOKEN_RES=$(curl -sf -u "$ADMIN_USER:$ADMIN_PASS" \
  -H 'Content-Type: application/json' \
  -X POST "$GITEA_URL/api/v1/users/$ADMIN_USER/tokens" \
  -d "{\"name\":\"$TOKEN_NAME\",\"scopes\":[\"write:repository\",\"write:user\"]}")
ADMIN_TOKEN=$(echo "$TOKEN_RES" | sed -n 's/.*"sha1":"\([^"]*\)".*/\1/p')
if [ -z "$ADMIN_TOKEN" ]; then
  log "FAILED to extract token from response: $TOKEN_RES"
  exit 1
fi
log "admin token minted ($TOKEN_NAME)"

# 3. Create the test repo (idempotent — 409 means already exists).
CREATE_REPO_STATUS=$(curl -s -o /tmp/gitea-create-repo.json -w '%{http_code}' \
  -H "Authorization: token $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -X POST "$GITEA_URL/api/v1/user/repos" \
  -d "{\"name\":\"$REPO_NAME\",\"description\":\"W3-4 git-protocols fixture\",\"private\":false,\"auto_init\":true,\"default_branch\":\"main\"}")
case "$CREATE_REPO_STATUS" in
  201) log "repo created" ;;
  409) log "repo already exists (re-run, ok)" ;;
  *)
    log "repo create returned HTTP $CREATE_REPO_STATUS"
    cat /tmp/gitea-create-repo.json >&2
    exit 1 ;;
esac

# 4. Emit env-var lines for the workflow / dev caller.
# Use a $GITHUB_OUTPUT-compatible shape that's also human-readable.
HTTPS_URL="http://${ADMIN_USER}:${ADMIN_TOKEN}@127.0.0.1:3001/${ADMIN_USER}/${REPO_NAME}.git"
SSH_URL="ssh://git@127.0.0.1:2222/${ADMIN_USER}/${REPO_NAME}.git"
cat <<EOF
GITEA_BASE_URL=${GITEA_URL}
GITEA_ADMIN_USER=${ADMIN_USER}
GITEA_ADMIN_TOKEN=${ADMIN_TOKEN}
GITEA_REPO_HTTPS_URL=${HTTPS_URL}
GITEA_REPO_SSH_URL=${SSH_URL}
EOF
log "seed complete"
