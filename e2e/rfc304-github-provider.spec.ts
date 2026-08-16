// RFC-304 — the GitHub leg, end to end.
//
// The capability platform had ZERO GitHub end-to-end coverage: the existing
// suite drives GitLab seven times and GitHub not once. That matters more here
// than "one more provider" usually does, because the two publish paths are
// genuinely different shapes rather than one path with different URLs
// (`shared/codeHost/actions.ts` §7.2):
//
//   GitLab — N× draft note, then one `bulk_publish`. There is a window where
//            drafts exist unpublished, so a failure must compensate by deleting
//            them or the merge request keeps a batch of orphan drafts.
//   GitHub — ONE `POST /pulls/{n}/reviews` carrying `comments[]`. Either the
//            whole review lands or nothing does; the window does not exist.
//
// A suite that only drives GitLab therefore proves nothing about the branch
// that actually runs for GitHub users — not the position mapping, not the
// review submission, not the `commit_id` pin.
//
// That pin is the assertion worth having. GitHub defaults `commit_id` to the
// pull request's most recent commit, so an author who pushes while the review
// is running would get remarks attached to a revision the reviewer never read —
// line numbers computed against A, code showing B. RFC-304 threads the baseline
// sha all the way here to close that, and this is the only test that watches it
// arrive.

import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SYSTEM_MOCK_CODE_HOST_TOKEN, SystemMockClient } from '@agent-workflow/system-mocks'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })

const PROJECT_PATH = 'system-e2e/rfc304-github'
const REVIEWER_AGENT = 'e2e-github-reviewer'

const STUB_FINDING = {
  file: 'src/app.ts',
  line: 2,
  side: 'new' as const,
  severity: 'major' as const,
  title: 'e2e github finding',
  body: 'This is what the GitHub review submission must carry.',
}

let daemon: DaemonHandle
let mocks: SystemMockClient
let endpoint: { urlToken: string; secret: string }
let project: { projectId: string; repoHttpUrl: string; number: number; headSha: string }
let repoId = ''

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

  const stateDir = mkdtempSync(join(tmpdir(), 'rfc304-gh-'))
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

  await requestJson('/api/code-hosts/github', {
    method: 'PUT',
    body: {
      baseUrl: requiredEnv('AW_SYSTEM_MOCK_GITHUB_API_BASE_URL'),
      token: SYSTEM_MOCK_CODE_HOST_TOKEN,
    },
  })

  project = await mocks.seedCodeHost({
    provider: 'github',
    projectPath: PROJECT_PATH,
    baseFiles: { 'src/app.ts': 'export const start = () => {}\n' },
    headFiles: { 'src/app.ts': 'export const start = () => {}\nexport const stop = () => {}\n' },
  })

  const agent = await requestJson<{ id: string }>('/api/agents', {
    method: 'POST',
    body: {
      name: REVIEWER_AGENT,
      description: 'RFC-304 GitHub e2e reviewer',
      outputs: ['findings'],
      readonly: true,
      bodyMd: 'Review the diff.',
    },
  })

  endpoint = await requestJson('/api/webhook-endpoints', {
    method: 'POST',
    body: { name: 'RFC-304 github', provider: 'github' },
  })

  repoId = await importRepo(project.repoHttpUrl)

  const framework = await requestJson<{ id: string }>('/api/capability-frameworks', {
    method: 'POST',
    body: {
      name: 'gh review framework',
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
      name: 'gh review binding',
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

test('a GitHub pull request runs the review to completion', async () => {
  const cell = await matrixRow('mr-review')
  expect({ readiness: cell.readiness, issues: cell.issues }).toEqual({
    readiness: 'ready',
    issues: [],
  })

  const delivered = await mocks.deliverWebhook({
    provider: 'github',
    callbackUrl: `${daemon.baseUrl}/webhooks/github/${endpoint.urlToken}`,
    secret: endpoint.secret,
    projectPath: PROJECT_PATH,
    number: project.number,
    event: 'mr_opened',
  })
  expect(delivered.status).toBe(200)

  const round = await waitFor(async () => {
    const page = await requestJson<{
      items: Array<{ rounds: Array<{ outcome: string | null; endedAt: number | null }> }>
    }>('/api/code/work-items?capability=mr-review')
    const first = page.items[0]?.rounds[0]
    return first !== undefined && first.endedAt !== null ? first : null
  }, 'a finished GitHub round')

  expect(round.outcome).toBe('published')
})

test('the review is submitted as ONE reviews call, not a stream of comments', async () => {
  // The GitHub shape. Posting each finding as its own comment would notify the
  // author once per remark — the behaviour B10 exists to prevent — and would
  // lose the all-or-nothing property that makes the GitHub path safe without
  // compensation logic.
  const requests = mine(await mocks.requests('github'))
  const reviews = requests.filter(
    (r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.path),
  )
  expect(reviews).toHaveLength(1)

  const body = JSON.parse(reviews[0]!.bodyText) as {
    comments?: Array<{ path?: string; body?: string }>
    commit_id?: string
  }
  expect(body.comments?.length).toBeGreaterThan(0)
  expect(JSON.stringify(body.comments)).toContain(STUB_FINDING.title)
  expect(JSON.stringify(body.comments)).toContain(STUB_FINDING.file)
})

test('the review pins commit_id to the revision it actually read', async () => {
  // The last link in the baseline chain. GitHub defaults `commit_id` to the
  // PR's newest commit, so leaving it out means an author who pushes mid-review
  // receives remarks anchored to code the reviewer never saw — line numbers
  // from A against contents of B, which reads as the bot being wrong rather
  // than the bot being late.
  const requests = mine(await mocks.requests('github'))
  const review = requests.find((r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.path))
  const body = JSON.parse(review!.bodyText) as { commit_id?: string }

  expect(body.commit_id, 'commit_id must be pinned, not defaulted').toBeTruthy()
  expect(body.commit_id).toBe(project.headSha)
})

test('GitLab-only draft endpoints are NEVER called for a GitHub pull request', async () => {
  // The asymmetry, asserted from the other side. `review.submit` is marked
  // `unsupported` for GitLab and the draft pair is absent for GitHub; a mapping
  // that silently fell back to the other provider's shape would still "publish"
  // and would be wrong in a way no single-provider suite could see.
  const requests = mine(await mocks.requests('github'))
  expect(requests.filter((r) => r.path.includes('draft_notes'))).toEqual([])
})

// ---------------------------------------------------------------------------

interface MatrixRow {
  capability: string
  readiness: string
  issues: unknown[]
}

async function matrixRow(capability: string): Promise<MatrixRow> {
  const matrix = await requestJson<{ rows: MatrixRow[] }>(`/api/code/matrix/${repoId}`)
  const row = matrix.rows.find((r) => r.capability === capability)
  if (row === undefined) throw new Error(`no '${capability}' row`)
  return row
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

async function waitFor<T>(probe: () => Promise<T | null>, what: string): Promise<T> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const seen = await probe()
    if (seen !== null) return seen
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${what}`)
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
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}
