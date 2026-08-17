// RFC-304 §11.2 AC-34 — the receipt, driven by a real event through a real daemon.
//
// The unit cases prove the receipt module. They cannot prove the two things
// that were actually wrong, and this file exists because both of them got past
// unit tests and past me:
//
//   1. nothing CALLED it. `mrVoice.answer` was complete, correct and covered,
//      with no production caller — so no person had ever received a receipt
//      while every unit case stayed green.
//   2. once called, it could not WORK. `comment.create` in the shared catalog
//      is merge-request-only (GitLab binds `/merge_requests/{mr}/notes`), so
//      answering on an issue reached nothing at all. The first version of the
//      fix logged a warning and returned — wiring that silently does nothing,
//      which reads as done. This spec is what found that, and the catalog
//      gained `comment.{create,list,update}-issue` because of it.
//
// What it pins, in the order the person experiences it:
//
//   · labelling an issue produces ONE acknowledgement, on that issue;
//   · everything after — routing, then the round's terminal answer — EDITS that
//     same comment, so the whole exchange costs one notification;
//   · an automatic merge-request event produces NO receipt. That is the other
//     half of §11.2 and the easier half to break: a rule that answers
//     everything is a bot people mute, and muting takes the conflict report and
//     the three-attempt hand-off with it.

import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SYSTEM_MOCK_CODE_HOST_TOKEN, SystemMockClient } from '@agent-workflow/system-mocks'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })

const PROJECT_PATH = 'system-e2e/rfc304-receipt'
const ISSUE_NUMBER = 91

let daemon: DaemonHandle
let mocks: SystemMockClient
let endpoint: { urlToken: string; secret: string }
let project: { projectId: string; repoHttpUrl: string; number: number }

test.beforeAll(async () => {
  mocks = new SystemMockClient(
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_URL'),
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_TOKEN'),
  )
  // NOT `mocks.reset()`: one mock suite serves every worker, and resetting here
  // deletes the projects other specs are mid-way through. `mine()` filters to
  // this spec's own project instead.

  const stateDir = mkdtempSync(join(tmpdir(), 'rfc304-receipt-'))
  daemon = await startDaemon({
    stubMode: 'runtime-scenario',
    extraEnv: { SCENARIO_STATE_DIR: stateDir },
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
    baseFiles: { 'src/a.ts': 'export const start = () => {}\n' },
    headFiles: { 'src/a.ts': 'export const start = () => {}\nexport const next = () => {}\n' },
    // The issue has to exist before it can be labelled — the mock refuses an
    // event for an object it does not have, which is right and keeps this spec
    // from asserting against a fiction.
    issues: [{ number: ISSUE_NUMBER, title: 'Add a stop guard' }],
  })

  const analyst = await requestJson<{ id: string }>('/api/agents', {
    method: 'POST',
    body: {
      name: 'e2e-receipt-analyst',
      description: 'RFC-304 receipt e2e analyst',
      outputs: ['plan'],
      readonly: false,
      bodyMd: 'Understand the requirement.',
    },
  })

  endpoint = await requestJson('/api/webhook-endpoints', {
    method: 'POST',
    body: { name: 'RFC-304 receipt', provider: 'gitlab' },
  })

  const repoId = await importRepo(project.repoHttpUrl)

  const framework = await requestJson<{ id: string }>('/api/capability-templates', {
    method: 'POST',
    body: {
      name: 'receipt framework',
      capability: 'requirement',
      scripts: {},
      hooks: [],
      paramSchema: [],
      paramDefaults: {},
    },
  })
  const binding = await requestJson<{ id: string }>('/api/capability-templates', {
    method: 'POST',
    body: {
      name: 'receipt binding',
      frameworkId: framework.id,
      agentBySlot: { analyst: analyst.id, implementer: analyst.id },
      promptBySlot: {},
      params: {},
    },
  })
  await requestJson(`/api/code/matrix/${repoId}`, {
    method: 'PUT',
    body: { capability: 'requirement', enabled: true, templateId: binding.id },
  })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('labelling an issue is acknowledged, on that issue', async () => {
  // Before this, `requirement` worked in silence for as long as it took — the
  // case §11.2 is written about, where the person concludes nothing was
  // received and labels it again.
  const delivered = await mocks.deliverWebhook({
    provider: 'gitlab',
    callbackUrl: `${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`,
    secret: endpoint.secret,
    projectPath: PROJECT_PATH,
    number: ISSUE_NUMBER,
    event: 'issue_labeled',
    label: 'agent-workflow',
  })
  expect(delivered.status).toBe(200)

  const posted = await waitFor(
    async () => {
      const notes = await receiptPosts()
      return notes.length > 0 ? notes : null
    },
    async () => `a receipt on the issue; saw: ${await requestDigest()}`,
  )

  // On the ISSUE endpoint. The whole reason this spec exists: the merge-request
  // path would 404 (or worse, reach merge request 91), and the person waiting
  // would never see either outcome.
  expect(posted).toHaveLength(1)
  expect(posted[0]?.path).toContain(`/issues/${String(ISSUE_NUMBER)}/notes`)
  expect(posted[0]?.bodyText).toContain('Got it')
})

test('the round’s answer EDITS that comment rather than adding another', async () => {
  // What makes a receipt cheap enough to always send: created once, edited from
  // then on, so "received → working → done" is one notification, not three.
  await waitFor(
    async () => {
      const page = await requestJson<{
        items: Array<{ rounds: Array<{ endedAt: number | null }> }>
      }>('/api/code/work-items?capability=requirement')
      const first = page.items[0]
      return first !== undefined && (first.rounds[0]?.endedAt ?? null) !== null ? first : null
    },
    async () => `the requirement round to finish; ${await requestDigest()}`,
  )

  const edits = await waitFor(
    async () => {
      const seen = mine(await mocks.requests('gitlab')).filter(
        (r) => r.method === 'PUT' && /\/notes\/\d+$/.test(r.path),
      )
      return seen.length > 0 ? seen : null
    },
    async () => `the receipt to be edited; ${await requestDigest()}`,
  )

  expect(edits.length).toBeGreaterThan(0)
  // Still exactly one receipt ever CREATED, across the whole exchange.
  expect(await receiptPosts()).toHaveLength(1)
})

test('an automatic merge-request event gets NO receipt', async () => {
  // The other half of §11.2, and the one that is easy to break by being
  // helpful. A push is a human action but it is not a question, and a machine
  // comment per push is what gets a bot muted — taking the messages that
  // genuinely need a person with it.
  const before = (await receiptPosts()).length

  const delivered = await mocks.deliverWebhook({
    provider: 'gitlab',
    callbackUrl: `${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`,
    secret: endpoint.secret,
    projectPath: PROJECT_PATH,
    number: project.number,
    event: 'mr_updated',
  })
  expect(delivered.status).toBe(200)

  // Settling time: this asserts something does NOT happen, so it has to outlast
  // the window in which it would have.
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  expect(await receiptPosts()).toHaveLength(before)
})

// ---------------------------------------------------------------------------

/** Every comment this spec's project received that carries a receipt marker. */
async function receiptPosts(): Promise<Array<{ path: string; bodyText: string }>> {
  return mine(await mocks.requests('gitlab')).filter(
    (r) => r.method === 'POST' && r.path.includes('/notes') && r.bodyText.includes('aw-receipt:'),
  )
}

async function requestDigest(): Promise<string> {
  try {
    const rows = mine(await mocks.requests('gitlab')).slice(-14)
    return JSON.stringify(
      rows.map((r) => `${r.method} ${r.path} ${r.bodyText.slice(0, 50)}`),
    ).slice(0, 900)
  } catch (error) {
    return `unreadable: ${String(error)}`
  }
}

/** This spec's own project — one mock suite serves every worker. */
function mine<T extends { path: string }>(requests: T[]): T[] {
  const slug = PROJECT_PATH.split('/').at(-1) ?? PROJECT_PATH
  const id = project?.projectId ?? ''
  return requests.filter(
    (r) =>
      (id !== '' && r.path.includes(`/projects/${id}/`)) ||
      r.path.includes(PROJECT_PATH) ||
      r.path.includes(encodeURIComponent(PROJECT_PATH)) ||
      r.path.includes(slug),
  )
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
    throw new Error(`${options.method ?? 'GET'} ${path} → ${String(response.status)}: ${text}`)
  }
  return text === '' ? (undefined as T) : (JSON.parse(text) as T)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}
