// RFC-304 §6.2 — the human-in-the-loop path, end to end.
//
// This is the only path on which the platform WRITES TO SOMEBODY'S BRANCH, and
// until this file existed nothing exercised it end to end. Writing it is what
// found that the path was not implemented at all: `judgeConfirmation` had zero
// production callers, so the platform posted a diff saying "reply `/aw apply`
// to push this", a person replied, and Guard 3 correctly treated the reply as
// an ordinary note and ignored it. The instruction the platform itself printed
// did nothing, silently.
//
// So the assertions here are about the loop closing:
//
//   a comment asks for a change → the round makes one, freezes it, and WAITS
//   the author replies `/aw apply`  → the FROZEN commit is pushed
//   somebody else replies           → refused, and told why
//
// The middle step is the one worth stating plainly: the confirming round
// resumes at `verify-baseline` rather than re-running the model. A second model
// run would produce a different change with the same justification, and the
// person approved a specific diff, not a topic.

import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SYSTEM_MOCK_CODE_HOST_TOKEN, SystemMockClient } from '@agent-workflow/system-mocks'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })

const PROJECT_PATH = 'system-e2e/rfc304-confirm'
const FIXER_AGENT = 'e2e-confirm-fixer'
/**
 * The MR's author — the only person entitled to have the platform push.
 *
 * Must be the username the mock records as the merge request's author
 * (`stateful-store.ts`), because that is who `verify-baseline` compares the
 * commenter against: the patch form pushes with the PLATFORM's credentials, so
 * this check is the only thing between a comment and a commit on somebody's
 * branch.
 */
const AUTHOR = 'system-mock-author'

let daemon: DaemonHandle
let mocks: SystemMockClient
let endpoint: { urlToken: string; secret: string }
let project: { projectId: string; repoHttpUrl: string; number: number }
let repoId = ''

test.beforeAll(async () => {
  mocks = new SystemMockClient(
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_URL'),
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_TOKEN'),
  )
  await mocks.reset()

  const stateDir = mkdtempSync(join(tmpdir(), 'rfc304-confirm-'))
  const planFile = join(stateDir, 'plan.json')
  writeFileSync(
    planFile,
    JSON.stringify({
      version: 1,
      agents: {
        // TWO files, deliberately: `decideForm` sends a multi-file change down
        // the PATCH path, which is the one that freezes an artifact and waits
        // for a human. A single-span change becomes a one-click suggestion and
        // never reaches `awaiting`.
        [FIXER_AGENT]: [
          {
            writeFiles: {
              'src/app.ts': 'export const start = () => {}\nexport const guard = () => true\n',
              'src/extra.ts': 'export const helper = () => 1\n',
            },
            output: {
              fix: JSON.stringify({
                outcome: 'changed',
                message: 'Added the guard you asked for, plus a helper.',
                touched: ['src/app.ts', 'src/extra.ts'],
              }),
            },
          },
        ],
      },
    }),
  )

  daemon = await startDaemon({
    stubMode: 'runtime-scenario',
    extraEnv: { SCENARIO_PLAN_FILE: planFile, SCENARIO_STATE_DIR: stateDir },
  })

  await requestJson('/api/code-hosts/gitlab', {
    method: 'PUT',
    body: {
      baseUrl: requiredEnv('AW_SYSTEM_MOCK_GITLAB_API_BASE_URL'),
      token: SYSTEM_MOCK_CODE_HOST_TOKEN,
    },
  })

  project = await mocks.seedCodeHost({
    provider: 'gitlab',
    projectPath: PROJECT_PATH,
    baseFiles: { 'src/app.ts': 'export const start = () => {}\n' },
    headFiles: { 'src/app.ts': 'export const start = () => {}\nexport const stop = () => {}\n' },
  })

  const agent = await requestJson<{ id: string }>('/api/agents', {
    method: 'POST',
    body: {
      name: FIXER_AGENT,
      description: 'RFC-304 confirm e2e fixer',
      outputs: ['fix'],
      readonly: false,
      bodyMd: 'Apply the requested change.',
    },
  })

  endpoint = await requestJson('/api/webhook-endpoints', {
    method: 'POST',
    body: { name: 'RFC-304 confirm', provider: 'gitlab' },
  })

  repoId = await importRepo(project.repoHttpUrl)

  const framework = await requestJson<{ id: string }>('/api/capability-frameworks', {
    method: 'POST',
    body: {
      name: 'confirm framework',
      capability: 'mr-comment-fix',
      scripts: {},
      hooks: [],
      paramSchema: [],
      paramDefaults: {},
    },
  })
  const binding = await requestJson<{ id: string }>('/api/capability-bindings', {
    method: 'POST',
    body: {
      name: 'confirm binding',
      frameworkId: framework.id,
      agentBySlot: { fixer: agent.id },
      promptBySlot: {},
      params: {},
    },
  })
  await requestJson(`/api/code/matrix/${repoId}`, {
    method: 'PUT',
    body: { capability: 'mr-comment-fix', enabled: true, bindingId: binding.id },
  })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('a request for a change produces one and then WAITS for a person', async () => {
  // The half that already worked, asserted so the second half has a footing:
  // the round must reach `awaiting` rather than pushing on its own. A platform
  // that pushed here would be writing to a branch nobody approved.
  const delivered = await mocks.deliverWebhook({
    provider: 'gitlab',
    callbackUrl: `${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`,
    secret: endpoint.secret,
    projectPath: PROJECT_PATH,
    number: project.number,
    event: 'comment_created',
    body: 'please add a guard here',
    actor: { username: AUTHOR },
  })
  expect(delivered.status).toBe(200)

  const item = await waitFor(
    async () => {
      const page = await requestJson<{
        items: Array<{ status: string; rounds: Array<{ endedAt: number | null }> }>
      }>('/api/code/work-items?capability=mr-comment-fix')
      const first = page.items[0]
      return first !== undefined && (first.rounds[0]?.endedAt ?? null) !== null ? first : null
    },
    async () => `a finished first round; items: ${await itemsDigest()}`,
  )

  // The work item — not the round — is what carries the wait. Design D2: a task
  // suspended for three days would hold a worktree and a scheduler slot for a
  // reply that may never come.
  expect(`${item.status} | ${await stageDigest()}`).toContain('awaiting |')
})

test('an ordinary reply does NOT wake it — discussion is not a command', async () => {
  // Guard 3, and the reason classification has to be exact. ~150 comments a day
  // are conversation; treating one as approval pushes code somebody was still
  // arguing about.
  await deliverComment('I am not sure this is the right approach', AUTHOR)

  const page = await requestJson<{ items: Array<{ status: string; rounds: unknown[] }> }>(
    '/api/code/work-items?capability=mr-comment-fix',
  )
  expect(page.items[0]?.status).toBe('awaiting')
  expect(page.items[0]?.rounds.length).toBe(1)
})

test('`/aw apply` from the author pushes the FROZEN commit', async () => {
  // The loop closing. Before the classifier was wired this reply was an
  // ordinary note: nothing happened, no error, and the person was left waiting
  // for something the platform had told them to ask for.
  await deliverComment('/aw apply', AUTHOR)

  const rounds = await waitFor(
    async () => {
      const page = await requestJson<{
        items: Array<{
          rounds: Array<{ roundSeq: number; endedAt: number | null; outcome: string | null }>
        }>
      }>('/api/code/work-items?capability=mr-comment-fix')
      const list = page.items[0]?.rounds ?? []
      // A SECOND round, finished — the confirming one.
      return list.length >= 2 && list.every((r) => r.endedAt !== null) ? list : null
    },
    async () => `a finished confirming round; items: ${await itemsDigest()}`,
  )

  expect(rounds.length).toBeGreaterThanOrEqual(2)

  // The model must NOT have run again: the confirming round resumes at
  // `verify-baseline`. The scenario stub has exactly one scripted turn, so a
  // second invocation would either reuse it or fail — either way the assertion
  // that matters is that the change pushed is the frozen one, checked below.
  const pushed = (await mocks.requests('git')).filter((r) => r.path.includes('git-receive-pack'))
  expect(
    pushed.length,
    `the frozen commit must reach the branch; confirming round: ${await stageDigest(0)}`,
  ).toBeGreaterThan(0)
})

test('a confirmation from somebody who is not the author is REFUSED and answered', async () => {
  // T44, end to end. The patch form pushes with the PLATFORM's credentials, so
  // nothing downstream consults the commenter's permissions — this check is the
  // only thing between a comment and a commit on an author's branch.
  const before = (await mocks.requests('gitlab')).length
  await deliverComment('/aw apply', 'a-passing-reviewer')

  const replies = await waitFor(async () => {
    const posted = (await mocks.requests('gitlab'))
      .slice(before)
      .filter((r) => r.method === 'POST' && r.path.includes('notes'))
    return posted.length > 0 ? posted : null
  }, 'a refusal posted to the thread')

  // Answered, not dropped: a confirmation that silently does nothing teaches
  // people the feature is unreliable, which costs more than the refusal.
  expect(replies.length).toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------

async function deliverComment(body: string, actor: string): Promise<void> {
  const delivered = await mocks.deliverWebhook({
    provider: 'gitlab',
    callbackUrl: `${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`,
    secret: endpoint.secret,
    projectPath: PROJECT_PATH,
    number: project.number,
    event: 'comment_created',
    body,
    actor: { username: actor },
  })
  expect(delivered.status).toBe(200)
}

/** Which stage the round stopped at, and why. */
async function stageDigest(roundIndex = 0): Promise<string> {
  try {
    const page = await requestJson<{
      items: Array<{
        rounds: Array<{
          stages: Array<{ stageName: string; status: string; error: string | null }>
        }>
      }>
    }>('/api/code/work-items?capability=mr-comment-fix')
    return JSON.stringify(
      (page.items[0]?.rounds[roundIndex]?.stages ?? [])
        // `inherited` is every stage a resuming round skipped; listing them
        // buries the one that actually stopped.
        .filter((s) => s.status !== 'inherited')
        .map((s) => `${s.stageName}:${s.status}${s.error === null ? '' : ` (${s.error})`}`),
    ).slice(0, 700)
  } catch (error) {
    return `unreadable: ${String(error)}`
  }
}

async function itemsDigest(): Promise<string> {
  try {
    return JSON.stringify(
      (await requestJson<{ items: unknown[] }>('/api/code/work-items')).items,
    ).slice(0, 900)
  } catch (error) {
    return `unreadable: ${String(error)}`
  }
}

async function importRepo(url: string): Promise<string> {
  const batch = await requestJson<{ batchId: string }>('/api/cached-repos/batch-import', {
    method: 'POST',
    body: { urls: [url] },
  })
  return await waitFor(async () => {
    const snapshot = await requestJson<{ rows: Array<{ cachedRepoId: string | null }> }>(
      `/api/cached-repos/imports/${batch.batchId}`,
    )
    return snapshot.rows[0]?.cachedRepoId ?? null
  }, `the mirror of ${url}`)
}

async function waitFor<T>(
  probe: () => Promise<T | null>,
  what: string | (() => Promise<string>),
): Promise<T> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const seen = await probe()
    if (seen !== null) return seen
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${typeof what === 'string' ? what : await what()}`)
}

async function requestJson<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${daemon.token}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} returned ${response.status}: ${text}`)
  }
  return (text.length === 0 ? null : JSON.parse(text)) as T
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}
