// RFC-054 W3-4 — git protocols e2e against a real Gitea container.
//
// LOCKS the daemon's git layer end-to-end against a real server:
//   * HTTPS clone via the daemon's repo cache (gitRepoCache.ts) works
//     against a real Gitea instance (not a mocked git remote).
//   * Cleartext credentials in the input URL never leak into the
//     persisted task row's `repoUrl` field — `redactGitUrl` runs on
//     the persistence boundary, not just in the log adapter.
//   * SSH clone with a deploy key (private key on disk + matching
//     public key registered with gitea) works — gates the daemon's
//     ssh-url branch which has zero current coverage.
//
// Gating: these tests do NOT run during normal `bun run e2e`. They
// require a running gitea container at `GITEA_BASE_URL` AND a seeded
// admin token, both supplied by the `git-protocols-e2e.yml` CI
// workflow (which runs `docker compose up` + `scripts/git-protocols/
// seed-gitea.sh` first) OR by a developer following the steps in
// `scripts/git-protocols/README.md` locally.
//
// Why a separate compose / workflow not bolted into the daemon's PR e2e:
//   * Gitea takes ~30s to boot + the seed script adds another 5s.
//     Bolting this onto every PR adds ~35s × 4 shards of setup time.
//   * The git protocol surface is stable — RFC-054 plan calls for daily
//     cron + path-filtered PRs (when gitRepoCache.ts / git-url.ts
//     touch the diff).
//
// SSH note: the SSH test is currently skipped — getting the daemon to
// pick up a deploy key requires extending `gitRepoCache` to accept a
// custom `GIT_SSH_COMMAND` or `~/.ssh/id_ed25519_test` path, which is
// scoped to a follow-up PR. The skip's `describe.skip` block documents
// the protocol shape and what to flip when the daemon grows that
// capability.

import { test, expect } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

const RUN_GIT_PROTOCOLS = process.env.RUN_GIT_PROTOCOLS === '1'
const GITEA_BASE_URL = process.env.GITEA_BASE_URL ?? ''
const GITEA_REPO_HTTPS_URL = process.env.GITEA_REPO_HTTPS_URL ?? ''
const GITEA_ADMIN_TOKEN = process.env.GITEA_ADMIN_TOKEN ?? ''
const SKIP = !RUN_GIT_PROTOCOLS || !GITEA_BASE_URL || !GITEA_REPO_HTTPS_URL

let daemon: DaemonHandle

test.beforeAll(async () => {
  if (SKIP) return
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test.describe('RFC-054 W3-4 — git protocols against real Gitea', () => {
  test.skip(SKIP, 'gitea fixture not configured (see scripts/git-protocols/README.md)')

  test('HTTPS: daemon can clone a public repo via a credentialed URL + persisted repoUrl is redacted', async () => {
    // POST a task targeting the gitea URL. The daemon's gitRepoCache
    // does the actual clone. We only check that the response indicates
    // a successful resolution (no clone-failure error).
    const seedRes = await fetch(`${daemon.baseUrl}/api/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${daemon.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'gitea-https-agent',
        description: 'W3-4 agent for HTTPS clone',
        outputs: ['answer'],
        readonly: true,
        bodyMd: '',
      }),
    })
    expect(seedRes.ok).toBe(true)
    const agent = (await seedRes.json()) as { id: string }

    const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${daemon.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'gitea-https-wf',
        description: 'W3-4',
        definition: {
          $schema_version: 1,
          inputs: [{ kind: 'text', key: 't', label: 'T', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 't', position: { x: 0, y: 0 } },
            {
              id: 'a',
              kind: 'agent-single',
              agentId: agent.id,
              agentName: 'gitea-https-agent',
              promptTemplate: '{{t}}',
              position: { x: 300, y: 0 },
            },
            {
              id: 'o',
              kind: 'output',
              ports: [{ name: 'answer', bind: { nodeId: 'a', portName: 'answer' } }],
              position: { x: 600, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e1',
              source: { nodeId: 'in_1', portName: 't' },
              target: { nodeId: 'a', portName: 't' },
            },
            {
              id: 'e2',
              source: { nodeId: 'a', portName: 'answer' },
              target: { nodeId: 'o', portName: 'answer' },
            },
          ],
        },
      }),
    })
    expect(wfRes.ok).toBe(true)
    const wf = (await wfRes.json()) as { id: string }

    // Submit task with repoUrl (credentialed). Daemon clones it into
    // its repo cache + creates a worktree for the task.
    const taskRes = await fetch(`${daemon.baseUrl}/api/tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${daemon.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'gitea-https-task',
        workflowId: wf.id,
        repoUrl: GITEA_REPO_HTTPS_URL,
        ref: 'main',
        inputs: { t: 'hello' },
      }),
    })
    expect(taskRes.status).toBe(201)
    const task = (await taskRes.json()) as { id: string; repoUrl: string | null }
    expect(task.id).toBeTruthy()

    // Post-fix (KNOWN_GAP resolved): services/task.ts now runs
    // redactGitUrl on input.repoUrl before persisting. The cleartext
    // token must NOT appear in the persisted row; the redacted form
    // (`***@host`) must be visible to anyone with task-read access.
    expect(task.repoUrl).toBeTruthy()
    expect(task.repoUrl).not.toContain(GITEA_ADMIN_TOKEN)
    expect(task.repoUrl).toContain('***')
  })

  test('HTTPS: bogus URL is rejected with a clear error (no daemon crash)', async () => {
    const res = await fetch(`${daemon.baseUrl}/api/tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${daemon.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'gitea-bogus-task',
        workflowId: 'nonexistent-workflow',
        repoUrl: 'http://does-not-exist.invalid:9999/missing/repo.git',
        ref: 'main',
        inputs: { t: 'hello' },
      }),
    })
    // Either 4xx (validation rejects bogus workflow/url) or 422
    // (input schema). The point is no 5xx daemon crash + structured
    // error response.
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('Gitea API is reachable from the spec (sanity)', async () => {
    // Sanity that we're hitting a real gitea. If the spec fails with
    // "fetch failed", the fixture probably didn't boot — check the
    // workflow log for `docker compose up` output.
    const res = await fetch(`${GITEA_BASE_URL}/api/v1/version`)
    expect(res.ok).toBe(true)
    const body = (await res.json()) as { version: string }
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})

// Separate describe block kept skipped — the SSH path needs daemon
// changes to thread a custom GIT_SSH_COMMAND / private-key path
// through to `git clone`. Documenting the surface here so the
// follow-up PR has a clear contract to fill.
test.describe.skip('RFC-054 W3-4 — SSH path (deploy-key, follow-up)', () => {
  test('SSH: daemon clones with a deploy key registered against the fixture user', async () => {
    // Future PR: add `gitRepoCache` support for per-task env
    // `GIT_SSH_COMMAND="ssh -i $PRIVATE_KEY -o StrictHostKeyChecking=no"`,
    // then POST task with repoUrl=ssh://git@127.0.0.1:2222/fixture-admin/sample.git
    // and assert successful clone.
  })
})
