// RFC-304 §2.2 不变量一 — three pushes in a row leave ONE round.
//
// The transition table has always said what preemption means: a new event on a
// RUNNING work item does not open a round. It moves the item to `superseding`,
// bumps the epoch, asks for the running round to be cancelled, and starts the
// replacement only once that round's task is genuinely terminal. The design
// spells out why the wait exists — a round in the middle of publishing races
// the cancel, and starting the replacement immediately gives one merge request
// two live rounds writing the same worktree.
//
// None of it was performed. No caller cancelled anything, nothing emitted
// `round-task-terminal`, and `start-round` appeared in no code path outside the
// table that produces it — so the wake path opened a round for every delivery
// regardless. Three pushes produced three concurrent rounds, each reviewing a
// revision the next had already replaced, each posting its own comments on the
// merge request. `hasLiveRound` was passed a literal `false`, so the table was
// never even asked the question it exists to answer.
//
// What this file pins is the observable promise, not the mechanism: however
// many events arrive while a round is running, the author sees the work of the
// LAST one, once.

import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SYSTEM_MOCK_CODE_HOST_TOKEN, SystemMockClient } from '@agent-workflow/system-mocks'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })

const PROJECT_PATH = 'system-e2e/rfc304-supersede'
const REVIEWER_AGENT = 'e2e-supersede-reviewer'

/**
 * Long enough that a round is unmistakably still running when the next two
 * events land, short enough that the whole file stays quick. `mr-review` calls
 * the model twice (per-shard, then global), so a round takes at least twice
 * this.
 */
const MODEL_DELAY_MS = 2_000

let daemon: DaemonHandle
let mocks: SystemMockClient
let endpoint: { urlToken: string; secret: string }
let project: { projectId: string; repoHttpUrl: string; number: number }

interface RoundView {
  roundId: string
  roundSeq: number
  outcome: string | null
  endedAt: number | null
  epoch?: number
}
interface ItemView {
  workItemId: string
  status: string
  epoch: number
  rounds: RoundView[]
}

test.beforeAll(async () => {
  mocks = new SystemMockClient(
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_URL'),
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_TOKEN'),
  )
  // NOT `mocks.reset()`: one system-mock suite serves every Playwright worker
  // (see `e2e/global-setup.ts`) and CI runs four workers per shard, so a global
  // wipe deletes the projects of whichever specs happen to be running beside
  // this one. That is not hypothetical — it turned up as
  // `unknown gitlab project system-e2e/rfc304-confirm` mid-run, from a spec
  // that had seeded that project seconds earlier. Isolation comes from a unique
  // project path per spec and from scoping request assertions to it.

  const stateDir = mkdtempSync(join(tmpdir(), 'rfc304-supersede-'))
  const planFile = join(stateDir, 'plan.json')
  writeFileSync(
    planFile,
    JSON.stringify({
      version: 1,
      agents: {
        [REVIEWER_AGENT]: [
          {
            delayMs: MODEL_DELAY_MS,
            output: {
              findings: JSON.stringify({
                findings: [
                  {
                    file: 'src/app.ts',
                    line: 2,
                    severity: 'major',
                    title: 'unchecked value',
                    body: 'This can be undefined when the list is empty.',
                  },
                ],
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
      name: REVIEWER_AGENT,
      description: 'RFC-304 supersede e2e reviewer',
      outputs: ['findings'],
      readonly: true,
      bodyMd: 'Review the diff.',
    },
  })

  endpoint = await requestJson('/api/webhook-endpoints', {
    method: 'POST',
    body: { name: 'RFC-304 supersede', provider: 'gitlab' },
  })

  const repoId = await importRepo(project.repoHttpUrl)

  const framework = await requestJson<{ id: string }>('/api/capability-frameworks', {
    method: 'POST',
    body: {
      name: 'supersede framework',
      capability: 'mr-review',
      scripts: {},
      hooks: [],
      paramSchema: [],
      paramDefaults: {},
    },
  })
  const binding = await requestJson<{ id: string }>('/api/capability-bindings', {
    method: 'POST',
    body: {
      name: 'supersede binding',
      frameworkId: framework.id,
      agentBySlot: { reviewer: agent.id },
      promptBySlot: {},
      params: {},
    },
  })
  await requestJson(`/api/code/matrix/${repoId}`, {
    method: 'PUT',
    body: { capability: 'mr-review', enabled: true, bindingId: binding.id },
  })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('a second push while a round runs PREEMPTS it rather than racing it', async () => {
  await push()
  const first = await waitFor(
    async () => {
      const item = await readItem()
      return item?.status === 'running' ? item : null
    },
    async () => `a running round; items: ${await itemsDigest()}`,
  )
  expect(first.rounds.length).toBe(1)
  const firstRoundId = first.rounds[0]!.roundId

  await push()

  // The item goes to `superseding` and the epoch moves. Both matter: the state
  // is what stops a second round starting beside the first, and the epoch is
  // what every stale-output check compares against.
  const preempted = await waitFor(
    async () => {
      const item = await readItem()
      return item !== null && item.epoch > first.epoch ? item : null
    },
    async () => `an epoch bump after the second push; items: ${await itemsDigest()}`,
  )
  expect(preempted.epoch).toBeGreaterThan(first.epoch)

  // And no second round was opened yet — that is the invariant. Before the
  // preemption effects were performed, this is exactly where a second round
  // appeared and started reviewing the same merge request in parallel.
  expect(
    preempted.rounds.filter((r) => r.endedAt === null && r.roundId !== firstRoundId).length,
    `no round may start beside the one being preempted; rounds: ${JSON.stringify(preempted.rounds)}`,
  ).toBe(0)
})

test('a burst of pushes never produces two rounds at once', async () => {
  // Design §2.2 不变量一, stated as the thing that is ALWAYS true rather than as
  // a count: however the timing falls, at most one round of a work item is live
  // at any moment.
  //
  // Two pushes back to back, deliberately without waiting between them, so at
  // least one of them lands while the item is already being preempted — the arm
  // of the table that merges into the registered revision instead of queueing a
  // round of its own.
  //
  // What is NOT asserted here is a round COUNT. A push arriving after the
  // replacement has started legitimately preempts THAT one in turn, so three
  // pushes can mean three rounds; what must never happen is two of them running
  // together, and that the author ends up with the last one's work — which the
  // next two tests pin.
  await push()
  await push()

  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    const item = await readItem()
    const live = (item?.rounds ?? []).filter((r) => r.endedAt === null)
    expect(
      live.length,
      `two rounds live at once; rounds: ${JSON.stringify(item?.rounds)}`,
    ).toBeLessThanOrEqual(1)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  // And no round was invented: at most one per delivery so far.
  const settled = await readItem()
  expect((settled?.rounds ?? []).length).toBeLessThanOrEqual(4)
})

test('the replacement round starts once the preempted one is really gone, and finishes', async () => {
  // The half that never existed: `start-round` had no performer, so an item
  // that reached `superseding` stayed there — the merge request simply stopped
  // being reviewed, with no error anywhere.
  const settled = await waitFor(
    async () => {
      const item = await readItem()
      if (item === null) return null
      const finished = item.rounds.filter((r) => r.endedAt !== null)
      return finished.length >= 2 && item.rounds.every((r) => r.endedAt !== null) ? item : null
    },
    async () => `a replacement round that finished; items: ${await itemsDigest()}`,
  )

  // Exactly one round did the work. The others were preempted before they
  // could publish.
  const published = settled.rounds.filter((r) => r.outcome === 'published')
  expect(
    published.length,
    `exactly one round may publish; rounds: ${JSON.stringify(settled.rounds)}`,
  ).toBe(1)

  // And it is the LAST one — the author sees the review of the revision they
  // pushed most recently, not of the one they had already replaced.
  const last = [...settled.rounds].sort((a, b) => a.roundSeq - b.roundSeq).at(-1)
  expect(published[0]!.roundId).toBe(last!.roundId)
})

test('the merge request received ONE review, not one per push', async () => {
  // The observable promise. Three pushes used to mean three reviews on the same
  // merge request, each from a round that was already stale when it posted.
  const publishes = mine(await mocks.requests('gitlab')).filter(
    (r) => r.method === 'POST' && /bulk_publish|\/discussions/.test(r.path),
  )
  expect(
    publishes.length,
    `one publish for three pushes; saw: ${JSON.stringify(publishes.map((r) => r.path))}`,
  ).toBeLessThanOrEqual(1)
})

// ---------------------------------------------------------------------------

async function push(): Promise<void> {
  const delivered = await mocks.deliverWebhook({
    provider: 'gitlab',
    callbackUrl: `${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`,
    secret: endpoint.secret,
    projectPath: PROJECT_PATH,
    number: project.number,
    event: 'mr_updated',
  })
  expect(delivered.status).toBe(200)
}

async function readItem(): Promise<ItemView | null> {
  const page = await requestJson<{ items: ItemView[] }>('/api/code/work-items?capability=mr-review')
  return page.items[0] ?? null
}

async function itemsDigest(): Promise<string> {
  try {
    const tasks =
      await requestJson<Array<{ id: string; status: string; name: string }>>('/api/tasks')
    const rounds = JSON.stringify(
      (await requestJson<{ items: unknown[] }>('/api/code/work-items')).items,
    ).slice(0, 600)
    const details = await Promise.all(
      (Array.isArray(tasks) ? tasks : []).slice(0, 4).map(async (t) => {
        const detail = await requestJson<Record<string, unknown>>(`/api/tasks/${t.id}`).catch(
          () => ({}) as Record<string, unknown>,
        )
        const runs = await requestJson<unknown>(`/api/tasks/${t.id}/node-runs`).catch(() => [])
        return `${t.id.slice(-6)}:${t.status}:err=${String(detail.errorMessage ?? detail.error ?? '')}:runs=${JSON.stringify(runs).slice(0, 200)}`
      }),
    )
    return `${rounds} | details: ${JSON.stringify(details)} | tasks: ${JSON.stringify(
      (Array.isArray(tasks) ? tasks : []).map(
        (t) =>
          `${t.id.slice(-6)}:${t.status}:${String(
            (t as { errorMessage?: string | null }).errorMessage ?? '',
          ).slice(0, 120)}`,
      ),
    )}`
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
    throw new Error(`${options.method ?? 'GET'} ${path} → ${String(response.status)}: ${text}`)
  }
  return text === '' ? (undefined as T) : (JSON.parse(text) as T)
}

/**
 * Only this spec's traffic.
 *
 * One system-mock suite serves every Playwright worker (`e2e/global-setup.ts`)
 * and CI runs four workers per shard, so the request log carries whatever else
 * is running. Scoping by the project this spec seeded is what makes a COUNT
 * ("published exactly once") mean anything at all — and it replaces the global
 * `mocks.reset()` these specs used to call, which deleted the projects of the
 * specs running beside them.
 *
 * Three spellings of the same project, because each surface names it
 * differently: GitLab's REST paths carry the numeric id, GitHub's carry
 * `owner/repo`, and the git remote carries the directory slug.
 */
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

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}
