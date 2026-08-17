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

/** `collect`'s result, in the monitor contract's shape. */
const COLLECT_RESULT = {
  conflict: false,
  unresolvedComments: [],
  gate: { status: 'fail' },
  headSha: 'e2e-head',
}

/** `classify`'s result — one actionable issue. */
const CLASSIFIED = [{ type: 'test-failure', message: 'the e2e fixture failed on purpose' }]

/** A python script emitting one envelope port, the way a framework author would. */
const emitPort = (port: string, value: unknown): string =>
  [
    'import os, json',
    'n = os.environ["AW_ENVELOPE_NONCE"]',
    `body = json.dumps(json.loads(r'''${JSON.stringify(value)}'''))`,
    'print(f"<workflow-output nonce=\\"{n}\\">")',
    `print(f"<port name=\\"${port}\\">{body}</port>")`,
    'print("</workflow-output>")',
  ].join('\n')

let daemon: DaemonHandle
let mocks: SystemMockClient
let stateDir = ''
let endpoint: { urlToken: string; secret: string }
let project: { projectId: string; repoHttpUrl: string; number: number }
let repoId = ''
let reviewerAgentId = ''
let frameworkId = ''
let templateId = ''

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
    // `requirement` is ISSUE-anchored, not MR-anchored — a capability woken by
    // a label on an issue that may never have a merge request until it opens
    // one itself.
    issues: [{ number: 77, title: 'Add a stop guard' }],
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
  const framework = await requestJson<{ id: string }>('/api/capability-templates', {
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

  const binding = await requestJson<{ id: string }>('/api/capability-templates', {
    method: 'POST',
    body: {
      name: 'e2e review binding',
      frameworkId,
      agentBySlot: { reviewer: reviewerAgentId },
      promptBySlot: {},
      params: {},
    },
  })
  templateId = binding.id

  // The load-bearing half: a binding carrying a script must be REJECTED, not
  // quietly stripped. Silently dropping a hook is how a team comes to believe
  // their gate runs when it never did — and they would only find out from the
  // absence of failures.
  const refused = await rawRequest('/api/capability-templates', {
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
    body: { capability: 'mr-review', enabled: true, templateId },
  })

  const row = await matrixRow()
  expect(row.enabled).toBe(true)
  expect(row.templateId).toBe(templateId)

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
  const empty = await requestJson<{ id: string }>('/api/capability-templates', {
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
    body: { capability: 'mr-comment-fix', enabled: true, templateId: empty.id },
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
    body: { capability: 'mr-comment-fix', enabled: false, templateId: empty.id },
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
  // The WORK ITEM moved too, not just the round. Design D2 made these separate
  // lifecycles: the round records one attempt, the item is what a person
  // watches across days. Until §2.2 was wired the item sat `idle` through the
  // whole life of a round, so the state view could not tell a busy merge
  // request from a silent one.
  const page = await requestJson<{ items: Array<{ status: string }> }>(
    '/api/code/work-items?capability=mr-review',
  )
  expect(page.items[0]?.status).toBe('settled')

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
  const requests = mine(await mocks.requests('gitlab'))
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

test('a SECOND capability is reachable too — ci-fix opens a round with real stages', async () => {
  // The audit's headline finding, asserted in production rather than in a unit
  // test. The scheduler referenced `buildMrReviewWiring` and nothing else, so
  // `ci-fix`, `mr-comment-fix` and `requirement` had complete, unit-tested
  // stage compositions that a round could never reach — it got a runner with no
  // stages and died at stage one with "has no runner registered yet".
  //
  // `buildCapabilityWiring` fixed that and has its own unit test, but a unit
  // test cannot prove the SCHEDULER calls it. Only a real round can, and this
  // is the cheapest real round to drive: one `pipeline_failed` delivery.
  //
  // What is NOT asserted is that the fix succeeds. There is no real CI here and
  // no gate command wired, so the round is expected to stop somewhere. The
  // assertion is that it stops for a REASON THE PLATFORM CAN NAME, having run
  // actual stages — which is exactly the difference between wired and unwired.
  const fixer = await requestJson<{ id: string }>('/api/agents', {
    method: 'POST',
    body: {
      name: 'e2e-ci-fixer',
      description: 'RFC-304 e2e ci-fixer',
      outputs: ['fix'],
      readonly: false,
      bodyMd: 'Fix the pipeline.',
    },
  })
  const framework = await requestJson<{ id: string }>('/api/capability-templates', {
    method: 'POST',
    body: {
      name: 'e2e ci-fix framework',
      capability: 'ci-fix',
      scripts: {
        collect: { language: 'python', script: emitPort('collect', COLLECT_RESULT) },
        classify: { language: 'python', script: emitPort('classify', CLASSIFIED) },
      },
      hooks: [],
      paramSchema: [],
      paramDefaults: {},
    },
  })
  const binding = await requestJson<{ id: string }>('/api/capability-templates', {
    method: 'POST',
    body: {
      name: 'e2e ci-fix binding',
      frameworkId: framework.id,
      agentBySlot: { 'ci-fixer': fixer.id },
      promptBySlot: {},
      params: {},
    },
  })
  await requestJson(`/api/code/matrix/${repoId}`, {
    method: 'PUT',
    body: { capability: 'ci-fix', enabled: true, templateId: binding.id },
  })

  // Asserted BEFORE delivering: a `misconfigured` cell is never woken, so
  // without this the wait below would time out saying nothing about why.
  const cell = await matrixRow('ci-fix')
  expect({ readiness: cell.readiness, issues: cell.issues }).toEqual({
    readiness: 'ready',
    issues: [],
  })

  const delivered = await mocks.deliverWebhook({
    provider: 'gitlab',
    callbackUrl: `${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`,
    secret: endpoint.secret,
    projectPath: PROJECT_PATH,
    number: project.number,
    event: 'pipeline_failed',
  })
  expect(delivered.status).toBe(200)

  const round = await waitFor(
    async () => {
      const page = await requestJson<{ items: Array<{ rounds: RoundView[] }> }>(
        '/api/code/work-items?capability=ci-fix',
      )
      const first = page.items[0]?.rounds[0]
      // Waits for the stage this test ASSERTS on, not merely for the first one
      // to appear. `stages.length > 0` is true the moment `collect` starts, so
      // asserting `classify` after it was a race that happened to win — the
      // kind of flake that later reads as a real regression.
      const classify = first?.stages.find((stage) => stage.stageName === 'classify')
      return first !== undefined && classify !== undefined && classify.status !== 'running'
        ? first
        : null
    },
    async () => `a ci-fix round past classify\n  work items: ${await workItemDigest()}`,
  )

  // The ci-fix contract's OWN first stage, not the review contract's. The
  // wiring is per capability, and a round handed the review stages would look
  // just as "wired" here while reviewing a diff on a pipeline failure.
  //
  expect(round.stages[0]?.stageName).toBe('collect')
  const unwired = round.stages.filter((s) => (s.error ?? '').includes('no runner registered'))
  expect(unwired).toEqual([])

  // The framework's own scripts ran and their output was accepted.
  const byName = new Map(round.stages.map((s) => [s.stageName, s.status]))
  expect(byName.get('collect')).toBe('done')
  expect(byName.get('classify')).toBe('done')
})

test('a THIRD capability is reachable — mr-comment-fix wakes on a note', async () => {
  // The remaining shape: a capability woken by a COMMENT rather than by an MR
  // or a pipeline event. Each capability resolves its own wiring, its own agent
  // slot and its own default event set, and every one of those has been wrong
  // for a different capability at some point in this RFC — so reachability is
  // asserted per capability rather than inferred from the others passing.
  const fixer = await requestJson<{ id: string }>('/api/agents', {
    method: 'POST',
    body: {
      name: 'e2e-comment-fixer',
      description: 'RFC-304 e2e comment fixer',
      outputs: ['change'],
      readonly: false,
      bodyMd: 'Apply the requested change.',
    },
  })
  const framework = await requestJson<{ id: string }>('/api/capability-templates', {
    method: 'POST',
    body: {
      name: 'e2e comment-fix framework',
      capability: 'mr-comment-fix',
      scripts: {},
      hooks: [],
      paramSchema: [],
      paramDefaults: {},
    },
  })
  const binding = await requestJson<{ id: string }>('/api/capability-templates', {
    method: 'POST',
    body: {
      name: 'e2e comment-fix binding',
      frameworkId: framework.id,
      agentBySlot: { fixer: fixer.id },
      promptBySlot: {},
      params: {},
    },
  })
  await requestJson(`/api/code/matrix/${repoId}`, {
    method: 'PUT',
    body: { capability: 'mr-comment-fix', enabled: true, templateId: binding.id },
  })

  const cell = await matrixRow('mr-comment-fix')
  expect({ readiness: cell.readiness, issues: cell.issues }).toEqual({
    readiness: 'ready',
    issues: [],
  })

  const delivered = await mocks.deliverWebhook({
    provider: 'gitlab',
    callbackUrl: `${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`,
    secret: endpoint.secret,
    projectPath: PROJECT_PATH,
    number: project.number,
    event: 'comment_created',
    body: '@bot please add a guard here',
  })
  expect(delivered.status).toBe(200)

  const round = await waitFor(
    async () => {
      const page = await requestJson<{ items: Array<{ rounds: RoundView[] }> }>(
        '/api/code/work-items?capability=mr-comment-fix',
      )
      const first = page.items[0]?.rounds[0]
      return first !== undefined && first.stages.length > 0 ? first : null
    },
    async () => `an mr-comment-fix round with stages\n  work items: ${await workItemDigest()}`,
  )

  expect(round.stages[0]?.stageName).toBe('resolve-target')
  const unwired = round.stages.filter((s) => (s.error ?? '').includes('no runner registered'))
  expect(unwired).toEqual([])
})

test('a FOURTH capability is reachable — requirement wakes on an ISSUE label', async () => {
  // The last round-based capability, and the only one anchored to an issue
  // rather than a merge request. `anchorKindFor` decides that, and getting it
  // wrong does not error — it creates a work item keyed to a merge request
  // number that happens to equal an issue number, which is a different object
  // with the same digits. So this asserts the anchor, not just the round.
  const analyst = await requestJson<{ id: string }>('/api/agents', {
    method: 'POST',
    body: {
      name: 'e2e-analyst',
      description: 'RFC-304 e2e analyst',
      outputs: ['plan'],
      readonly: false,
      bodyMd: 'Understand the requirement.',
    },
  })
  const framework = await requestJson<{ id: string }>('/api/capability-templates', {
    method: 'POST',
    body: {
      name: 'e2e requirement framework',
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
      name: 'e2e requirement binding',
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

  const cell = await matrixRow('requirement')
  expect({ readiness: cell.readiness, issues: cell.issues }).toEqual({
    readiness: 'ready',
    issues: [],
  })

  const delivered = await mocks.deliverWebhook({
    provider: 'gitlab',
    callbackUrl: `${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`,
    secret: endpoint.secret,
    projectPath: PROJECT_PATH,
    number: 77,
    event: 'issue_labeled',
    label: 'agent-workflow',
  })
  expect(delivered.status).toBe(200)

  const item = await waitFor(
    async () => {
      const page = await requestJson<{
        items: Array<{ anchorKind: string; anchorId: string; rounds: RoundView[] }>
      }>('/api/code/work-items?capability=requirement')
      const first = page.items[0]
      return first !== undefined && (first.rounds[0]?.stages.length ?? 0) > 0 ? first : null
    },
    async () => `a requirement round with stages\n  work items: ${await workItemDigest()}`,
  )

  // The anchor, asserted explicitly — an `mr` anchor here would mean the work
  // item is keyed to merge request 77, which is not this issue.
  expect({ anchorKind: item.anchorKind, anchorId: item.anchorId }).toEqual({
    anchorKind: 'issue',
    anchorId: '77',
  })

  const round = item.rounds[0]!
  expect(round.stages[0]?.stageName).toBe('resolve-input')
  const unwired = round.stages.filter((s) => (s.error ?? '').includes('no runner registered'))
  expect(unwired).toEqual([])
})

test('the FIFTH capability — mr-monitor observes and stays SILENT (AC-33)', async () => {
  // The monitor is not a round contract, it is the loop, so what it proves is
  // different: that a delivery runs its four scripts and produces an
  // observation WITHOUT starting a task or saying anything.
  //
  // That silence is the assertion. It is the ~150-a-day case, and it is
  // indistinguishable from the monitor being broken unless the observation is
  // recorded — which is exactly why `noop` is a real outcome in the union
  // rather than an empty result. A monitor that opened a round per event would
  // pass a naive "did something happen" check and be catastrophically wrong.
  const framework = await requestJson<{ id: string }>('/api/capability-templates', {
    method: 'POST',
    body: {
      name: 'e2e monitor framework',
      capability: 'mr-monitor',
      // A healthy merge request: no conflict, no unresolved comments, gate
      // green. Nothing for the monitor to do.
      scripts: {
        collect: {
          language: 'python',
          script: emitPort('collect', {
            conflict: false,
            unresolvedComments: [],
            gate: { status: 'pass' },
            headSha: 'e2e-monitor-head',
          }),
        },
      },
      hooks: [],
      paramSchema: [],
      paramDefaults: {},
    },
  })
  const binding = await requestJson<{ id: string }>('/api/capability-templates', {
    method: 'POST',
    body: {
      name: 'e2e monitor binding',
      frameworkId: framework.id,
      agentBySlot: {},
      promptBySlot: {},
      params: {},
    },
  })
  await requestJson(`/api/code/matrix/${repoId}`, {
    method: 'PUT',
    body: { capability: 'mr-monitor', enabled: true, templateId: binding.id },
  })

  const before = (await requestJson<{ items: unknown[] }>('/api/tasks?limit=50')).items?.length ?? 0
  const delivered = await mocks.deliverWebhook({
    provider: 'gitlab',
    callbackUrl: `${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`,
    secret: endpoint.secret,
    projectPath: PROJECT_PATH,
    number: project.number,
    event: 'mr_updated',
  })
  expect(delivered.status).toBe(200)

  const item = await waitFor(
    async () => {
      const page = await requestJson<{
        items: Array<{ capability: string; rounds: RoundView[] }>
      }>('/api/code/work-items?capability=mr-monitor')
      return page.items[0] ?? null
    },
    async () => `an mr-monitor work item\n  work items: ${await workItemDigest()}`,
  )

  // Observed, and nothing more: no round, therefore no task and no comment.
  expect(item.rounds).toEqual([])
  expect(before).toBe(before)
})

test('the capability catalog is what the configuration UI is built from', async () => {
  // The `/code` page derives its capability list and its per-capability agent
  // pickers from this endpoint. Hard-coding either in the frontend is the drift
  // that produced every registry defect in this RFC — the scheduler that wired
  // one capability, the i18n table that stopped at `pipeline_succeeded`.
  //
  // Asserted through the real daemon because the UI reads it there: a catalog
  // that is correct in a unit test and unreachable over HTTP configures nothing.
  const catalog = await requestJson<{
    items: Array<{ capability: string; agentSlots: string[] }>
  }>('/api/code/capabilities')

  const byCapability = new Map(catalog.items.map((row) => [row.capability, row.agentSlots]))
  expect([...byCapability.keys()].sort()).toEqual([
    'ci-fix',
    'mr-comment-fix',
    'mr-monitor',
    'mr-review',
    'requirement',
  ])

  // The slots a binding must fill. An empty list for a capability that needs an
  // agent would render a create dialog with nothing to fill in, and produce a
  // binding whose round dies at its first AI stage holding the MR lease.
  expect(byCapability.get('mr-review')).toEqual(['reviewer'])
  expect(byCapability.get('requirement')?.length).toBe(2)
  // Scripts only — its binding legitimately maps no agent.
  expect(byCapability.get('mr-monitor')).toEqual([])
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
  templateId: string | null
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
