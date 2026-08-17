// RFC-304 §6.1 — what the author sees across TWO rounds on one merge request.
//
// A review capability that only knows how to post is unusable on a real merge
// request: the author pushes a fix, the machine reviews again, and every remark
// it made last time appears a second time. The design answers that with a
// three-set reconcile — findings that are still there are LEFT ALONE, findings
// that have gone are CLOSED OUT, and only genuinely new ones are posted — and
// the reconcile is the part with no observable behaviour of its own. It is
// invisible until a second round runs, and until this file nothing ran one.
//
// The other two properties pinned here are the ones a single-round suite cannot
// see either:
//
//   * POSITION — a finding is a line comment, and lands on the line and file it
//     names. A remark attached to the wrong line reads as the bot being wrong
//     about the code.
//   * SHARDING — `mr-review` splits the diff and reviews the parts separately.
//     Two shards reporting the same finding must reach the merge request once;
//     the author cannot tell "the platform sharded" from "the bot repeated
//     itself", and should not have to.

import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SYSTEM_MOCK_CODE_HOST_TOKEN, SystemMockClient } from '@agent-workflow/system-mocks'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })

const PROJECT_PATH = 'system-e2e/rfc304-reconcile'
const REVIEWER_AGENT = 'e2e-reconcile-reviewer'

/** Two findings, in two different files, so the diff really shards. */
const FINDING_A = {
  file: 'src/a.ts',
  line: 2,
  severity: 'major',
  title: 'unchecked index on the fast path',
  body: 'This can be undefined when the list is empty.',
}
const FINDING_B = {
  file: 'src/b.ts',
  line: 2,
  severity: 'major',
  title: 'retry loop drops the last attempt',
  body: 'The bound is exclusive, so the final attempt never runs.',
}
/** Reported only in the second round. */
const FINDING_C = {
  file: 'src/a.ts',
  line: 3,
  severity: 'minor',
  title: 'error is swallowed',
  body: 'The catch discards the cause, so the log says nothing useful.',
}

let daemon: DaemonHandle
let mocks: SystemMockClient
let endpoint: { urlToken: string; secret: string }
let project: { projectId: string; repoHttpUrl: string; number: number }
let planFile = ''

test.beforeAll(async () => {
  mocks = new SystemMockClient(
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_URL'),
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_TOKEN'),
  )
  // NOT `mocks.reset()` — see `mine()` below.

  const stateDir = mkdtempSync(join(tmpdir(), 'rfc304-reconcile-'))
  planFile = join(stateDir, 'plan.json')
  writePlan([FINDING_A, FINDING_B])

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
    baseFiles: {
      'src/a.ts': 'export const start = () => {}\n',
      'src/b.ts': 'export const retry = () => {}\n',
    },
    // Both files change, so the diff has two parts to shard.
    headFiles: {
      // Three lines, so the finding the second round reports on line 3 has a
      // line to land on. A finding whose line is not in the diff is correctly
      // carried in the overview instead of placed — which is what this fixture
      // got wrong first, and the platform did the right thing with it.
      'src/a.ts':
        'export const start = () => {}\nexport const first = (xs: number[]) => xs[0]\nexport const safe = () => undefined\n',
      'src/b.ts': 'export const retry = () => {}\nexport const attempts = 3\n',
    },
  })

  const agent = await requestJson<{ id: string }>('/api/agents', {
    method: 'POST',
    body: {
      name: REVIEWER_AGENT,
      description: 'RFC-304 reconcile e2e reviewer',
      outputs: ['findings'],
      readonly: true,
      bodyMd: 'Review the diff.',
    },
  })

  endpoint = await requestJson('/api/webhook-endpoints', {
    method: 'POST',
    body: { name: 'RFC-304 reconcile', provider: 'gitlab' },
  })

  const repoId = await importRepo(project.repoHttpUrl)

  const template = await requestJson<{ id: string }>('/api/capability-templates', {
    method: 'POST',
    body: {
      name: 'reconcile framework',
      capability: 'mr-review',
      scripts: {},
      hooks: [],
      paramSchema: [],
      paramDefaults: {},
      agentBySlot: { reviewer: agent.id },
      promptBySlot: {},
      params: {},
    },
  })
  await requestJson(`/api/code/matrix/${repoId}`, {
    method: 'PUT',
    body: { capability: 'mr-review', enabled: true, templateId: template.id },
  })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('the first round posts one line comment per finding, on the right lines', async () => {
  await push()
  await waitForFinishedRounds(1)

  const drafts = await draftNotes()
  // TWO, not four: the diff shards, both shards answer with the same scripted
  // findings, and the author must not be told the same thing twice because the
  // platform chose to split the work.
  expect(
    drafts.length,
    `one comment per finding; bodies: ${drafts.map((d) => d.bodyText).join(' | ')}`,
  ).toBe(2)

  // Line-level, and on the line the finding named — a remark that lands on the
  // wrong line reads as the bot being wrong about the code.
  const placed = drafts.map((d) => JSON.parse(d.bodyText) as DraftBody)
  for (const finding of [FINDING_A, FINDING_B]) {
    const match = placed.find((p) => p.position?.new_path === finding.file)
    expect(match, `no comment placed on ${finding.file}`).toBeDefined()
    expect(match?.position?.new_line).toBe(finding.line)
    expect(textOf(match ?? {})).toContain(finding.title)
  }

  // Published in ONE batch — the design's "drafts, then a single publish".
  expect((await publishes()).length).toBe(1)
})

test('a SECOND round leaves the standing finding alone and posts only the new one', async () => {
  // The reconcile, from the author's side: they pushed a fix for one of the two
  // remarks, and what they should see is the new remark and the old one closed
  // — not a second copy of everything the machine already said.
  const before = (await draftNotes()).length
  writePlan([FINDING_A, FINDING_C])
  await push()
  await waitForFinishedRounds(2)

  const added = (await draftNotes()).slice(before)
  const bodies = added.map((d) => textOf(JSON.parse(d.bodyText) as DraftBody)).join('\n')

  const trail = JSON.stringify(
    mine(await mocks.requests('gitlab'))
      .slice(-14)
      .map((r) => `${r.method} ${r.path}`),
  ).slice(0, 700)
  expect(bodies || `NO NEW DRAFTS; recent: ${trail}`, 'the new finding must be posted').toContain(
    FINDING_C.title,
  )
  // The one that is still there was NOT posted again.
  expect(bodies, 'a standing finding must not be repeated').not.toContain(FINDING_A.title)
  expect(added.length, `only the new finding; got: ${bodies}`).toBe(1)
})

test('the finding that went away is CLOSED OUT rather than left hanging', async () => {
  // Silence here is the failure mode: a remark the machine no longer stands
  // behind, left open on the merge request, is one the author has to decide
  // about with no information. On GitLab the discussion is resolved.
  const requests = mine(await mocks.requests('gitlab'))
  const settled = requests.filter(
    (r) =>
      /\/discussions\//.test(r.path) &&
      (r.method === 'PUT' || r.method === 'POST') &&
      (r.bodyText.includes('"resolved":true') || r.bodyText.includes('no longer appears')),
  )
  expect(
    settled.length,
    `the stale finding must be settled; saw: ${JSON.stringify(
      requests.slice(-12).map((r) => `${r.method} ${r.path} ${r.bodyText.slice(0, 60)}`),
    ).slice(0, 1200)}`,
  ).toBe(1)
})

test('the overview comment is EDITED, not posted a second time', async () => {
  // The third set, from the author's side. One round posts an overview; the
  // next has to update THAT comment rather than add another, or a long-lived
  // merge request accumulates one summary per push and the newest is buried.
  const requests = mine(await mocks.requests('gitlab'))
  const posted = requests.filter((r) => r.method === 'POST' && r.path.endsWith('/notes'))
  const edited = requests.filter((r) => r.method === 'PUT' && /\/notes\/\d+$/.test(r.path))

  expect(posted.length, 'exactly one overview comment ever created').toBe(1)
  expect(edited.length, "the second round must edit the first round's overview").toBeGreaterThan(0)
  // And it says what changed, rather than restating the whole review.
  expect(edited.at(-1)?.bodyText).toContain('still open')
})

// ---------------------------------------------------------------------------

interface DraftBody {
  /** GitLab's draft note calls the text `note`; kept permissive for GitHub. */
  note?: string
  body?: string
  position?: { new_path?: string; new_line?: number; old_path?: string }
}

/** The comment text, whichever field this provider puts it in. */
const textOf = (draft: DraftBody): string => draft.note ?? draft.body ?? ''

function writePlan(findings: unknown[]): void {
  writeFileSync(
    planFile,
    JSON.stringify({
      version: 1,
      agents: {
        [REVIEWER_AGENT]: [{ output: { findings: JSON.stringify({ findings }) } }],
      },
    }),
  )
}

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

async function waitForFinishedRounds(count: number): Promise<void> {
  await waitFor(
    async () => {
      const page = await requestJson<{
        items: Array<{ status: string; rounds: Array<{ endedAt: number | null }> }>
      }>('/api/code/work-items?capability=mr-review')
      const rounds = page.items[0]?.rounds ?? []
      const finished = rounds.filter((r) => r.endedAt !== null)
      return finished.length >= count && rounds.every((r) => r.endedAt !== null) ? true : null
    },
    async () => `${String(count)} finished round(s); items: ${await itemsDigest()}`,
  )
}

async function draftNotes(): Promise<Array<{ bodyText: string }>> {
  return mine(await mocks.requests('gitlab')).filter(
    (r) => r.method === 'POST' && r.path.endsWith('/draft_notes'),
  )
}

async function publishes(): Promise<Array<{ path: string }>> {
  return mine(await mocks.requests('gitlab')).filter(
    (r) => r.method === 'POST' && r.path.includes('bulk_publish'),
  )
}

/**
 * Only this spec's traffic.
 *
 * One system-mock suite serves every Playwright worker (`e2e/global-setup.ts`)
 * and CI runs four workers per shard, so the request log carries whatever else
 * is running. Scoping by the project this spec seeded is what makes a COUNT
 * ("posted exactly once") mean anything at all.
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

async function itemsDigest(): Promise<string> {
  try {
    return JSON.stringify(
      (await requestJson<{ items: unknown[] }>('/api/code/work-items')).items,
    ).slice(0, 700)
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

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}
