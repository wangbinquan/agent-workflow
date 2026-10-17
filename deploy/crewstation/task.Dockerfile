# RFC-370 M1: the task volume's Git and script effects run this exact AW binary.
# Agent runtimes remain in CS Agent subtask images, selected by compute profile.
ARG CS_BASE_IMAGE
FROM oven/bun:1.4.3 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
 && bun run build:binary \
 && cp "$(ls dist/agent-workflow-linux-* | grep -v -- '-e2e-' | head -n 1)" /agent-workflow

FROM ${CS_BASE_IMAGE}
USER root
# Retry transient mirror failures (2026-10-17: ~1 in 50 package fetches failed to connect).
RUN apt-get -o Acquire::Retries=5 update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends git ca-certificates openssh-client python3 python3-venv python3-pip nodejs npm bash \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /agent-workflow /usr/local/bin/agent-workflow
ENV AGENT_WORKFLOW_HOME=/work/.agent-workflow
# Retain the platform TaskRunner entrypoint and worker identity. CrewStation
# injects CS_BASE_IMAGE pinned by digest and verifies the final base lineage.
