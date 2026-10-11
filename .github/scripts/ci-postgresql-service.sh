#!/usr/bin/env bash
set -euo pipefail

# CI's two real PostgreSQL lanes keep the same official 17 image, database,
# port and Docker health contract. Pull only after the daemon cache is enabled.
ci_pg_name=aw-ci-postgresql

start_postgres() {
  pg_database=${1:?PostgreSQL database is required}
  ci_daemon_before=''
  ci_daemon_after=''
  trap 'rm -f -- "$ci_daemon_before" "$ci_daemon_after"' EXIT
  ci_daemon_before=$(mktemp "${RUNNER_TEMP:?}/aw-ci-docker-before.XXXXXX.json")
  ci_daemon_after=$(mktemp "$RUNNER_TEMP/aw-ci-docker-after.XXXXXX.json")

  if sudo test -f /etc/docker/daemon.json; then
    sudo cat /etc/docker/daemon.json > "$ci_daemon_before"
  else
    printf '{}\n' > "$ci_daemon_before"
  fi
  jq -e '
    .["registry-mirrors"] =
      (["https://mirror.gcr.io"] +
       ((.["registry-mirrors"] // []) |
        map(select(. != "https://mirror.gcr.io" and . != "https://mirror.gcr.io/"))))
  ' "$ci_daemon_before" > "$ci_daemon_after"
  sudo mkdir -p /etc/docker
  sudo install --mode=0644 "$ci_daemon_after" /etc/docker/daemon.json
  sudo systemctl restart docker
  docker info --format '{{json .RegistryConfig.Mirrors}}'

  pg_image=docker.io/library/postgres:17
  if ! timeout 120s docker pull "$pg_image"; then
    echo '::warning::Docker Hub/cache pull failed; trying the original ECR Public image'
    pg_image=public.ecr.aws/docker/library/postgres:17
    if ! timeout 120s docker pull "$pg_image"; then
      echo '::error::Both PostgreSQL 17 image sources failed'
      return 1
    fi
  fi
  echo "PostgreSQL image: $pg_image"
  docker image inspect --format '{{json .RepoDigests}}' "$pg_image"
  docker run --detach --pull=never --name "$ci_pg_name" \
    --env POSTGRES_PASSWORD=postgres --env "POSTGRES_DB=$pg_database" \
    --publish 5432:5432 \
    --health-cmd 'pg_isready -U postgres' \
    --health-interval 5s --health-timeout 5s --health-retries 20 \
    "$pg_image"

  while true; do
    pg_state=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$ci_pg_name")
    case "$pg_state" in
      'running healthy') break ;;
      'running starting') sleep 2 ;;
      *)
        echo "::error::PostgreSQL did not become healthy: $pg_state"
        return 1
        ;;
    esac
  done
  pg_version=$(docker exec "$ci_pg_name" postgres --version)
  echo "$pg_version"
  case "$pg_version" in
    'postgres (PostgreSQL) 17.'*) ;;
    *)
      echo "::error::Expected PostgreSQL 17, got: $pg_version"
      return 1
      ;;
  esac
}

stop_postgres() {
  # A pull/start failure can leave no container. A failed log read must still
  # proceed to remove this job's container, as the original runner cleanup did.
  pg_names=$(docker ps --all --filter "name=$ci_pg_name" --format '{{.Names}}')
  while IFS= read -r pg_found; do
    if [[ "$pg_found" == "$ci_pg_name" ]]; then
      docker logs "$ci_pg_name" || echo '::warning::Could not read PostgreSQL container logs'
      docker rm --force "$ci_pg_name"
      break
    fi
  done <<< "$pg_names"
}

case "${1:-}" in
  start) start_postgres "${2:?PostgreSQL database is required}" ;;
  stop) stop_postgres ;;
  *)
    echo 'Usage: ci-postgresql-service.sh start DATABASE | stop' >&2
    exit 2
    ;;
esac
