// RFC-304 — the capability platform, end to end through a compiled daemon.
//
// This file exists because of what the implementation-completeness audit found
// (plan §2bis). Every gap it turned up had the same shape — both halves correct,
// no join — and every one of them was invisible to unit tests by construction:
//
//   * the scheduler wired `mr-review` and nothing else, so three capabilities
//     had complete, unit-tested stage compositions that production could never
//     reach;
//   * T45's invalidation was written, tested, and never called;
//   * `rejectFrameworkOnlyFields` had zero callers from the PR that added it.
//
// A unit test cannot see any of that: it holds one half in its hand and asserts
// the half is correct, which it is. Only a real daemon — real HTTP, real SQLite,
// real webhook signature, real scheduler — puts the halves in the same room and
// notices there is nothing between them.
//
// So the assertions below are deliberately about REACHABILITY rather than about
// stage logic. Stage logic already has unit tests and they were never the
// problem.
//
// Real here: the compiled daemon, its public API, SQLite, the scheduler, the
// webhook signature path, and a stateful GitLab that serves real diffs over
// real Git. Faked: only the model, through the plan-driven runtime stand-in —
// which is the one thing that must be deterministic for a round to be an
// assertion rather than a coin flip.

import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SYSTEM_MOCK_CODE_HOST_TOKEN, SystemMockClient } from '@agent-workflow/system-mocks'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })

const PROJECT_PATH = 'system-e2e/rfc304-capability'
const REVIEWER_AGENT = 'e2e-code-reviewer'

/** The one finding the stubbed reviewer returns, in the T4b envelope shape. */
const STUB_FINDING = {
  file: 'src/app.ts',
  line: 2,
  side: 'new' as const,
  severity: 'major' as const,
  title: 'e2e finding: the added line needs a guard',
  body: 'This line is what the E2E asserts reaches the merge request.',
}

let daemon: DaemonHandle
let mocks: SystemMockClient
let stateDir = ''
let endpoint: { urlToken: string; secret: string }
let project: { projectId: string; repoHttpUrl: string; number: number }
let repoId = ''
let reviewerAgentId = ''
let frameworkId = ''
let bindingId = ''

test.beforeAll(async () => {
  mocks = new SystemMockClient(
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_URL'),
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_TOKEN'),
  )
  await mocks.reset()

  // The model is the only faked participant, and it answers with a fixed
  // envelope. That is what makes "a line comment appeared" an assertion about
  // the platform rather than about a model's mood on the day.
  stateDir = mkdtempSync(join(tmpdir(), 'rfc304-e2e-'))
  const planFile = join(stateDir, 'plan.json')
  writeFileSync(
    planFile,
    JSON.stringify({
      version: 1,
      agents: {
        [REVIEWER_AGENT]: [{ output: { findings: JSON.stringify({ findings: [STUB_FINDING] }) } }],
      },
    }),
  )

  daemon = await startDaemon({
    stubMode: 'runtime-scenario',
    extraEnv: { SCENARIO_PLAN_FILE: planFile, SCENARIO_STATE_DIR: stateDir },
  })

  await requestJson(`/api/code-hosts/gitlab`, {
    method: 'PUT',
    body: {
      baseUrl: requiredEnv('AW_SYSTEM_MOCK_GITLAB_API_BASE_URL'),
      token: SYSTEM_MOCK_CODE_HOST_TOKEN,
    },
  })

  // A real two-revision tree, so `mr.diff` returns a diff with a line the
  // finding can actually be anchored to. A seeded MR with no diff would let a
  // broken position mapper pass by having nothing to map.
  project = await mocks.seedCodeHost({
    provider: 'gitlab',
    projectPath: PROJECT_PATH,
    baseFiles: { 'src/app.ts': 'export const start = () => {}\n' },
    headFiles: { 'src/app.ts': 'export const start = () => {}\nexport const stop = () => {}\n' },
  })

  // The agent the binding maps to the `reviewer` slot. Named the same as the
  // key in the scenario plan, because that name is what reaches the runtime as
  // `--agent` and is how the stand-in picks its scripted answer.
  const agent = await requestJson<{ id: string }>('/api/agents', {
    method: 'POST',
    body: {
      name: REVIEWER_AGENT,
      description: 'RFC-304 e2e reviewer',
      outputs: ['findings'],
      readonly: true,
      bodyMd: 'Review the diff.',
    },
  })
  // The ID, not the name: `resolveAgentForBinding` looks the slot's value up
  // with `getAgentById`, so a name here resolves to nothing and the cell
  // reports `agent-not-visible` — which reads like a permission problem rather
  // than the type error it is.
  reviewerAgentId = agent.id

  endpoint = await requestJson('/api/webhook-endpoints', {
    method: 'POST',
    body: { name: 'RFC-304 capability platform', provider: 'gitlab' },
  })

  repoId = await importRepo(project.repoHttpUrl)
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('a framework and a binding configure a capability, and the binding REFUSES framework-only fields', async () => {
  // T57's two-layer split, asserted where it is enforced rather than where it
  // is declared. `rejectFrameworkOnlyFields` existed with zero callers for
  // several PRs — a rule that is only unit-tested cannot tell you that.
  const framework = await requestJson<{ id: string }>('/api/capability-frameworks', {
    method: 'POST',
    body: {
      name: 'e2e review framework',
      capability: 'mr-review',
      scripts: {},
      hooks: [],
      paramSchema: [],
      paramDefaults: {},
    },
  })
  frameworkId = framework.id

  const binding = await requestJson<{ id: string }>('/api/capability-bindings', {
    method: 'POST',
    body: {
      name: 'e2e review binding',
      frameworkId,
      agentBySlot: { reviewer: reviewerAgentId },
      promptBySlot: {},
      params: {},
    },
  })
  bindingId = binding.id

  // The load-bearing half: a binding carrying a script must be REJECTED, not
  // quietly stripped. Silently dropping a hook is how a team comes to believe
  // their gate runs when it never did — and they would only find out from the
  // absence of failures.
  const refused = await rawRequest('/api/capability-bindings', {
    method: 'POST',
    body: {
      name: 'e2e binding with a script',
      frameworkId,
      agentBySlot: {},
      promptBySlot: {},
      params: {},
      scripts: { collect: { language: 'bash', script: 'echo hi' } },
    },
  })
  expect(refused.status).toBeGreaterThanOrEqual(400)
  expect(refused.status).toBeLessThan(500)
})

test('enabling a capability round-trips, and the matrix reports READINESS not just enabled', async () => {
  // `enabled` and `ready` are different questions, and conflating them is what
  // makes a misconfigured repository look fine: `judgeWake` refuses anything
  // that is not `ready`, so a cell can sit enabled and permanently silent.
  // The matrix is where that difference has to be visible.
  await requestJson(`/api/code/matrix/${repoId}`, {
    method: 'PUT',
    body: { capability: 'mr-review', enabled: true, bindingId },
  })

  const row = await matrixRow()
  expect(row.enabled).toBe(true)
  expect(row.bindingId).toBe(bindingId)

  // Not asserted as a bare `ready`: when it is not ready the failure message
  // should say WHICH piece is missing, which is the whole point of `issues`
  // travelling beside the state.
  expect({ readiness: row.readiness, issues: row.issues }).toEqual({
    readiness: 'ready',
    issues: [],
  })
})

test('a cell whose binding names no agent reports the missing piece and a repair for it', async () => {
  // The negative half, and the one that matters operationally: an unready cell
  // must say what to do about it. A bare `blocked` sends somebody hunting
  // through five screens for a binding they never made.
  const empty = await requestJson<{ id: string }>('/api/capability-bindings', {
    method: 'POST',
    body: {
      name: 'e2e binding with no agent',
      frameworkId,
      agentBySlot: {},
      promptBySlot: {},
      params: {},
    },
  })
  await requestJson(`/api/code/matrix/${repoId}`, {
    method: 'PUT',
    body: { capability: 'mr-comment-fix', enabled: true, bindingId: empty.id },
  })

  const row = await matrixRow('mr-comment-fix')
  expect(row.readiness).not.toBe('ready')
  expect(row.issues.length).toBeGreaterThan(0)
  // One repair per issue, in the same order — so a UI can put the button next
  // to the sentence rather than guessing the correspondence.
  expect(row.repairActions.length).toBe(row.issues.length)

  // Left disabled: an unready cell enabled for the rest of the file would make
  // every later assertion about `mr-review` ambiguous.
  await requestJson(`/api/code/matrix/${repoId}`, {
    method: 'PUT',
    body: { capability: 'mr-comment-fix', enabled: false, bindingId: empty.id },
  })
})

test('a signed merge-request webhook reaches the configured capability and opens a round', async () => {
  // THE assertion this file exists for. Before the audit's wiring fix a round
  // for an unwired capability failed at stage one with "has no runner
  // registered yet" — a message no unit test could produce, because in a unit
  // test the composition is always handed in by the test itself.
  const delivered = await mocks.deliverWebhook({
    provider: 'gitlab',
    callbackUrl: `${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`,
    secret: endpoint.secret,
    projectPath: PROJECT_PATH,
    number: project.number,
    event: 'mr_opened',
  })
  expect(delivered.status).toBe(200)

  const item = await waitFor(
    async () => {
      const page = await requestJson<{
        items: Array<{
          capability: string
          rounds: Array<{ roundId: string; endedAt: number | null; stages: unknown[] }>
        }>
      }>('/api/code/work-items?capability=mr-review')
      const found = page.items[0]
      // Not merely "a round exists". A round is created before the engine has
      // run anything, so asserting on its existence alone passes while every
      // stage is still unborn — which is exactly how the later "no runner
      // registered" assertion would have been vacuous.
      const round = found?.rounds[0]
      return found !== undefined && round !== undefined && round.endedAt !== null ? found : null
    },
    // The delivery row is what says WHY nothing happened — dropped for an
    // unmatched repository reads identically to a capability that never woke,
    // and the two have completely different fixes.
    // Three accounts, because "no round finished" has three quite different
    // causes that look identical from outside: the delivery was dropped before
    // any capability saw it, the round stalled at a stage, or the task never
    // got the repository. Each of those was a real failure while this file was
    // being written, and each cost a round trip to identify.
    async () =>
      [
        'a finished round',
        `  deliveries: ${await deliveryDigest()}`,
        `  work items: ${await workItemDigest()}`,
        `  task: ${await taskDigest()}`,
      ].join('\n'),
  )
  expect(item.capability).toBe('mr-review')
})

test('the round ends PUBLISHED, with every stage of the contract done', async () => {
  // Two things at once, and both were broken until this file ran them:
  //
  //   * `outcome` — nothing in production ever wrote a round's terminal state,
  //     so a round whose thirteen stages had all finished still read `running`.
  //     Every reader was already built for the vocabulary: `deriveRoundStatus`,
  //     the metrics buckets, the lifetime GC. Only the writer was missing.
  //   * the SEQUENCE — asserted whole rather than spot-checked, because the two
  //     wiring bugs this file found each stopped the pipeline at a different
  //     stage while everything before it looked perfectly healthy.
  const round = (await currentRound())!
  expect(round).toBeDefined()
  // `status` is DERIVED from the outcome rather than stored, so the two agree
  // by construction — asserting both is what pins that they still do.
  expect({ outcome: round.outcome, status: round.status }).toEqual({
    outcome: 'published',
    status: 'published',
  })

  const failed = round.stages.filter((stage) => stage.status !== 'done')
  expect(failed).toEqual([])
  // Both AI stages ran. A pipeline that skipped them would still publish — an
  // empty review is a valid review — so their presence is the assertion.
  expect(round.stages.map((stage) => stage.stageName)).toEqual([
    'resolve-target',
    'prepare-worktree',
    'fetch-diff',
    'split-diff',
    'review-shard',
    'review-global',
    'validate-findings',
    'gate',
    'resolve-positions',
    'reconcile',
    'publish',
    'settle-stale',
    'ledger',
  ])
})

test('AC-1 — the finding reaches the merge request as a LINE comment, published ONCE', async () => {
  // The acceptance criterion the whole RFC is for, and the reason the model is
  // stubbed: the finding asserted here is the one the stand-in returned, so a
  // failure means the platform lost or mangled it rather than that a model said
  // something different today.
  const requests = await mocks.requests('gitlab')
  const drafts = requests.filter(
    (request) => request.method === 'POST' && request.path.endsWith('/draft_notes'),
  )
  expect(drafts.length).toBeGreaterThan(0)

  const bodies = drafts.map((request) => request.bodyText).join('\n')
  expect(bodies).toContain(STUB_FINDING.title)
  // Line-level, not a comment on the merge request as a whole: `position` is
  // what makes it land on the line, and posting without one is the degraded
  // mode this capability exists to avoid.
  expect(bodies).toContain('position')
  expect(bodies).toContain(STUB_FINDING.file)

  // B10, and NOT incidental: drafts then ONE `bulk_publish` is what makes a
  // review of twelve findings arrive as a single notification. The design
  // explicitly refuses per-comment posting as a fallback (§10-1), so a run that
  // posted each finding separately must fail here rather than look equivalent.
  const bulk = requests.filter((request) => request.path.endsWith('/draft_notes/bulk_publish'))
  expect(bulk).toHaveLength(1)
})

test('no stage fails with "no runner registered" — the shape the audit found', async () => {
  // Stated as its own case because it is the REGRESSION, not the feature. A
  // capability can legitimately fail for a dozen reasons; failing because
  // nothing was ever wired to it is the one that means somebody shipped half a
  // join. Asserted across every stage of every round, so a future capability
  // added without wiring fails here rather than in production.
  const page = await requestJson<{
    items: Array<{
      capability: string
      rounds: Array<{ stages: Array<{ stageName: string; status: string; error: string | null }> }>
    }>
  }>('/api/code/work-items')

  const unwired: string[] = []
  for (const item of page.items) {
    for (const round of item.rounds) {
      for (const stage of round.stages) {
        if ((stage.error ?? '').includes('no runner registered')) {
          unwired.push(`${item.capability}/${stage.stageName}`)
        }
      }
    }
  }
  expect(unwired).toEqual([])
})

test('the metrics endpoint answers in buckets rather than inventing a rate', async () => {
  // T58. The shape matters: an "adoption rate" computed over repositories the
  // reader cannot enumerate is a number nobody can act on, so the query returns
  // buckets and the UI names them.
  const metrics = await requestJson<Record<string, unknown>>('/api/code/metrics')
  expect(metrics).toBeDefined()
  expect(JSON.stringify(metrics)).not.toContain('adoptionRate')
})

// ---------------------------------------------------------------------------

interface RoundView {
  status: string
  outcome: string | null
  endedAt: number | null
  stages: Array<{ stageName: string; status: string; error: string | null }>
}

/** The newest round of the `mr-review` work item, or null if there is none. */
async function currentRound(): Promise<RoundView | null> {
  const page = await requestJson<{ items: Array<{ rounds: RoundView[] }> }>(
    '/api/code/work-items?capability=mr-review',
  )
  return page.items[0]?.rounds[0] ?? null
}

interface MatrixRow {
  capability: string
  enabled: boolean
  readiness: string
  issues: unknown[]
  repairActions: unknown[]
  bindingId: string | null
}

async function matrixRow(capability = 'mr-review'): Promise<MatrixRow> {
  const matrix = await requestJson<{ rows: MatrixRow[] }>(`/api/code/matrix/${repoId}`)
  const row = matrix.rows.find((r) => r.capability === capability)
  if (row === undefined) throw new Error(`the matrix has no '${capability}' row`)
  return row
}

async function importRepo(url: string): Promise<string> {
  const batch = await requestJson<{ batchId: string }>('/api/cached-repos/batch-import', {
    method: 'POST',
    body: { urls: [url] },
  })
  return await waitFor(async () => {
    const snapshot = await requestJson<{
      rows: Array<{ status: string; cachedRepoId: string | null }>
    }>(`/api/cached-repos/imports/${batch.batchId}`)
    const row = snapshot.rows[0]
    return row?.cachedRepoId ?? null
  }, `the mirror of ${url} to finish cloning`)
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

/** What the daemon recorded for every delivery — the only account of WHY. */
async function deliveryDigest(): Promise<string> {
  try {
    const page = await requestJson<{
      items: Array<{ id: string; status: string; eventType?: string; error?: string | null }>
    }>('/api/webhook-deliveries?limit=20')
    return JSON.stringify(
      page.items.map((row) => ({
        status: row.status,
        event: row.eventType,
        error: row.error ?? null,
      })),
    )
  } catch (error) {
    return `could not be read: ${String(error)}`
  }
}

/** How far the round actually got — the only account of a stall. */
async function workItemDigest(): Promise<string> {
  try {
    const page = await requestJson<{ items: unknown[] }>('/api/code/work-items')
    return JSON.stringify(page.items)
  } catch (error) {
    return `could not be read: ${String(error)}`
  }
}

/** Which repository the round's task was actually given. */
async function taskDigest(): Promise<string> {
  try {
    const rows = await requestJson<Array<{ id: string }>>('/api/tasks?limit=5')
    const first = rows[0]
    if (first === undefined) return 'no tasks'
    const detail = await requestJson<Record<string, unknown>>(`/api/tasks/${first.id}`)
    return JSON.stringify({ repos: detail['repos'], spaceKind: detail['spaceKind'] }).slice(0, 1200)
  } catch (error) {
    return `could not be read: ${String(error)}`
  }
}

async function rawRequest(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${daemon.token}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  return { status: response.status, text: await response.text() }
}

async function requestJson<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { status, text } = await rawRequest(path, options)
  if (status < 200 || status >= 300) {
    throw new Error(`${options.method ?? 'GET'} ${path} returned ${status}: ${text}`)
  }
  return (text.length === 0 ? null : JSON.parse(text)) as T
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}
