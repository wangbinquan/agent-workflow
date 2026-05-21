# scripts/git-protocols — gitea test fixture (RFC-054 W3-4)

Brings up a real Gitea instance for the `e2e/git-protocols.spec.ts` suite.
Two files in this directory + one compose file at repo root form the
fixture; the CI workflow `.github/workflows/git-protocols-e2e.yml` wires
them together.

| File                            | Role                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `../../docker-compose.test.yml` | Gitea service (1.22.6 pinned) on `localhost:3001` HTTP + `localhost:2222` SSH. |
| `seed-gitea.sh`                 | Bootstrap admin user + API token + test repo. Idempotent. Emits env-var lines. |
| `README.md` (this file)         | Human-facing operator docs.                                                    |

## Running locally

Docker Desktop must be running (the daemon must be reachable on
`/var/run/docker.sock` / `~/.docker/run/docker.sock`).

```sh
# 1. Start gitea.
docker compose -f docker-compose.test.yml up -d

# 2. Wait until healthy + seed admin user / repo / token.
#    The script blocks on the HTTP health probe internally.
eval "$(scripts/git-protocols/seed-gitea.sh)"

# 3. Run the spec against the live fixture.
RUN_GIT_PROTOCOLS=1 bun run e2e e2e/git-protocols.spec.ts

# 4. Tear down (drops the named volume so the next run starts clean).
docker compose -f docker-compose.test.yml down -v
```

`eval $(seed-gitea.sh)` exports five env vars the spec reads:

```
GITEA_BASE_URL=http://127.0.0.1:3001
GITEA_ADMIN_USER=fixture-admin
GITEA_ADMIN_TOKEN=<sha1>
GITEA_REPO_HTTPS_URL=http://fixture-admin:<token>@127.0.0.1:3001/fixture-admin/sample.git
GITEA_REPO_SSH_URL=ssh://git@127.0.0.1:2222/fixture-admin/sample.git
```

The script also emits human-readable progress lines to STDERR so the
`eval` capture (which only reads stdout) doesn't grab them.

## Port mapping rationale

- **3001** (host) → **3000** (gitea container) — port 3000 is also
  Vite's default in some configurations; 3001 dodges the collision
  without changing gitea's internal binding.
- **2222** (host) → **2222** (gitea container's built-in SSH) — gitea
  ships its own openssh on container port 22, which would conflict if
  we also told gitea's built-in Go SSH server to bind 22. The compose
  sets `GITEA__server__SSH_LISTEN_PORT=2222` to dodge this.

If either host port is in use locally, change the LEFT side of the
mapping in `docker-compose.test.yml` only. The right side is fixed by
the gitea image's entrypoint.

## CI workflow (`.github/workflows/git-protocols-e2e.yml`)

Triggers:

- **schedule**: `0 8 * * *` UTC — daily nightly run.
- **workflow_dispatch**: manual button for ad-hoc verification.
- **pull_request**: only when the PR diff touches
  `packages/backend/src/services/gitRepoCache.ts`,
  `packages/shared/src/git-url.ts`, this directory, the compose file,
  or the workflow file itself. Every other PR skips it.

Sequence within the job:

1. `actions/checkout@v5`
2. `docker compose -f docker-compose.test.yml up -d`
3. `scripts/git-protocols/seed-gitea.sh > /tmp/seed.env` then export to `$GITHUB_ENV`
4. `bun install --frozen-lockfile`
5. `bun run build:binary` (the spec needs the daemon binary)
6. `bunx playwright install --with-deps chromium`
7. `RUN_GIT_PROTOCOLS=1 bun run e2e e2e/git-protocols.spec.ts`
8. `docker compose -f docker-compose.test.yml down -v` (always-run cleanup)

Total wall-clock: ~2 min (gitea boot 30s + seed 5s + daemon start 5s +
3 cases ~30s + teardown 10s).

## Re-running after a partial failure

The seed script is idempotent — if a previous attempt left the admin
user but failed at the repo step, re-running the script will:

- Detect the existing user (HTTP 422 on `admin user create`) → continue.
- Re-mint a fresh token (each run creates a new uniquely-named one).
- Detect the existing repo (HTTP 409 on POST `/user/repos`) → continue.

`docker compose down -v` drops the gitea volume entirely; re-running
`up + seed` starts from scratch. For partial debug, `docker exec
aw-gitea-test su git -c 'gitea --config /data/gitea/conf/app.ini doctor'`
runs the gitea doctor inside the container.

## Bumping the gitea version

Edit `docker-compose.test.yml`'s `image:` tag. Quarterly cadence is
fine; gitea publishes new minors every ~6 weeks but the protocol surface
this suite exercises (HTTP clone, API token, SSH clone) hasn't
meaningfully changed since 1.20+. Big bumps (e.g. 1.x → 2.x) deserve
their own PR with a re-baseline of the seed script's exit codes
(`gitea admin user create` semantics) and the path of `app.ini`
(was `/etc/gitea/app.ini` pre-1.22, `/data/gitea/conf/app.ini` since).

## What this spec does NOT cover

- **SSH clone via daemon**: gated behind a daemon-side feature that
  threads `GIT_SSH_COMMAND` / a per-task private-key path through
  `gitRepoCache.ts`. The spec has a `describe.skip` block documenting
  the follow-up surface; until that lands, only HTTPS is exercised.
- **Non-fast-forward push**: this fixture's seeded repo is empty
  (`auto_init: true` just creates a README commit). Push-side flows
  belong to a different RFC (collaborative tasks).
- **GPG-signed commits / branch protection**: gitea supports both, but
  the daemon's clone path doesn't care — out of scope here.
