// End-to-end business workflows.
//
// These scenarios intentionally exercise public import / validation / task /
// review APIs against the production daemon, SQLite, scheduler, Git worktrees,
// wrapper scopes and envelope parser. Only the external model process is
// replaced by a deterministic executable.

import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { initGitRepo, runGit } from './command'
import { startDaemon, type DaemonHandle } from './harness'
import { loadWorkflowFixture } from './workflow-fixtures'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUSINESS_DIR = join(HERE, '..', 'examples', 'workflows', 'business')

const WORKFLOW_FILES = [
  'defect-fix-controlled-release.yaml',
  'document-batch-compliance-publishing.yaml',
] as const
type WorkflowFile = (typeof WORKFLOW_FILES)[number]

interface WorkflowRow {
  id: string
  name: string
  version: number
  snapshotHash: string
}

interface TaskRow {
  id: string
  status: string
  errorMessage?: string | null
}

interface NodeRunRow {
  id: string
  nodeId: string
  parentNodeRunId: string | null
  iteration: number
  shardKey: string | null
  retryIndex: number
  status: string
  errorMessage: string | null
  promptText: string | null
}

interface NodeRunsResponse {
  runs: NodeRunRow[]
  outputs: Array<{
    nodeRunId: string
    port: string
    value: string
    kind: string | null
  }>
}

interface ReviewSummaryRow {
  nodeRunId: string
  taskId: string
  reviewIteration: number
  awaitingReview: boolean
  isMultiDoc?: boolean
}

interface ReviewDetail {
  documents?: Array<{
    docVersionId: string
    itemIndex: number
    title: string
    selection: 'unselected' | 'accepted' | 'not_accepted'
  }>
}

interface DocVersionDetail {
  body: string
}

interface WorktreeFile {
  path: string
  content: string
  oversized: boolean
}

const READ_ONLY_PERMISSION = { read: 'allow', edit: 'deny', write: 'deny' } as const

const AGENT_FIXTURES = [
  {
    name: 'business-fix-engineer',
    outputs: ['fix_summary'],
    outputKinds: { fix_summary: 'markdown' },
    permission: {},
  },
  {
    name: 'business-code-auditor',
    outputs: ['audit_status', 'audit_report'],
    outputKinds: { audit_status: 'string', audit_report: 'markdown' },
    permission: READ_ONLY_PERMISSION,
  },
  {
    name: 'business-test-runner',
    outputs: ['test_status', 'test_report'],
    outputKinds: { test_status: 'string', test_report: 'markdown' },
    permission: READ_ONLY_PERMISSION,
  },
  {
    name: 'business-quality-gate',
    outputs: ['quality_status', 'release_brief'],
    outputKinds: { quality_status: 'string', release_brief: 'markdown' },
    permission: {},
  },
  {
    name: 'business-release-preparer',
    outputs: ['release_brief'],
    outputKinds: { release_brief: 'markdown' },
    permission: READ_ONLY_PERMISSION,
  },
  {
    name: 'business-document-reviewer',
    outputs: ['finding'],
    outputKinds: { finding: 'markdown' },
    permission: READ_ONLY_PERMISSION,
  },
  {
    name: 'business-compliance-aggregator',
    outputs: ['report'],
    outputKinds: { report: 'markdown' },
    outputWrapperPortNames: { report: 'compliance_report' },
    role: 'aggregator',
    permission: READ_ONLY_PERMISSION,
  },
  {
    name: 'business-document-publisher',
    outputs: ['documents'],
    outputKinds: { documents: 'list<markdown>' },
    permission: {},
  },
  {
    name: 'business-document-releaser',
    outputs: ['published_paths'],
    outputKinds: { published_paths: 'list<path<md>>' },
    permission: {},
  },
] as const

let daemon: DaemonHandle
let repoDir: string
let repoHead: string
let stateDir: string
let taskSequence = 0
const workflows = new Map<WorkflowFile, WorkflowRow>()

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

test.beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'aw-business-workflow-state-'))
  daemon = await startDaemon({
    stubMode: 'business-workflows',
    extraEnv: { BUSINESS_WORKFLOW_STATE_DIR: stateDir },
    configOverrides: {
      defaultNodeRetries: 0,
      defaultPerNodeTimeoutMs: 5_000,
    },
  })

  repoDir = mkdtempSync(join(tmpdir(), 'aw-business-workflow-repo-'))
  mkdirSync(join(repoDir, 'src'), { recursive: true })
  mkdirSync(join(repoDir, 'docs'), { recursive: true })
  writeFileSync(join(repoDir, 'README.md'), '# business workflow fixture\n')
  writeFileSync(
    join(repoDir, 'src', 'checkout.ts'),
    [
      'export function calculateTotal(subtotalCents: number): number {',
      '  return Math.floor(subtotalCents * 1.13)',
      '}',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(repoDir, 'docs', 'customer-policy.md'),
    '# Customer policy\n\nSource: Customer Operations.\n',
  )
  writeFileSync(
    join(repoDir, 'docs', 'partner-policy.md'),
    '# Partner policy\n\nSource: Partner Operations.\n',
  )
  writeFileSync(
    join(repoDir, 'docs', 'unsourced-policy.md'),
    '# Unsourced policy\n\nThis document intentionally has no source declaration.\n',
  )
  initGitRepo(repoDir)
  repoHead = runGit(['rev-parse', 'HEAD'], repoDir).trim()

  for (const fixture of AGENT_FIXTURES) {
    const response = await apiFetch('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        ...fixture,
        description: `business workflow fixture: ${fixture.name}`,
        bodyMd: 'Deterministic agent used by real-daemon business workflow scenarios.',
      }),
    })
    await expectHttp(response, 201, `create ${fixture.name}`)
    const created = (await response.json()) as { permission: Record<string, unknown> }
    expect(created.permission).toEqual(fixture.permission)
  }

  for (const file of WORKFLOW_FILES) {
    // RFC-271 批次 I 下线了 `POST /api/workflows/import`（裸 YAML 导入）；fixture
    // 装载改走公开的 `POST /api/workflows`，见 `workflow-fixtures.ts` 的说明。
    workflows.set(file, await loadWorkflowFixture<WorkflowRow>(apiFetch, join(BUSINESS_DIR, file)))
  }
})

test.afterAll(async () => {
  try {
    rmSync(repoDir, { recursive: true, force: true })
  } catch {
    // best-effort fixture cleanup
  }
  try {
    rmSync(stateDir, { recursive: true, force: true })
  } catch {
    // best-effort fixture cleanup
  }
  if (daemon !== undefined) await daemon.stop()
})

function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
}

async function expectHttp(response: Response, expected: number, what: string): Promise<void> {
  if (response.status === expected) return
  throw new Error(
    `${what}: expected HTTP ${expected}, got ${response.status}: ${await response.text()}`,
  )
}

function workflow(file: WorkflowFile): WorkflowRow {
  const row = workflows.get(file)
  if (row === undefined) throw new Error(`business workflow was not imported: ${file}`)
  return row
}

async function validate(file: WorkflowFile): Promise<void> {
  const row = workflow(file)
  const response = await apiFetch(`/api/workflows/${row.id}/validate`, {
    method: 'POST',
    body: JSON.stringify({
      expectedVersion: row.version,
      expectedSnapshotHash: row.snapshotHash,
    }),
  })
  await expectHttp(response, 200, `validate ${file}`)
  const receipt = (await response.json()) as {
    ok: boolean
    issues: Array<{ code: string; severity?: 'error' | 'warning' }>
  }
  expect(
    receipt.issues.filter((issue) => (issue.severity ?? 'error') === 'error'),
    `${file} validation errors`,
  ).toEqual([])
  expect(receipt.ok).toBe(true)
}

async function launch(file: WorkflowFile, inputs: Record<string, string>): Promise<TaskRow> {
  taskSequence += 1
  const row = workflow(file)
  const response = await apiFetch('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workflowId: row.id,
      expectedWorkflowVersion: row.version,
      name: `business-${taskSequence}-${row.name}`,
      repoUrl: pathToFileURL(repoDir).href,
      ref: 'main',
      inputs,
    }),
  })
  await expectHttp(response, 201, `launch ${file}`)
  return (await response.json()) as TaskRow
}

async function waitForTask(
  taskId: string,
  predicate: (task: TaskRow) => boolean,
  timeoutMs = 60_000,
): Promise<TaskRow> {
  const deadline = Date.now() + timeoutMs
  let last: TaskRow = { id: taskId, status: 'pending' }
  while (Date.now() < deadline) {
    const response = await apiFetch(`/api/tasks/${taskId}`)
    if (response.ok) {
      last = (await response.json()) as TaskRow
      if (predicate(last)) return last
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`task ${taskId} did not reach expected state; last=${JSON.stringify(last)}`)
}

async function waitForTerminal(taskId: string): Promise<TaskRow> {
  const terminal = new Set(['done', 'failed', 'canceled', 'interrupted', 'exhausted'])
  return waitForTask(taskId, (task) => terminal.has(task.status))
}

async function waitForReview(
  taskId: string,
  minimumIteration = 0,
  timeoutMs = 30_000,
): Promise<ReviewSummaryRow> {
  const deadline = Date.now() + timeoutMs
  let last: ReviewSummaryRow[] = []
  while (Date.now() < deadline) {
    const response = await apiFetch(
      `/api/reviews?status=pending&taskId=${encodeURIComponent(taskId)}`,
    )
    if (response.ok) {
      last = (await response.json()) as ReviewSummaryRow[]
      const row = last.find(
        (candidate) =>
          candidate.taskId === taskId &&
          candidate.awaitingReview &&
          candidate.reviewIteration >= minimumIteration,
      )
      if (row !== undefined) return row
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `no pending review at iteration >= ${minimumIteration} for ${taskId}; last=${JSON.stringify(last)}`,
  )
}

async function decide(
  review: ReviewSummaryRow,
  decision: 'approved' | 'rejected',
  rejectReason?: string,
): Promise<void> {
  const response = await apiFetch(`/api/reviews/${review.nodeRunId}/decision`, {
    method: 'POST',
    body: JSON.stringify({
      decision,
      reviewIteration: review.reviewIteration,
      ...(rejectReason === undefined ? {} : { rejectReason }),
    }),
  })
  await expectHttp(response, 200, `${decision} review ${review.nodeRunId}`)
}

async function nodeRuns(taskId: string): Promise<NodeRunsResponse> {
  const response = await apiFetch(`/api/tasks/${taskId}/node-runs`)
  await expectHttp(response, 200, `node runs for ${taskId}`)
  return (await response.json()) as NodeRunsResponse
}

async function readWorktree(taskId: string, path: string): Promise<WorktreeFile> {
  const response = await apiFetch(
    `/api/tasks/${taskId}/worktree-file?path=${encodeURIComponent(path)}`,
  )
  await expectHttp(response, 200, `read ${path} from ${taskId}`)
  return (await response.json()) as WorktreeFile
}

async function expectWorktreeMissing(taskId: string, path: string): Promise<void> {
  const response = await apiFetch(
    `/api/tasks/${taskId}/worktree-file?path=${encodeURIComponent(path)}`,
  )
  expect(response.status, `${path} should not exist in task ${taskId}`).toBe(404)
}

function runsFor(data: NodeRunsResponse, nodeId: string): NodeRunRow[] {
  return data.runs
    .filter((run) => run.nodeId === nodeId)
    .sort((a, b) => a.iteration - b.iteration || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1))
}

function onlyRun(data: NodeRunsResponse, nodeId: string): NodeRunRow {
  const runs = runsFor(data, nodeId)
  expect(runs, `expected exactly one run for ${nodeId}`).toHaveLength(1)
  return runs[0]!
}

function outputValue(data: NodeRunsResponse, runId: string, port: string): string | undefined {
  return data.outputs.find((output) => output.nodeRunId === runId && output.port === port)?.value
}

function exactPromptLineCount(prompt: string | null, expected: string): number {
  return (prompt ?? '')
    .split('\n')
    .map((line) => line.replace(/^\u200b/, ''))
    .filter((line) => line === expected).length
}

test('缺陷修复与受控发布：第一轮发现边界问题，第二轮 clean 后才允许人工批准', async () => {
  const file = 'defect-fix-controlled-release.yaml'
  await validate(file)
  const task = await launch(file, {
    defect: 'round cents correctly and reject invalid subtotals',
    release_policy: 'NO_PUSH; require clean audit and passing contract checks',
  })

  const parked = await waitForTask(
    task.id,
    (row) => row.status === 'awaiting_review' || row.status === 'failed',
  )
  expect(parked.status, parked.errorMessage ?? undefined).toBe('awaiting_review')
  const review = await waitForReview(task.id)
  expect(review.isMultiDoc ?? false).toBe(false)

  const beforeApproval = await nodeRuns(task.id)
  const loop = onlyRun(beforeApproval, 'repair_loop')
  expect(loop.status).toBe('done')
  expect(runsFor(beforeApproval, 'release_output')).toHaveLength(0)

  const gitRuns = runsFor(beforeApproval, 'repair_git')
  expect(gitRuns.map((run) => run.iteration)).toEqual([0, 1])
  for (const gitRun of gitRuns) {
    const changed = outputValue(beforeApproval, gitRun.id, 'git_diff')
    expect(changed).toContain('src/checkout.ts')
    expect(changed).toContain('tests/checkout.contract.md')
  }

  const fixerRuns = runsFor(beforeApproval, 'fixer')
  expect(fixerRuns.map((run) => run.iteration)).toEqual([0, 1])
  const auditRuns = runsFor(beforeApproval, 'code_audit')
  const testRuns = runsFor(beforeApproval, 'contract_tests')
  const gateRuns = runsFor(beforeApproval, 'quality_gate')
  expect(auditRuns.every((run) => run.promptText?.includes('src/checkout.ts') === true)).toBe(true)
  expect(
    auditRuns.every((run) => run.promptText?.includes('tests/checkout.contract.md') === true),
  ).toBe(true)
  expect(testRuns.every((run) => run.promptText?.includes('src/checkout.ts') === true)).toBe(true)
  expect(
    testRuns.every((run) => run.promptText?.includes('tests/checkout.contract.md') === true),
  ).toBe(true)
  expect(auditRuns.map((run) => outputValue(beforeApproval, run.id, 'audit_status'))).toEqual([
    'needs-fix',
    'clean',
  ])
  expect(testRuns.map((run) => outputValue(beforeApproval, run.id, 'test_status'))).toEqual([
    'failed',
    'passed',
  ])
  expect(gateRuns.map((run) => outputValue(beforeApproval, run.id, 'quality_status'))).toEqual([
    'needs-fix',
    'clean',
  ])
  expect(gateRuns[0]?.promptText).toContain(
    'Negative or fractional cent inputs still lack an admission guard.',
  )
  expect(gateRuns[0]?.promptText).toContain(
    'The negative and fractional input cases do not throw yet.',
  )
  expect(gateRuns[1]?.promptText).toContain('Rounding and invalid-input boundaries are covered.')
  expect(gateRuns[1]?.promptText).toContain(
    'Rounding, invalid input, zero and large totals are covered.',
  )
  expect(outputValue(beforeApproval, loop.id, 'quality_report')).toContain('Quality gate clean')

  const releasePacket = onlyRun(beforeApproval, 'release_packet')
  expect(releasePacket.promptText).toContain('src/checkout.ts')
  expect(releasePacket.promptText).toContain('Quality gate clean')
  expect(outputValue(beforeApproval, releasePacket.id, 'release_brief')).toContain(
    'No push was executed',
  )
  expect(outputValue(beforeApproval, releasePacket.id, 'release_brief')).toContain(
    'Repair round 1 — blocked',
  )
  expect(outputValue(beforeApproval, releasePacket.id, 'release_brief')).toContain(
    'Negative or fractional cent inputs still lack an admission guard.',
  )
  expect(outputValue(beforeApproval, releasePacket.id, 'release_brief')).toContain(
    'Repair round 2 — releasable',
  )
  expect((await readWorktree(task.id, 'src/checkout.ts')).content).toContain(
    'Number.isInteger(subtotalCents)',
  )
  expect((await readWorktree(task.id, 'tests/checkout.contract.md')).content).toContain(
    'RangeError',
  )
  const qualityEvidence = (await readWorktree(task.id, 'business-evidence/quality-gate.md')).content
  expect(qualityEvidence).toContain('## Repair round 1')
  expect(qualityEvidence).toContain('audit_status=needs-fix')
  expect(qualityEvidence).toContain('test_status=failed')
  expect(qualityEvidence).toContain('## Repair round 2')
  expect(qualityEvidence).toContain('audit_status=clean')
  expect(qualityEvidence).toContain('test_status=passed')
  expect(qualityEvidence).toContain('quality_status=clean')
  expect(runGit(['rev-parse', 'HEAD'], repoDir).trim()).toBe(repoHead)
  expect(runGit(['status', '--porcelain'], repoDir)).toBe('')

  await decide(review, 'approved')
  const final = await waitForTerminal(task.id)
  expect(final.status, final.errorMessage ?? undefined).toBe('done')

  const completed = await nodeRuns(task.id)
  const output = onlyRun(completed, 'release_output')
  expect(outputValue(completed, output.id, 'approved_release')).toContain(
    'Controlled release candidate',
  )
  expect(outputValue(completed, output.id, 'approved_release')).toContain(
    'Repair round 1 — blocked',
  )
  expect(outputValue(completed, output.id, 'approved_release')).toContain(
    'Repair round 2 — releasable',
  )
  expect(outputValue(completed, output.id, 'changed_files')).toContain('src/checkout.ts')
})

test('文档批处理与合规审阅：fanout 只跑一次，驳回修订后只发布人工接受项', async () => {
  const file = 'document-batch-compliance-publishing.yaml'
  await validate(file)
  const task = await launch(file, {
    documents: 'docs/customer-policy.md\ndocs/partner-policy.md',
    compliance_policy: 'RETENTION_OWNER_REQUIRED and legal approval evidence are mandatory',
  })

  const firstPark = await waitForTask(
    task.id,
    (row) => row.status === 'awaiting_review' || row.status === 'failed',
  )
  expect(firstPark.status, firstPark.errorMessage ?? undefined).toBe('awaiting_review')
  const firstReview = await waitForReview(task.id)
  expect(firstReview.isMultiDoc).toBe(true)
  const firstDetailResponse = await apiFetch(`/api/reviews/${firstReview.nodeRunId}`)
  await expectHttp(firstDetailResponse, 200, 'load first multi-document review')
  const firstDetail = (await firstDetailResponse.json()) as ReviewDetail
  expect(firstDetail.documents?.map((document) => document.title)).toEqual([
    'Customer notice v1',
    'Compliance checklist v1',
  ])
  const firstBodies = new Map<string, string>()
  for (const document of firstDetail.documents ?? []) {
    const versionResponse = await apiFetch(
      `/api/reviews/${firstReview.nodeRunId}/versions/${document.docVersionId}`,
    )
    await expectHttp(versionResponse, 200, `load first-round document ${document.title}`)
    firstBodies.set(document.title, ((await versionResponse.json()) as DocVersionDetail).body)
  }
  expect(firstBodies.get('Customer notice v1')).toContain('Retention period: 30 days.')
  expect(firstBodies.get('Customer notice v1')).not.toContain('Retention owner:')
  expect(firstBodies.get('Customer notice v1')).not.toContain('Legal approval:')
  expect(firstBodies.get('Compliance checklist v1')).toContain(
    '- [ ] Retention owner and legal approval still missing.',
  )
  expect(firstBodies.get('Compliance checklist v1')).not.toContain('- [x] Retention owner named.')

  const firstRound = await nodeRuns(task.id)
  const fanout = onlyRun(firstRound, 'compliance_fanout')
  const reviewers = runsFor(firstRound, 'document_reviewer')
  expect(reviewers).toHaveLength(2)
  expect(reviewers.every((run) => run.parentNodeRunId === fanout.id)).toBe(true)
  expect(reviewers.map((run) => run.shardKey).sort()).toEqual([
    'docs/customer-policy.md',
    'docs/partner-policy.md',
  ])
  for (const reviewer of reviewers) {
    expect(reviewer.promptText).toContain(reviewer.shardKey ?? '<missing-shard>')
    const sibling =
      reviewer.shardKey === 'docs/customer-policy.md'
        ? 'docs/partner-policy.md'
        : 'docs/customer-policy.md'
    expect(reviewer.promptText).not.toContain(sibling)
  }
  const aggregators = runsFor(firstRound, 'compliance_aggregator')
  expect(aggregators).toHaveLength(1)
  const aggregator = aggregators[0]
  if (aggregator === undefined) throw new Error('missing compliance aggregator')
  expect(aggregator.parentNodeRunId).toBe(fanout.id)
  expect(exactPromptLineCount(aggregator.promptText, '# docs/customer-policy.md')).toBe(1)
  expect(exactPromptLineCount(aggregator.promptText, '# docs/partner-policy.md')).toBe(1)
  expect(runsFor(firstRound, 'publisher')).toHaveLength(1)
  expect(runsFor(firstRound, 'publication_releaser')).toHaveLength(0)
  expect(runsFor(firstRound, 'publication_output')).toHaveLength(0)
  await expectWorktreeMissing(task.id, 'published/customer-notice.md')
  await expectWorktreeMissing(task.id, 'published/compliance-checklist.md')

  await decide(
    firstReview,
    'rejected',
    'name the retention owner and legal approval evidence in every published document',
  )
  const secondReview = await waitForReview(task.id, firstReview.reviewIteration + 1)

  const revised = await nodeRuns(task.id)
  expect(runsFor(revised, 'document_reviewer')).toHaveLength(2)
  expect(runsFor(revised, 'compliance_aggregator')).toHaveLength(1)
  const publisherRuns = runsFor(revised, 'publisher')
  expect(publisherRuns).toHaveLength(2)
  expect(publisherRuns[1]?.promptText).toContain('## Review Rejection')
  expect(publisherRuns[1]?.promptText).toContain(
    'name the retention owner and legal approval evidence',
  )
  expect(publisherRuns[1]?.promptText).toContain('## Prior Output')
  expect(publisherRuns[1]?.promptText).toContain('# Customer notice v1')
  expect(publisherRuns[1]?.promptText).toContain('Retention period: 30 days.')
  expect(publisherRuns[1]?.promptText).toContain(
    '- [ ] Retention owner and legal approval still missing.',
  )
  expect(runsFor(revised, 'publication_releaser')).toHaveLength(0)
  expect(runsFor(revised, 'publication_output')).toHaveLength(0)
  await expectWorktreeMissing(task.id, 'published/customer-notice.md')
  await expectWorktreeMissing(task.id, 'published/compliance-checklist.md')

  const detailResponse = await apiFetch(`/api/reviews/${secondReview.nodeRunId}`)
  await expectHttp(detailResponse, 200, 'load revised multi-document review')
  const detail = (await detailResponse.json()) as ReviewDetail
  expect(detail.documents?.map((document) => document.title)).toEqual([
    'Customer notice v2',
    'Compliance checklist v2',
  ])
  for (const document of detail.documents ?? []) {
    const selectionValue = document.title === 'Customer notice v2' ? 'accepted' : 'not_accepted'
    const selectionResponse = await apiFetch(
      `/api/reviews/${secondReview.nodeRunId}/documents/${document.docVersionId}/selection`,
      {
        method: 'PATCH',
        body: JSON.stringify({ selection: selectionValue }),
      },
    )
    await expectHttp(selectionResponse, 200, `select ${document.title}`)
  }

  const selectedButUnapproved = await nodeRuns(task.id)
  expect(runsFor(selectedButUnapproved, 'publication_releaser')).toHaveLength(0)
  expect(runsFor(selectedButUnapproved, 'publication_output')).toHaveLength(0)
  expect((await waitForTask(task.id, (row) => row.status === 'awaiting_review')).status).toBe(
    'awaiting_review',
  )
  await expectWorktreeMissing(task.id, 'published/customer-notice.md')
  await expectWorktreeMissing(task.id, 'published/compliance-checklist.md')

  await decide(secondReview, 'approved')
  const final = await waitForTerminal(task.id)
  expect(final.status, final.errorMessage ?? undefined).toBe('done')

  const completed = await nodeRuns(task.id)
  const output = onlyRun(completed, 'publication_output')
  const approved = outputValue(completed, output.id, 'approved_documents')
  expect(approved).toContain('# Customer notice v2')
  expect(approved).not.toContain('# Compliance checklist v2')
  expect(approved).not.toContain('v1')
  expect(outputValue(completed, output.id, 'published_paths')).toBe('published/customer-notice.md')
  const releaser = onlyRun(completed, 'publication_releaser')
  expect(releaser.promptText).toContain('business-publish-path: published/customer-notice.md')
  expect(releaser.promptText).not.toContain(
    'business-publish-path: published/compliance-checklist.md',
  )
  expect((await readWorktree(task.id, 'published/customer-notice.md')).content).toContain(
    'Retention owner: Compliance Operations.',
  )
  expect((await readWorktree(task.id, 'drafts/compliance-checklist.md')).content).toContain(
    'Legal approval evidence recorded.',
  )
  await expectWorktreeMissing(task.id, 'published/compliance-checklist.md')
})

test('文档批处理与合规审阅：任一分片失败时不生成草稿、不打开人工门、不发布', async () => {
  const file = 'document-batch-compliance-publishing.yaml'
  await validate(file)
  const task = await launch(file, {
    documents: 'docs/customer-policy.md\ndocs/unsourced-policy.md',
    compliance_policy: 'RETENTION_OWNER_REQUIRED and legal approval evidence are mandatory',
  })

  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('failed')

  const completed = await nodeRuns(task.id)
  const reviewers = runsFor(completed, 'document_reviewer')
  expect(reviewers).toHaveLength(2)
  const validReviewer = reviewers.find((run) => run.shardKey === 'docs/customer-policy.md')
  const failedReviewer = reviewers.find((run) => run.shardKey === 'docs/unsourced-policy.md')
  expect(validReviewer?.status).toBe('done')
  expect(validReviewer?.promptText).not.toContain('docs/unsourced-policy.md')
  expect(outputValue(completed, validReviewer?.id ?? '', 'finding')).toContain(
    '# docs/customer-policy.md',
  )
  expect(failedReviewer?.status).toBe('failed')
  expect(failedReviewer?.promptText).toContain('docs/unsourced-policy.md')
  expect(failedReviewer?.promptText).not.toContain('docs/customer-policy.md')
  expect(failedReviewer?.promptText).toContain('RETENTION_OWNER_REQUIRED')
  expect(failedReviewer?.errorMessage).toBe('opencode exited with code 14')
  expect((await readWorktree(task.id, 'docs/unsourced-policy.md')).content).not.toContain('Source:')
  expect(runsFor(completed, 'compliance_aggregator')).toHaveLength(0)
  expect(runsFor(completed, 'publisher')).toHaveLength(0)
  expect(runsFor(completed, 'publication_review')).toHaveLength(0)
  expect(runsFor(completed, 'publication_releaser')).toHaveLength(0)
  await expectWorktreeMissing(task.id, 'published/customer-notice.md')
  await expectWorktreeMissing(task.id, 'published/compliance-checklist.md')

  const pendingReviewsResponse = await apiFetch(
    `/api/reviews?status=pending&taskId=${encodeURIComponent(task.id)}`,
  )
  await expectHttp(pendingReviewsResponse, 200, 'list pending reviews after shard failure')
  expect((await pendingReviewsResponse.json()) as ReviewSummaryRow[]).toEqual([])
})
