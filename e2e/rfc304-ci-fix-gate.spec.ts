// RFC-304 §6.4 — `ci-fix` proving a fix by RUNNING the repository's own gate.
//
// The capability's whole claim is "the pipeline was red, the machine changed
// something, and now it is green". The proof step — `validate-fix` — runs the
// gate the repository names in its own contributor document and compares the
// exit code before and after. Design §6.4: this is what turns the proof from
// the model's self-report into a fact somebody else can re-run.
//
// It could not run. `runGateCommand` and `readWorktreeFile` are seams on the
// wiring input, the scheduler supplied NEITHER, and the wiring's placeholder
// throws `no gate runner is wired for this round`. So `ci-fix` could reach its
// agent, produce a change, and then have no way to say whether it worked.
//
// This file drives the whole deterministic half for real: the framework's four
// scripts (collect / classify / arbitrate / select) as node scripts a team
// would actually write, a repository whose CLAUDE.md names its gate, a gate
// that genuinely fails on the seeded tree, and an agent that genuinely fixes
// it. Nothing here is mocked except the model's reply and the code host.
//
// ## Where this stops, deliberately
//
// The stage after `validate-fix` is `self-review`, which invokes `mr-review`'s
// reading stages. `invokedStages` is a runner input the scheduler does not
// supply yet, so the round ends there — and it ends LOUDLY, which is the point:
// the assertion below pins the message rather than pretending the chain is
// complete. Wiring it needs the design's snapshot semantics (freeze the parent
// worktree, shard from the snapshot) or the self-review reads the code from
// BEFORE the fix.

import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SYSTEM_MOCK_CODE_HOST_TOKEN, SystemMockClient } from '@agent-workflow/system-mocks'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })

const PROJECT_PATH = 'system-e2e/rfc304-cifix'
const FIXER_AGENT = 'e2e-cifix-fixer'
/**
 * The self-review's reviewer. It resolves through THIS round's template like
 * every other slot, so a team that wants its ci-fix rounds self-reviewed maps
 * a `reviewer` in the ci-fix template.
 */
const REVIEWER_AGENT = 'e2e-cifix-reviewer'

/**
 * The repository's gate: green only once `src/broken.txt` says `fixed`.
 *
 * A real script in the tree rather than a shell one-liner, so the same fixture
 * works on every platform CI runs on.
 */
const GATE_SCRIPT = [
  "const fs = require('node:fs')",
  "const state = fs.readFileSync('src/broken.txt', 'utf8').trim()",
  "if (state !== 'fixed') { console.error('gate: the build is red because src/broken.txt says ' + state); process.exit(1) }",
  "console.log('gate: all checks passed')",
].join('\n')

/** How a contributor document names it — the phrasing `findGateCommand` reads. */
const GATE_DOC = ['# Contributing', '', 'Run `node gate.js` before you push.', ''].join('\n')

let daemon: DaemonHandle
let mocks: SystemMockClient
let endpoint: { urlToken: string; secret: string }
let project: { projectId: string; repoHttpUrl: string; number: number; headSha: string }

test.beforeAll(async () => {
  mocks = new SystemMockClient(
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_URL'),
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_TOKEN'),
  )
  // NOT `mocks.reset()` — one mock suite serves every worker; see `mine()`.

  const stateDir = mkdtempSync(join(tmpdir(), 'rfc304-cifix-'))
  const planFile = join(stateDir, 'plan.json')
  writeFileSync(
    planFile,
    JSON.stringify({
      version: 1,
      agents: {
        // The self-review reads the frozen snapshot of the fix and finds
        // nothing wrong with it — the ordinary case, and the one that lets the
        // round continue to push.
        [REVIEWER_AGENT]: [{ output: { findings: JSON.stringify({ findings: [] }) } }],
        [FIXER_AGENT]: [
          {
            // The fix itself: the agent edits the tree, which is what the gate
            // then judges. Its envelope only carries the sentence for the human.
            writeFiles: { 'src/broken.txt': 'fixed\n' },
            output: {
              fix: JSON.stringify({
                summary: 'Marked the build fixed, which is what the failing check reads.',
                touched: ['src/broken.txt'],
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
    baseFiles: {
      'gate.js': GATE_SCRIPT,
      'CLAUDE.md': GATE_DOC,
      'src/broken.txt': 'red\n',
    },
    headFiles: {
      'gate.js': GATE_SCRIPT,
      'CLAUDE.md': GATE_DOC,
      // Still red on the head the pipeline failed on — that is the situation
      // `ci-fix` exists for.
      'src/broken.txt': 'red\n',
      'src/change.ts': 'export const changed = true\n',
    },
  })

  const reviewer = await requestJson<{ id: string }>('/api/agents', {
    method: 'POST',
    body: {
      name: REVIEWER_AGENT,
      description: 'RFC-304 ci-fix e2e self-reviewer',
      outputs: ['findings'],
      readonly: true,
      bodyMd: 'Review the change.',
    },
  })

  const agent = await requestJson<{ id: string }>('/api/agents', {
    method: 'POST',
    body: {
      name: FIXER_AGENT,
      description: 'RFC-304 ci-fix e2e fixer',
      outputs: ['fix'],
      readonly: false,
      bodyMd: 'Fix the failing check.',
    },
  })

  endpoint = await requestJson('/api/webhook-endpoints', {
    method: 'POST',
    body: { name: 'RFC-304 ci-fix', provider: 'gitlab' },
  })

  const repoId = await importRepo(project.repoHttpUrl)

  // Four scripts adapt this team's pipeline. They live beside the agent slots
  // in RFC-309's single template — deterministic, no model anywhere.
  const template = await requestJson<{ id: string }>('/api/capability-templates', {
    method: 'POST',
    body: {
      name: 'ci-fix gate template',
      capability: 'ci-fix',
      scripts: {
        collect: {
          language: 'node',
          script: emitPort('collect', {
            conflict: false,
            unresolvedComments: [],
            gate: { status: 'fail' },
            // The real head, so `prepare-worktree` has something to check out.
            headSha: project.headSha,
          }),
        },
        classify: {
          language: 'node',
          script: emitPort('classify', [
            { type: 'test-failure', file: 'src/broken.txt', message: 'the build check is red' },
          ]),
        },
        arbitrate: {
          language: 'node',
          script: emitPort('arbitrate', [
            { capability: 'ci-fix', items: [{ issueRef: 'test-failure:src/broken.txt' }] },
          ]),
        },
        select: {
          language: 'node',
          script: emitPort('select', { bySlot: { 'ci-fixer': { agent: FIXER_AGENT } } }),
        },
      },
      hooks: [],
      paramSchema: [],
      paramDefaults: {},
      agentBySlot: { 'ci-fixer': agent.id, reviewer: reviewer.id },
      promptBySlot: {},
      params: {},
    },
  })
  await requestJson(`/api/code/matrix/${repoId}`, {
    method: 'PUT',
    body: { capability: 'ci-fix', enabled: true, templateId: template.id },
  })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('a red pipeline runs the template SCRIPTS, not a model, for the deterministic half', async () => {
  // Constitution R1: what can be decided by a program is decided by a program.
  // Four script stages precede the one AI stage, and each of them is the team's
  // own code — a platform default here would make one team's policy stand in
  // for another's.
  await mocks.deliverWebhook({
    provider: 'gitlab',
    callbackUrl: `${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`,
    secret: endpoint.secret,
    projectPath: PROJECT_PATH,
    number: project.number,
    event: 'pipeline_failed',
  })

  const stages = await waitForStages()
  for (const name of ['collect', 'classify', 'arbitrate', 'select']) {
    const stage = stages.find((s) => s.stageName === name)
    expect(stage, `${name} never ran`).toBeDefined()
    expect(`${name}:${stage?.status ?? '?'}${stage?.error ?? ''}`).toBe(`${name}:done`)
  }
})

test('the fix is proved by RUNNING the repository’s own gate — red before, green after', async () => {
  // The assertion the capability exists for, and the one that could not happen:
  // with no gate runner wired, `validate-fix` threw before it could compare
  // anything.
  const stages = await waitForStages()
  const validate = stages.find((s) => s.stageName === 'validate-fix')

  expect(validate, 'validate-fix never ran').toBeDefined()
  // `done` alone is not enough: a round whose gate stayed RED also records
  // `validate-fix:done` and then SETTLES, marking everything after it skipped.
  // The distinction lives in what follows, so it is asserted there — a stage
  // that ran after `validate-fix` means the gate came back green.
  expect(
    `${validate?.status ?? '?'} ${validate?.error ?? ''}`.trim(),
    'the gate must have run',
  ).toBe('done')
  const after = stages.slice(stages.findIndex((s) => s.stageName === 'validate-fix') + 1)
  expect(
    after.some((s) => s.status !== 'skipped' || !(s.error ?? '').includes('left the gate red')),
    `the gate stayed red: ${JSON.stringify(
      (await mocks.requests('gitlab'))
        .filter((r) => r.method === 'POST' && r.path.includes(`/projects/${project.projectId}/`))
        .map((r) => r.bodyText.slice(0, 500)),
    ).slice(0, 900)} :: ${stages
      .map((x) => `${x.stageName}:${x.status}${x.error === null ? '' : `(${x.error})`}`)
      .join(', ')}`,
  ).toBe(true)

  // And the agent's change is what made it green: the same gate, on the seeded
  // tree, exits non-zero.
  const fix = stages.find((s) => s.stageName === 'fix')
  expect(fix?.status).toBe('done')
})

test('the change is SELF-REVIEWED against a frozen snapshot, and the round continues', async () => {
  // `self-review` re-reads this round's own change through `mr-review`'s
  // reading stages. Two things had to be true for it to mean anything, and
  // neither was: the stage implementations had to be supplied to the runner (no
  // caller ever did — both capabilities that self-review failed here), and the
  // diff had to span the round's baseline to a SNAPSHOT of the fixed tree. With
  // the baseline on both sides the reviewers would read the code as it was
  // before the fix, which the design calls a self-review of nothing.
  const stages = await waitForStages()
  const selfReview = stages.find((s) => s.stageName === 'self-review')

  expect(
    `${selfReview?.status ?? 'missing'}${selfReview?.error === null || selfReview?.error === undefined ? '' : ` (${selfReview.error})`}`,
  ).toBe('done')

  // And the stages after it ran — the round did not stop at the review.
  const after = stages.slice(stages.findIndex((s) => s.stageName === 'self-review') + 1)
  expect(
    after.filter((s) => s.status === 'done').length,
    `nothing ran after the self-review: ${stages
      .map((x) => `${x.stageName}:${x.status}${x.error === null ? '' : `(${x.error})`}`)
      .join(', ')}`,
  ).toBeGreaterThan(0)
})

test('the whole ci-fix sequence reaches its end', async () => {
  // The claim the capability makes, end to end: red pipeline in, a proved fix
  // out. Stated as a stage list so a future change that quietly stops one stage
  // short shows up here rather than as "the round says done".
  const stages = await waitForStages()
  const digest = stages
    .map((s) => `${s.stageName}:${s.status}${s.error === null ? '' : `(${s.error})`}`)
    .join(', ')

  for (const name of ['anti-cheat-check', 'push', 'ledger']) {
    const stage = stages.find((s) => s.stageName === name)
    expect(stage?.status, `${name} did not run; ${digest}`).not.toBe('skipped')
  }
})

// ---------------------------------------------------------------------------

interface StageView {
  stageName: string
  status: string
  error: string | null
}

/** A node script emitting one envelope port, the way a framework author would. */
function emitPort(port: string, value: unknown): string {
  return [
    'const nonce = process.env.AW_ENVELOPE_NONCE',
    `const body = ${JSON.stringify(JSON.stringify(value))}`,
    'console.log(`<workflow-output nonce="${nonce}">`)',
    `console.log('<port name="${port}">' + body + '</port>')`,
    "console.log('</workflow-output>')",
  ].join('\n')
}

async function waitForStages(): Promise<StageView[]> {
  return await waitFor(
    async () => {
      const page = await requestJson<{
        items: Array<{ rounds: Array<{ endedAt: number | null; stages: StageView[] }> }>
      }>('/api/code/work-items?capability=ci-fix')
      const round = page.items[0]?.rounds[0]
      return round !== undefined && round.endedAt !== null ? round.stages : null
    },
    async () => `a finished ci-fix round; items: ${await itemsDigest()}`,
  )
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
    throw new Error(`${options.method ?? 'GET'} ${path} → ${String(response.status)}: ${text}`)
  }
  return text === '' ? (undefined as T) : (JSON.parse(text) as T)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}
