# RFC-370 M0 — agent-workflow as a CrewStation-hosted control plane.
#
# The publish script places this file at the root of the CrewStation project
# repository next to the agent-workflow sources; the platform builds it with
# BuildKit for the cluster's architecture. The runtime image carries only the
# single binary: a service slot runs no git and no agent runtime (execution runs
# in platform task containers), and all state lives in the platform database.
FROM oven/bun:1.4.3 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
 && bun run build:binary \
 && cp "$(ls dist/agent-workflow-linux-* | grep -v -- '-e2e-' | head -n 1)" /agent-workflow

FROM debian:bookworm-slim
# Retry the whole apt step on transient mirror failures (see task.Dockerfile).
RUN for attempt in 1 2 3 4 5; do \
      apt-get -o Acquire::Retries=5 update \
      && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ca-certificates \
      && break; \
      echo "apt attempt $attempt failed" >&2; sleep $((attempt * 10)); \
    done \
 && dpkg -s ca-certificates >/dev/null \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 agent-workflow
COPY --from=build /agent-workflow /usr/local/bin/agent-workflow
USER agent-workflow
ENV AW_DEPLOYMENT_MODE=crewstation \
    AGENT_WORKFLOW_HOME=/home/agent-workflow/.agent-workflow
EXPOSE 3000
CMD ["agent-workflow", "start"]
