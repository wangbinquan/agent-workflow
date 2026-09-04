// End-to-end workflow catalog.
//
// Every definition under examples/workflows/e2e is loaded through the public
// POST /api/workflows endpoint (see workflow-fixtures.ts — the bare-YAML import
// endpoint was retired by RFC-271 batch I), validated at an exact revision, and
// (except for the intentional static-invalid fixture) launched via POST /api/tasks.
// Execution uses the real daemon, SQLite, scheduler, wrapper scopes, git
// worktrees and output parser. Only the external model is replaced by the
// deterministic MATRIX_* OpenCode stub.

import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'
import { loadWorkflowFixture } from './workflow-fixtures'

const HERE = dirname(fileURLToPath(import.meta.url))
const CATALOG_DIR = join(HERE, '..', 'examples', 'workflows', 'e2e')

const CATALOG_FILES = [
  'prompt-input-kinds.yaml',
  'upload-input-roundtrip.yaml',
  'upload-input-overwrite.yaml',
  'output-kinds-roundtrip.yaml',
  'linear-fan-in.yaml',
  'wrapper-git-change-set.yaml',
  'wrapper-git-noop.yaml',
  'wrapper-loop-port-empty.yaml',
  'wrapper-loop-port-equals.yaml',
  'wrapper-loop-port-count-lt.yaml',
  'wrapper-fanout-aggregate.yaml',
  'wrapper-git-around-fanout.yaml',
  'wrapper-loop-around-fanout.yaml',
  'wrapper-loop-around-git.yaml',
  'wrapper-git-around-loop.yaml',
  'wrapper-git-around-git.yaml',
  'mixed-wrapper-human-roundtrip.yaml',
  'wrapper-loop-review.yaml',
  'clarify-self-roundtrip.yaml',
  'clarify-cross-agent-roundtrip.yaml',
  'wrapper-loop-exhausted.yaml',
  'wrapper-fanout-unsupported-inner.yaml',
  'wrapper-loop-nested.yaml',
  'wrapper-nested-depth3.yaml',
  'runtime-lifecycle.yaml',
] as const

type CatalogFile = (typeof CATALOG_FILES)[number]

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
  failureCode?: string | null
  promptText: string | null
  /**
   * RFC-354 — the execution FRAME as the daemon projects it on the wire:
   * `containerRunId` is the wrapper GENERATION row this run hangs off and
   * `iteration` the round inside that frame, `scopePath` the derived
   * root→here breadcrumb (`outer_loop:1/inner_loop:0`). Nested wrappers make
   * the bare counter ambiguous — outer round 1's inner round 0 and outer
   * round 2's inner round 0 are both `iteration: 0` — so every nesting
   * assertion below reads the frame, not the counter.
   */
  containerRunId: string | null
  scopePath: string
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

interface ValidationIssue {
  code: string
  severity?: 'error' | 'warning'
}

interface ValidationReceipt {
  ok: boolean
  issues: ValidationIssue[]
}

interface ReviewSummaryRow {
  nodeRunId: string
  taskId: string
  reviewIteration: number
  awaitingReview: boolean
}

interface ClarifySummaryRow {
  kind: 'self' | 'cross'
  taskId: string
  askingNodeId: string
  targetConsumerNodeId: string | null
  intermediaryNodeRunId: string
  iteration: number
  questionCount: number
}

const AGENT_FIXTURES = [
  {
    name: 'matrix-source-a',
    outputs: ['part'],
    outputKinds: { part: 'string' },
    readonly: true,
  },
  {
    name: 'matrix-source-b',
    outputs: ['part'],
    outputKinds: { part: 'string' },
    readonly: true,
  },
  {
    name: 'matrix-merge',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
  },
  {
    name: 'matrix-mutator',
    outputs: ['note'],
    outputKinds: { note: 'string' },
    readonly: false,
  },
  {
    name: 'matrix-summarizer',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
  },
  {
    name: 'matrix-loop-worker',
    outputs: ['status', 'items'],
    outputKinds: { status: 'string', items: 'list<string>' },
    readonly: false,
  },
  {
    name: 'matrix-nested-worker',
    outputs: ['status', 'outer_status'],
    outputKinds: { status: 'string', outer_status: 'string' },
    readonly: true,
  },
  {
    name: 'matrix-depth3-worker',
    outputs: ['status'],
    outputKinds: { status: 'string' },
    readonly: false,
  },
  {
    name: 'matrix-fanout-worker',
    outputs: ['finding'],
    outputKinds: { finding: 'markdown' },
    readonly: true,
  },
  {
    name: 'matrix-fanout-aggregator',
    outputs: ['report'],
    outputKinds: { report: 'markdown' },
    outputWrapperPortNames: { report: 'final_report' },
    role: 'aggregator',
    readonly: true,
  },
  {
    name: 'matrix-review-writer',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
  },
  {
    name: 'matrix-self-clarifier',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
  },
  {
    name: 'matrix-cross-designer',
    outputs: ['design'],
    outputKinds: { design: 'markdown' },
    readonly: true,
  },
  {
    name: 'matrix-cross-questioner',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
  },
  {
    name: 'matrix-prompt-auditor',
    outputs: ['report'],
    outputKinds: { report: 'string' },
    readonly: true,
  },
  {
    name: 'matrix-upload-reader',
    outputs: ['report'],
    outputKinds: { report: 'string' },
    readonly: true,
  },
  {
    name: 'matrix-output-kinds',
    outputs: ['text', 'markdown', 'file', 'names', 'documents', 'files', 'done_signal'],
    outputKinds: {
      text: 'string',
      markdown: 'markdown',
      file: 'path<md>',
      names: 'list<string>',
      documents: 'list<markdown>',
      files: 'list<path<md>>',
      done_signal: 'signal',
    },
    readonly: false,
  },
  {
    name: 'matrix-noop',
    outputs: ['note'],
    outputKinds: { note: 'string' },
    readonly: true,
  },
  {
    name: 'matrix-fanout-mutator',
    outputs: ['finding'],
    outputKinds: { finding: 'markdown' },
    readonly: false,
  },
  {
    name: 'matrix-loop-fanout-aggregator',
    outputs: ['status', 'report'],
    outputKinds: { status: 'string', report: 'markdown' },
    outputWrapperPortNames: { status: 'status', report: 'report' },
    role: 'aggregator',
    readonly: true,
  },
  {
    name: 'matrix-runtime',
    outputs: ['result'],
    outputKinds: { result: 'string' },
    readonly: true,
  },
  {
    name: 'matrix-mixed-writer',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: false,
  },
  {
    name: 'matrix-mixed-auditor',
    outputs: ['finding'],
    outputKinds: { finding: 'markdown' },
    readonly: true,
  },
  {
    name: 'matrix-mixed-summary',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
  },
] as const

let daemon: DaemonHandle
let repoDir: string
let matrixStateDir: string
let taskSequence = 0
const workflows = new Map<CatalogFile, WorkflowRow>()

test.setTimeout(180_000)

test.beforeAll(async () => {
  matrixStateDir = mkdtempSync(join(tmpdir(), 'aw-workflow-matrix-state-'))
  daemon = await startDaemon({
    stubMode: 'workflow-matrix',
    extraEnv: { MATRIX_STATE_DIR: matrixStateDir },
    configOverrides: {
      defaultNodeRetries: 1,
      // RFC-313: 本处钉住重试预算是为了断言 attempt 次数。attempt 上限现在是两个预算的
      // **乘积** (1+defaultNodeRetries)×(1+sessionRestartBudget)，重启预算默认 1 会让这些
      // 计数全部翻倍；置 0 即退化成 1+defaultNodeRetries，逐字等于 RFC-313 落地前。
      sessionRestartBudget: 0,
      defaultPerNodeTimeoutMs: 2_000,
    },
  })

  repoDir = mkdtempSync(join(tmpdir(), 'aw-workflow-matrix-repo-'))
  mkdirSync(join(repoDir, 'docs'), { recursive: true })
  writeFileSync(join(repoDir, 'README.md'), '# workflow matrix fixture\n')
  writeFileSync(join(repoDir, 'docs', 'a.md'), '# A\n')
  writeFileSync(join(repoDir, 'docs', 'b.md'), '# B\n')
  writeFileSync(join(repoDir, 'docs', 'c.md'), '# C\n')
  writeFileSync(join(repoDir, 'docs', 'fail.md'), '# intentional failure shard\n')
  initGitRepo(repoDir)

  for (const fixture of AGENT_FIXTURES) {
    const res = await apiFetch('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        ...fixture,
        description: `workflow matrix fixture: ${fixture.name}`,
        bodyMd: 'Deterministic agent used by the workflow end-to-end catalog.',
      }),
    })
    await expectHttp(res, 201, `create agent ${fixture.name}`)
  }

  for (const file of CATALOG_FILES) {
    // RFC-271 批次 I 下线了 `POST /api/workflows/import`；fixture 装载改走公开的
    // `POST /api/workflows`，见 `workflow-fixtures.ts` 的说明。
    workflows.set(file, await loadWorkflowFixture<WorkflowRow>(apiFetch, join(CATALOG_DIR, file)))
  }
})

test.afterAll(async () => {
  try {
    rmSync(repoDir, { recursive: true, force: true })
  } catch {
    // best-effort fixture cleanup
  }
  try {
    rmSync(matrixStateDir, { recursive: true, force: true })
  } catch {
    // best-effort fixture cleanup
  }
  if (daemon !== undefined) await daemon.stop()
})

function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...(init.body === undefined || isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
}

async function expectHttp(res: Response, expected: number, what: string): Promise<void> {
  if (res.status === expected) return
  throw new Error(`${what}: expected HTTP ${expected}, got ${res.status}: ${await res.text()}`)
}

function workflow(file: CatalogFile): WorkflowRow {
  const row = workflows.get(file)
  if (row === undefined) throw new Error(`workflow fixture not imported: ${file}`)
  return row
}

async function validate(file: CatalogFile): Promise<ValidationReceipt> {
  const row = workflow(file)
  const res = await apiFetch(`/api/workflows/${row.id}/validate`, {
    method: 'POST',
    body: JSON.stringify({
      expectedVersion: row.version,
      expectedSnapshotHash: row.snapshotHash,
    }),
  })
  await expectHttp(res, 200, `validate ${file}`)
  return (await res.json()) as ValidationReceipt
}

async function launch(
  file: CatalogFile,
  inputs: Record<string, string> = {},
): Promise<{ response: Response; task?: TaskRow }> {
  taskSequence += 1
  const row = workflow(file)
  const response = await apiFetch('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workflowId: row.id,
      expectedWorkflowVersion: row.version,
      name: `matrix-${taskSequence}-${row.name}`,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs,
    }),
  })
  if (!response.ok) return { response }
  return { response, task: (await response.json()) as TaskRow }
}

async function launchOk(file: CatalogFile, inputs: Record<string, string> = {}): Promise<TaskRow> {
  const result = await launch(file, inputs)
  await expectHttp(result.response, 201, `launch ${file}`)
  if (result.task === undefined) throw new Error(`launch ${file} returned no task`)
  return result.task
}

async function launchMultipart(
  file: CatalogFile,
  inputs: Record<string, string>,
  files: Array<{ inputKey: string; filename: string; content: string; type: string }>,
): Promise<{ response: Response; task?: TaskRow }> {
  taskSequence += 1
  const row = workflow(file)
  const form = new FormData()
  form.append(
    'payload',
    JSON.stringify({
      workflowId: row.id,
      expectedWorkflowVersion: row.version,
      name: `matrix-${taskSequence}-${row.name}`,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs,
    }),
  )
  for (const filePart of files) {
    form.append(
      `files[${filePart.inputKey}][]`,
      new Blob([filePart.content], { type: filePart.type }),
      filePart.filename,
    )
  }
  const response = await apiFetch('/api/tasks', { method: 'POST', body: form })
  if (!response.ok) return { response }
  return { response, task: (await response.json()) as TaskRow }
}

async function waitForTask(
  taskId: string,
  predicate: (task: TaskRow) => boolean,
  timeoutMs = 45_000,
): Promise<TaskRow> {
  const deadline = Date.now() + timeoutMs
  let last: TaskRow = { id: taskId, status: 'pending' }
  while (Date.now() < deadline) {
    const res = await apiFetch(`/api/tasks/${taskId}`)
    if (res.ok) {
      last = (await res.json()) as TaskRow
      if (predicate(last)) return last
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `task ${taskId} did not reach expected state in ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  )
}

async function waitForTerminal(taskId: string): Promise<TaskRow> {
  const terminal = new Set(['done', 'failed', 'canceled', 'interrupted', 'exhausted'])
  return waitForTask(taskId, (task) => terminal.has(task.status))
}

async function nodeRuns(taskId: string): Promise<NodeRunsResponse> {
  const res = await apiFetch(`/api/tasks/${taskId}/node-runs`)
  await expectHttp(res, 200, `node runs for ${taskId}`)
  return (await res.json()) as NodeRunsResponse
}

async function waitForClarify(
  taskId: string,
  kind: ClarifySummaryRow['kind'],
  timeoutMs = 15_000,
): Promise<ClarifySummaryRow> {
  const deadline = Date.now() + timeoutMs
  let last: ClarifySummaryRow[] = []
  while (Date.now() < deadline) {
    const res = await apiFetch(
      `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
    )
    if (res.ok) {
      last = (await res.json()) as ClarifySummaryRow[]
      const row = last.find((candidate) => candidate.kind === kind)
      if (row !== undefined) return row
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`no ${kind} clarify round for ${taskId}; last=${JSON.stringify(last)}`)
}

async function waitForReview(
  taskId: string,
  minimumIteration = 0,
  timeoutMs = 15_000,
): Promise<ReviewSummaryRow> {
  const deadline = Date.now() + timeoutMs
  let last: ReviewSummaryRow[] = []
  while (Date.now() < deadline) {
    const res = await apiFetch('/api/reviews?status=pending')
    if (res.ok) {
      last = (await res.json()) as ReviewSummaryRow[]
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

async function answerClarify(row: ClarifySummaryRow, questionId: string): Promise<void> {
  const res = await apiFetch(`/api/clarify/${row.intermediaryNodeRunId}/answers`, {
    method: 'POST',
    body: JSON.stringify({
      answers: [
        {
          questionId,
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
        },
      ],
      directive: 'stop',
      ifMatchIteration: row.iteration,
    }),
  })
  await expectHttp(res, 200, `answer ${row.kind} clarify`)
}

function runsFor(data: NodeRunsResponse, nodeId: string): NodeRunRow[] {
  return data.runs.filter((run) => run.nodeId === nodeId)
}

function onlyRun(data: NodeRunsResponse, nodeId: string): NodeRunRow {
  const rows = runsFor(data, nodeId)
  expect(rows, `expected exactly one run for ${nodeId}`).toHaveLength(1)
  return rows[0]!
}

function outputValue(data: NodeRunsResponse, runId: string, port: string): string | undefined {
  return data.outputs.find((output) => output.nodeRunId === runId && output.port === port)?.value
}

/** A path-list port (`git_diff` and friends) as a sorted array. */
function pathsOf(data: NodeRunsResponse, runId: string, port: string): string[] {
  return (outputValue(data, runId, port) ?? '')
    .split('\n')
    .filter((path) => path.length > 0)
    .sort()
}

/** RFC-354 — a run's frame: the generation row it hangs off plus its round. */
function frameKey(run: NodeRunRow): string {
  return `${run.containerRunId ?? 'top'}#${run.iteration}`
}

function sorted(values: readonly (string | null)[]): (string | null)[] {
  return [...values].sort()
}

test('catalog: every YAML imports; runnable definitions validate; a wrapper inside a fan-out is rejected statically', async () => {
  // RFC-354: loop-in-loop validates like any other nesting (the RFC-094
  // `wrapper-loop-nested` ban is retired), while the fan-out body rule moved
  // from a runtime failure to a schema-time error.
  const staticallyValid = CATALOG_FILES.filter(
    (file) => file !== 'wrapper-fanout-unsupported-inner.yaml',
  )
  for (const file of staticallyValid) {
    const receipt = await validate(file)
    const errors = receipt.issues.filter((issue) => (issue.severity ?? 'error') === 'error')
    expect(errors, `${file} validation errors`).toEqual([])
    expect(receipt.ok, `${file} validation result`).toBe(true)
  }

  const invalid = await validate('wrapper-fanout-unsupported-inner.yaml')
  expect(invalid.ok).toBe(false)
  expect(invalid.issues.map((issue) => issue.code)).toContain(
    'wrapper-fanout-unsupported-inner-kind',
  )
  expect(invalid.issues.map((issue) => issue.code)).not.toContain('wrapper-loop-nested')
})

test('workflow launch input contract rejects missing, unknown, and picker-incompatible values', async () => {
  const valid = {
    explicit_text: 'literal {{auto_text}}',
    auto_text: 'auto-appended',
    files: 'docs/a.md\ndocs/b.md',
    mode: 'thorough',
    tags: '["api","docs"]',
    branch: '{"kind":"branch","ref":"main"}',
  }
  const cases: Array<{
    label: string
    inputs: Record<string, string>
    issue: string
  }> = [
    {
      label: 'missing required',
      inputs: { ...valid, explicit_text: '' },
      issue: 'required-input-missing',
    },
    {
      label: 'unknown key',
      inputs: { ...valid, stale: 'invisible' },
      issue: 'unknown-input',
    },
    {
      label: 'enum outside choices',
      inputs: { ...valid, mode: 'hidden' },
      issue: 'enum-value-invalid',
    },
    {
      label: 'files below minCount',
      inputs: { ...valid, files: 'docs/a.md' },
      issue: 'input-count-too-small',
    },
    {
      label: 'malformed git picker value',
      inputs: { ...valid, branch: '{"kind":"branch","ref":""}' },
      issue: 'git-value-invalid',
    },
  ]

  for (const scenario of cases) {
    const result = await launch('prompt-input-kinds.yaml', scenario.inputs)
    expect(result.response.status, scenario.label).toBe(422)
    const body = (await result.response.json()) as {
      code: string
      details?: { issues?: Array<{ code: string }> }
    }
    expect(body.code, scenario.label).toBe('workflow-inputs-invalid')
    expect(
      body.details?.issues?.map((issue) => issue.code),
      scenario.label,
    ).toContain(scenario.issue)
    expect(result.task).toBeUndefined()
  }
})

test('prompt injection: all non-upload input kinds, auto-append, built-ins, and literal tokens arrive once', async () => {
  const task = await launchOk('prompt-input-kinds.yaml', {
    explicit_text: 'literal {{auto_text}}',
    auto_text: 'auto-appended',
    files: 'docs/a.md\ndocs/b.md',
    mode: 'thorough',
    tags: '["api","docs"]',
    branch: '{"kind":"branch","ref":"main"}',
  })
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const auditor = onlyRun(data, 'prompt_auditor')
  expect(auditor.promptText).toContain('literal {{auto_text}}')
  expect(auditor.promptText).toContain('## auto_text')
  expect(auditor.promptText).toContain('## files')
  expect(auditor.promptText).toContain('## tags')
  expect(auditor.promptText).toContain('## branch')
  expect(auditor.promptText).toContain('node=prompt_auditor')
  expect(auditor.promptText).toContain('iteration=0')
  expect(auditor.promptText).toContain('repo_count=1')
  expect(auditor.promptText).not.toContain('task={{__task_id__}}')
  expect(outputValue(data, auditor.id, 'report')).toBe('prompt-input-context-ok')
})

test('upload input: multipart files land before dispatch and their packed paths reach the prompt', async () => {
  const result = await launchMultipart('upload-input-roundtrip.yaml', {}, [
    {
      inputKey: 'attachments',
      filename: 'one.md',
      content: '# upload one\n',
      type: 'text/markdown',
    },
    {
      inputKey: 'attachments',
      filename: 'two.md',
      content: '# upload two\n',
      type: 'text/markdown',
    },
  ])
  await expectHttp(result.response, 201, 'launch upload-input-roundtrip.yaml')
  if (result.task === undefined) throw new Error('multipart launch returned no task')
  const final = await waitForTerminal(result.task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(result.task.id)
  const reader = onlyRun(data, 'upload_reader')
  expect(reader.promptText).toContain('matrix-uploads/one.md')
  expect(reader.promptText).toContain('matrix-uploads/two.md')
  expect(outputValue(data, reader.id, 'report')).toBe('upload-roundtrip-ok')
})

// RFC-262: the whole point of `onConflict: overwrite` is that the packed path
// keeps the ORIGINAL name, so repo-internal references to it resolve to what
// the user just uploaded. `docs/a.md` is committed in the fixture repo above.
test('upload input (overwrite): the uploaded file replaces the committed repo file, keeping its path', async () => {
  const result = await launchMultipart('upload-input-overwrite.yaml', {}, [
    {
      inputKey: 'spec',
      filename: 'a.md',
      content: '# uploaded-overwrite\n',
      type: 'text/markdown',
    },
  ])
  await expectHttp(result.response, 201, 'launch upload-input-overwrite.yaml')
  if (result.task === undefined) throw new Error('multipart launch returned no task')
  const final = await waitForTerminal(result.task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(result.task.id)
  const reader = onlyRun(data, 'overwrite_reader')
  expect(reader.promptText).toContain('docs/a.md')
  expect(reader.promptText).not.toContain('docs/a (1).md')
  // The stub asserted on disk that the committed content is gone and that no
  // renamed copy exists; reaching this port means both held.
  expect(outputValue(data, reader.id, 'report')).toBe('upload-overwrite-ok')
})

test('output kinds: scalar, markdown, path, list, list-path, list-markdown, and signal round-trip', async () => {
  const task = await launchOk('output-kinds-roundtrip.yaml')
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const producer = onlyRun(data, 'kind_producer')
  expect(outputValue(data, producer.id, 'text')).toBe('plain-value')
  expect(outputValue(data, producer.id, 'markdown')).toBe('# Inline document')
  expect(outputValue(data, producer.id, 'file')).toBe('matrix-generated/kinds/one.md')
  expect(outputValue(data, producer.id, 'names')).toBe('alpha\nbeta')
  expect(outputValue(data, producer.id, 'documents')).toBe(
    '# First document\n<!-- @@aw-doc-boundary@@ -->\n# Second document',
  )
  expect(outputValue(data, producer.id, 'files')).toBe(
    'matrix-generated/kinds/one.md\nmatrix-generated/kinds/two.md',
  )
  expect(outputValue(data, producer.id, 'done_signal')).toBe('')

  const projected = onlyRun(data, 'final_output')
  const projectedKinds = new Map(
    data.outputs
      .filter((output) => output.nodeRunId === projected.id)
      .map((output) => [output.port, output.kind]),
  )
  expect(projectedKinds).toEqual(
    new Map([
      ['text', 'string'],
      ['markdown', 'markdown'],
      ['file', 'path<md>'],
      ['names', 'list<string>'],
      ['documents', 'list<markdown>'],
      ['files', 'list<path<md>>'],
      ['done_signal', 'signal'],
    ]),
  )
})

test('linear DAG: parallel branches fan in deterministically and surface an output', async () => {
  const task = await launchOk('linear-fan-in.yaml', { topic: 'wrapper semantics' })
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  expect(runsFor(data, 'source_a')).toHaveLength(1)
  expect(runsFor(data, 'source_b')).toHaveLength(1)
  const merge = onlyRun(data, 'merge')
  expect(merge.promptText).toContain('alpha-fragment')
  expect(merge.promptText).toContain('beta-fragment')
  expect(merge.promptText).toContain('---')
  expect(outputValue(data, merge.id, 'answer')).toBe('merged-alpha-beta')
})

test('wrapper-git: waits for its external input, captures both changed paths, and feeds downstream', async () => {
  const task = await launchOk('wrapper-git-change-set.yaml', {
    change_request: 'create source and documentation',
  })
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const wrapper = onlyRun(data, 'git_wrap')
  expect(wrapper.status).toBe('done')
  const changed = outputValue(data, wrapper.id, 'git_diff')
  expect(changed).toContain('matrix-generated/source.txt')
  expect(changed).toContain('matrix-generated/docs/report.md')

  const summary = onlyRun(data, 'summarize')
  expect(summary.promptText).toContain('matrix-generated/source.txt')
  expect(summary.promptText).toContain('matrix-generated/docs/report.md')
  expect(outputValue(data, summary.id, 'answer')).toBe('git-summary-complete')
})

test('wrapper-git: a successful no-op inner scope completes with an empty generated diff', async () => {
  const task = await launchOk('wrapper-git-noop.yaml')
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const wrapper = onlyRun(data, 'git_wrap')
  expect(wrapper.status).toBe('done')
  expect(runsFor(data, 'observer')).toHaveLength(1)
  expect(outputValue(data, wrapper.id, 'git_diff')).toBe('')
})

for (const scenario of [
  {
    file: 'wrapper-loop-port-empty.yaml',
    port: 'final_status',
    expected: '',
  },
  {
    file: 'wrapper-loop-port-equals.yaml',
    port: 'final_status',
    expected: 'done',
  },
  {
    file: 'wrapper-loop-port-count-lt.yaml',
    port: 'final_items',
    expected: 'only-one',
  },
] as const) {
  test(`${scenario.file}: exits after two iterations and promotes the terminal port`, async () => {
    const task = await launchOk(scenario.file, { goal: 'converge' })
    const final = await waitForTerminal(task.id)
    expect(final.status).toBe('done')

    const data = await nodeRuns(task.id)
    const wrapper = onlyRun(data, 'loop_wrap')
    expect(wrapper.status).toBe('done')
    const workerRuns = runsFor(data, 'loop_worker')
    expect(workerRuns.map((run) => run.iteration)).toEqual([0, 1])
    expect(workerRuns.every((run) => run.status === 'done')).toBe(true)
    expect(outputValue(data, wrapper.id, scenario.port)).toBe(scenario.expected)
  })
}

test('wrapper-fanout: shards paths, broadcasts context, joins, aggregates, and renames output', async () => {
  const task = await launchOk('wrapper-fanout-aggregate.yaml', {
    docs: 'docs/a.md\ndocs/b.md\ndocs/c.md',
    context: 'shared-policy',
  })
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const wrapper = onlyRun(data, 'fan_wrap')
  const workers = runsFor(data, 'fan_worker')
  expect(workers).toHaveLength(3)
  expect(workers.every((run) => run.parentNodeRunId === wrapper.id)).toBe(true)
  expect(workers.map((run) => run.shardKey).sort()).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md'])
  expect(
    workers.every((run) => run.promptText?.includes('shared-policy') === true),
    `worker prompts: ${JSON.stringify(workers.map((run) => run.promptText))}`,
  ).toBe(true)

  const aggregator = onlyRun(data, 'fan_aggregator')
  expect(aggregator.parentNodeRunId).toBe(wrapper.id)
  expect(aggregator.shardKey).toBeNull()
  expect(aggregator.promptText).toContain('finding:docs/a.md')
  expect(aggregator.promptText).toContain('finding:docs/b.md')
  expect(aggregator.promptText).toContain('finding:docs/c.md')
  expect(outputValue(data, wrapper.id, 'final_report')).toBe('aggregated-fanout-report')
})

test('wrapper-fanout: empty shard source completes without minting inner rows', async () => {
  const task = await launchOk('wrapper-fanout-aggregate.yaml', {
    docs: '',
    context: 'empty-case',
  })
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const wrapper = onlyRun(data, 'fan_wrap')
  expect(wrapper.status).toBe('done')
  expect(runsFor(data, 'fan_worker')).toEqual([])
  expect(runsFor(data, 'fan_aggregator')).toEqual([])
  expect(outputValue(data, wrapper.id, 'final_report')).toBe('')
})

test('wrapper-fanout: one failed shard waits for the join and fails the wrapper without aggregation', async () => {
  const task = await launchOk('wrapper-fanout-aggregate.yaml', {
    docs: 'docs/a.md\ndocs/fail.md\ndocs/c.md',
    context: 'failure-case',
  })
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('failed')

  const data = await nodeRuns(task.id)
  const wrapper = onlyRun(data, 'fan_wrap')
  expect(wrapper.status).toBe('failed')
  expect(wrapper.errorMessage).toContain('inner-shard-failed')
  const workers = runsFor(data, 'fan_worker')
  expect(new Set(workers.map((run) => run.shardKey))).toEqual(
    new Set(['docs/a.md', 'docs/fail.md', 'docs/c.md']),
  )
  expect(workers.some((run) => run.status === 'failed')).toBe(true)
  expect(workers.filter((run) => run.status === 'done')).toHaveLength(2)
  expect(runsFor(data, 'fan_aggregator')).toEqual([])
})

test('wrapper-fanout: duplicate source values receive distinct stable shard keys and both reach aggregation', async () => {
  const task = await launchOk('wrapper-fanout-aggregate.yaml', {
    docs: 'docs/a.md\ndocs/a.md',
    context: 'duplicate-case',
  })
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const workers = runsFor(data, 'fan_worker')
  expect(workers).toHaveLength(2)
  expect(workers.map((run) => run.shardKey).sort()).toEqual(['docs/a.md', 'docs/a.md#1'])
  const aggregator = onlyRun(data, 'fan_aggregator')
  expect(aggregator.promptText).toContain('### docs/a.md')
  expect(aggregator.promptText).toContain('### docs/a.md#1')
})

test('nested wrappers: git around fanout merges every shard change before computing one outer diff', async () => {
  const task = await launchOk('wrapper-git-around-fanout.yaml', {
    docs: 'docs/a.md\ndocs/b.md',
  })
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const git = onlyRun(data, 'git_wrap')
  const fanout = onlyRun(data, 'fan_wrap')
  expect(fanout.parentNodeRunId).toBeNull()
  const workers = runsFor(data, 'fan_mutator')
  expect(workers).toHaveLength(2)
  expect(workers.every((run) => run.parentNodeRunId === fanout.id)).toBe(true)
  const changed = outputValue(data, git.id, 'git_diff')
  expect(changed).toContain('matrix-generated/fanout/a.txt')
  expect(changed).toContain('matrix-generated/fanout/b.txt')

  // RFC-354 frames: the git wrapper is a top-scope row, the fan-out hangs off
  // it, and the shards hang off the fan-out — a two-level containment chain
  // read root→here. The two shards share ONE frame (same generation, same
  // round) and are told apart by `shardKey`, never by the frame.
  expect(git.containerRunId).toBeNull()
  expect(git.scopePath).toBe('')
  expect(fanout.containerRunId).toBe(git.id)
  expect(fanout.scopePath).toBe('git_wrap:0')
  const aggregator = onlyRun(data, 'fan_aggregator')
  for (const run of [...workers, aggregator]) {
    expect(run.containerRunId).toBe(fanout.id)
    expect(run.scopePath).toBe('git_wrap:0/fan_wrap:0')
  }
  expect(new Set(workers.map(frameKey)).size).toBe(1)
})

test('nested wrappers: loop around fanout uses only the current generation for exit and output promotion', async () => {
  const task = await launchOk('wrapper-loop-around-fanout.yaml', {
    docs: 'docs/a.md\ndocs/b.md',
    goal: 'converge every document',
  })
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const loop = onlyRun(data, 'loop_wrap')
  expect(runsFor(data, 'fan_wrap').map((run) => run.iteration)).toEqual([0, 1])
  expect(runsFor(data, 'fan_worker')).toHaveLength(4)
  expect(runsFor(data, 'fan_aggregator').map((run) => run.iteration)).toEqual([0, 1])
  expect(outputValue(data, loop.id, 'final_status')).toBe('done')
  expect(outputValue(data, loop.id, 'final_report')).toBe('fanout-generation-1')

  // RFC-354 frames: each loop round opens its OWN fan-out generation, and a
  // round's shards hang off that round's generation row. Without the frame the
  // two rounds' shard rows collide on (nodeId, iteration, shardKey).
  const fanoutGenerations = runsFor(data, 'fan_wrap')
  expect(fanoutGenerations.every((run) => run.containerRunId === loop.id)).toBe(true)
  expect(sorted(fanoutGenerations.map((run) => run.scopePath))).toEqual([
    'loop_wrap:0',
    'loop_wrap:1',
  ])
  const shards = runsFor(data, 'fan_worker')
  for (const generation of fanoutGenerations) {
    const inGeneration = shards.filter((run) => run.containerRunId === generation.id)
    expect(sorted(inGeneration.map((run) => run.shardKey))).toEqual(['docs/a.md', 'docs/b.md'])
    expect(
      inGeneration.every(
        (run) =>
          run.scopePath === `loop_wrap:${generation.iteration}/fan_wrap:${generation.iteration}`,
      ),
    ).toBe(true)
  }
  expect(new Set(shards.map(frameKey)).size).toBe(2)
})

test('nested wrappers: git inside loop exposes only the last iteration diff', async () => {
  const task = await launchOk('wrapper-loop-around-git.yaml')
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const loop = onlyRun(data, 'loop_wrap')
  expect(runsFor(data, 'git_wrap').map((run) => run.iteration)).toEqual([0, 1])
  expect(runsFor(data, 'mutator').map((run) => run.iteration)).toEqual([0, 1])
  const lastChanged = outputValue(data, loop.id, 'last_changed')
  expect(lastChanged).toContain('matrix-generated/nested/iter-1.txt')
  expect(lastChanged).not.toContain('matrix-generated/nested/iter-0.txt')
  expect(outputValue(data, loop.id, 'final_status')).toBe('done')

  // RFC-354 frames: every round opens a fresh git generation, and that round's
  // mutator hangs off ITS generation — which is what makes the diff above a
  // per-round change set rather than a running union. The checker is a direct
  // loop member, so it stays in the loop's own frame one level up.
  const gitGenerations = runsFor(data, 'git_wrap')
  expect(gitGenerations.every((run) => run.containerRunId === loop.id)).toBe(true)
  expect(sorted(gitGenerations.map((run) => run.scopePath))).toEqual(['loop_wrap:0', 'loop_wrap:1'])
  const mutators = runsFor(data, 'mutator')
  expect(sorted(mutators.map((run) => run.containerRunId))).toEqual(
    sorted(gitGenerations.map((run) => run.id)),
  )
  expect(sorted(mutators.map((run) => run.scopePath))).toEqual([
    'loop_wrap:0/git_wrap:0',
    'loop_wrap:1/git_wrap:1',
  ])
  expect(runsFor(data, 'checker').every((run) => run.containerRunId === loop.id)).toBe(true)
})

test('nested wrappers: loop inside git produces one cumulative full-loop diff', async () => {
  const task = await launchOk('wrapper-git-around-loop.yaml')
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const git = onlyRun(data, 'git_wrap')
  expect(runsFor(data, 'loop_wrap')).toHaveLength(1)
  expect(runsFor(data, 'mutator').map((run) => run.iteration)).toEqual([0, 1])
  const allChanged = outputValue(data, git.id, 'git_diff')
  expect(allChanged).toContain('matrix-generated/nested/iter-0.txt')
  expect(allChanged).toContain('matrix-generated/nested/iter-1.txt')

  // RFC-354 frames: the mirror image of git-in-loop — ONE loop generation for
  // the whole git scope, with both rounds inside it. Same node ids, same
  // counters, opposite containment; only the frame tells the two shapes apart.
  const loop = onlyRun(data, 'loop_wrap')
  expect(git.containerRunId).toBeNull()
  expect(loop.containerRunId).toBe(git.id)
  expect(loop.scopePath).toBe('git_wrap:0')
  const bodyRuns = [...runsFor(data, 'mutator'), ...runsFor(data, 'checker')]
  expect(bodyRuns.every((run) => run.containerRunId === loop.id)).toBe(true)
  expect(sorted(runsFor(data, 'mutator').map((run) => run.scopePath))).toEqual([
    'git_wrap:0/loop_wrap:0',
    'git_wrap:0/loop_wrap:1',
  ])
})

test('nested wrappers: git inside git preserves the complete mutation at both boundaries', async () => {
  const task = await launchOk('wrapper-git-around-git.yaml')
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const outer = onlyRun(data, 'outer_git')
  const inner = onlyRun(data, 'inner_git')
  const outerChanged = outputValue(data, outer.id, 'git_diff')
  const innerChanged = outputValue(data, inner.id, 'git_diff')
  for (const changed of [outerChanged, innerChanged]) {
    expect(changed).toContain('matrix-generated/source.txt')
    expect(changed).toContain('matrix-generated/docs/report.md')
  }

  // RFC-354 frames: two git wrappers with no loop anywhere still form a
  // containment chain, and the breadcrumb records it.
  expect(outer.containerRunId).toBeNull()
  expect(inner.containerRunId).toBe(outer.id)
  expect(inner.scopePath).toBe('outer_git:0')
  const mutator = onlyRun(data, 'mutator')
  expect(mutator.containerRunId).toBe(inner.id)
  expect(mutator.scopePath).toBe('outer_git:0/inner_git:0')
})

test('mixed wrappers + humans: clarified decision survives review rejection before fanout and final approval', async () => {
  const task = await launchOk('mixed-wrapper-human-roundtrip.yaml', {
    goal: 'ship the reviewed release',
  })

  const humanPark = await waitForTask(
    task.id,
    (row) => row.status === 'awaiting_human' || row.status === 'failed',
  )
  expect(humanPark.status).toBe('awaiting_human')
  const clarification = await waitForClarify(task.id, 'self')
  expect(clarification.askingNodeId).toBe('mixed_writer')
  await answerClarify(clarification, 'q-mixed')

  await waitForTask(task.id, (row) => row.status === 'awaiting_review' || row.status === 'failed')
  const firstReview = await waitForReview(task.id)
  const reject = await apiFetch(`/api/reviews/${firstReview.nodeRunId}/decision`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'rejected',
      rejectReason: 'preserve the clarified target and revise the implementation',
      reviewIteration: firstReview.reviewIteration,
    }),
  })
  await expectHttp(reject, 200, 'reject mixed inner review')

  const afterReject = await waitForTask(
    task.id,
    (row) =>
      row.status === 'awaiting_review' ||
      row.status === 'awaiting_human' ||
      row.status === 'failed',
  )
  const afterRejectRuns = await nodeRuns(task.id)
  expect(afterReject.status).toBe('awaiting_review')
  const secondReview = await waitForReview(task.id, firstReview.reviewIteration + 1)
  const revised = afterRejectRuns
  const writerRuns = runsFor(revised, 'mixed_writer').sort((a, b) => a.id.localeCompare(b.id))
  expect(writerRuns).toHaveLength(3)
  // RFC-131 aging intentionally removes old Q&A after the agent has emitted a
  // valid output. The resolved choice survives through Prior Output instead.
  expect(writerRuns[2]?.promptText).not.toContain('## Clarify Q&A')
  expect(writerRuns[2]?.promptText).not.toContain('answers above')
  expect(writerRuns[2]?.promptText).toContain('## Review Rejection')
  expect(writerRuns[2]?.promptText).toContain(
    'preserve the clarified target and revise the implementation',
  )
  expect(writerRuns[2]?.promptText).toContain('## Prior Output')
  expect(writerRuns[2]?.promptText).toContain('mixed-document-v1 target=staging')
  expect(writerRuns[2]?.promptText).toContain(
    'resolved context preserved in Prior Output or the resumed session',
  )
  expect(outputValue(revised, writerRuns[2]!.id, 'answer')).toBe('mixed-document-v2 target=staging')

  const approveInner = await apiFetch(`/api/reviews/${secondReview.nodeRunId}/decision`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'approved',
      reviewIteration: secondReview.reviewIteration,
    }),
  })
  await expectHttp(approveInner, 200, 'approve revised mixed inner review')

  const postInner = await waitForTask(
    task.id,
    (row) => row.status === 'awaiting_review' || row.status === 'failed',
  )
  if (postInner.status === 'failed') {
    const failedRuns = await nodeRuns(task.id)
    throw new Error(
      `mixed workflow failed after inner approval: ${JSON.stringify({
        taskError: postInner.errorMessage,
        runs: failedRuns.runs.map((run) => ({
          nodeId: run.nodeId,
          status: run.status,
          retryIndex: run.retryIndex,
          shardKey: run.shardKey,
          errorMessage: run.errorMessage,
        })),
      })}`,
    )
  }
  const finalReview = await waitForReview(task.id)
  const beforeFinalApproval = await nodeRuns(task.id)
  const git = onlyRun(beforeFinalApproval, 'git_wrap')
  const changed = outputValue(beforeFinalApproval, git.id, 'git_diff')
  expect(changed).toContain('matrix-generated/mixed/release.md')
  expect(changed).toContain('matrix-generated/mixed/checks.md')

  const auditRuns = runsFor(beforeFinalApproval, 'mixed_auditor')
  expect(auditRuns).toHaveLength(2)
  expect(auditRuns.every((run) => run.parentNodeRunId !== null)).toBe(true)
  expect(
    auditRuns.every(
      (run) =>
        run.promptText?.includes('ship the reviewed release') === true &&
        run.promptText?.includes('<aw-input name="shard-key"') === true &&
        run.promptText?.includes(`\n${run.shardKey}\n</aw-input>`) === true,
    ),
  ).toBe(true)
  expect(onlyRun(beforeFinalApproval, 'mixed_summary').promptText).toContain(
    'aggregated-fanout-report',
  )

  const approveFinal = await apiFetch(`/api/reviews/${finalReview.nodeRunId}/decision`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'approved',
      reviewIteration: finalReview.reviewIteration,
    }),
  })
  await expectHttp(approveFinal, 200, 'approve mixed final review')

  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')
  const data = await nodeRuns(task.id)
  const output = onlyRun(data, 'final_output')
  expect(outputValue(data, output.id, 'approved_summary')).toBe('mixed-release-summary')
  expect(outputValue(data, output.id, 'changed_files')).toContain(
    'matrix-generated/mixed/release.md',
  )
})

test('wrapper-loop review: awaiting_review bubbles, approval resumes the same wrapper, port-not-empty exits', async () => {
  const task = await launchOk('wrapper-loop-review.yaml', { topic: 'reviewed design' })
  const parked = await waitForTask(task.id, (row) => row.status === 'awaiting_review')
  expect(parked.status).toBe('awaiting_review')

  const pending = await waitForReview(task.id)

  const approve = await apiFetch(`/api/reviews/${pending.nodeRunId}/decision`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'approved',
      reviewIteration: pending.reviewIteration,
    }),
  })
  await expectHttp(approve, 200, 'approve wrapper review')

  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')
  const data = await nodeRuns(task.id)
  const loop = onlyRun(data, 'loop_wrap')
  expect(loop.status).toBe('done')
  expect(outputValue(data, loop.id, 'final_doc')).toContain('review-ready-document')
})

test('wrapper-loop review: rejection injects reason and prior output into the rerun, then a second approval exits', async () => {
  const task = await launchOk('wrapper-loop-review.yaml', { topic: 'reviewed revision' })
  await waitForTask(task.id, (row) => row.status === 'awaiting_review')
  const firstReview = await waitForReview(task.id)

  const reject = await apiFetch(`/api/reviews/${firstReview.nodeRunId}/decision`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'rejected',
      rejectReason: 'replace the first draft with the revised matrix',
      reviewIteration: firstReview.reviewIteration,
    }),
  })
  await expectHttp(reject, 200, 'reject first wrapper review')

  const secondReview = await waitForReview(task.id, firstReview.reviewIteration + 1)
  const mid = await nodeRuns(task.id)
  const writerRuns = runsFor(mid, 'writer').sort((a, b) => a.retryIndex - b.retryIndex)
  expect(writerRuns).toHaveLength(2)
  const rerun = writerRuns[1]!
  expect(rerun.promptText).toContain('## Review Rejection')
  expect(rerun.promptText).toContain('replace the first draft with the revised matrix')
  expect(rerun.promptText).toContain('## Prior Output')
  expect(rerun.promptText).toContain('review-ready-document-v1')
  expect(outputValue(mid, rerun.id, 'answer')).toBe('review-ready-document-v2')

  const approve = await apiFetch(`/api/reviews/${secondReview.nodeRunId}/decision`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'approved',
      reviewIteration: secondReview.reviewIteration,
    }),
  })
  await expectHttp(approve, 200, 'approve revised wrapper review')

  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')
  const data = await nodeRuns(task.id)
  const loop = onlyRun(data, 'loop_wrap')
  expect(outputValue(data, loop.id, 'final_doc')).toContain('review-ready-document-v2')
})

test('clarify: agent asks, the user stops ask-back, and the rerun publishes output', async () => {
  const task = await launchOk('clarify-self-roundtrip.yaml', { topic: 'delivery policy' })
  const parked = await waitForTask(
    task.id,
    (row) => row.status === 'awaiting_human' || row.status === 'failed',
  )
  expect(parked.status).toBe('awaiting_human')

  const round = await waitForClarify(task.id, 'self')
  expect(round.askingNodeId).toBe('self_clarifier')
  expect(round.questionCount).toBe(1)
  await answerClarify(round, 'q-self')

  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')
  const data = await nodeRuns(task.id)
  const runs = runsFor(data, 'self_clarifier')
  expect(runs).toHaveLength(2)
  // Sealing the clarification settles the original asking row before the
  // follow-up row publishes the final output.
  expect(runs.map((run) => run.status)).toEqual(['done', 'done'])
  expect(runs[1]?.promptText).toContain('## Clarify Q&A')
  expect(outputValue(data, runs[1]!.id, 'answer')).toBe('self-clarify-complete')
})

test('clarify-cross-agent: only the asker reruns with Q&A and the upstream designer stays stable', async () => {
  const task = await launchOk('clarify-cross-agent-roundtrip.yaml', {
    topic: 'cache consistency',
  })
  const parked = await waitForTask(
    task.id,
    (row) => row.status === 'awaiting_human' || row.status === 'failed',
  )
  expect(parked.status).toBe('awaiting_human')

  const round = await waitForClarify(task.id, 'cross')
  expect(round.askingNodeId).toBe('cross_questioner')
  expect(round.targetConsumerNodeId).toBe('cross_designer')
  expect(round.questionCount).toBe(1)
  await answerClarify(round, 'q-cross')

  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')
  const data = await nodeRuns(task.id)
  expect(runsFor(data, 'cross_designer')).toHaveLength(1)
  const questionerRuns = runsFor(data, 'cross_questioner')
  expect(questionerRuns).toHaveLength(2)
  expect(questionerRuns[1]?.promptText).toContain('## Clarify Q&A')
  expect(outputValue(data, questionerRuns[1]!.id, 'answer')).toBe('cross-clarify-complete')
})

test('wrapper-loop exhaustion is a terminal failure and preserves the exhausted wrapper row', async () => {
  const task = await launchOk('wrapper-loop-exhausted.yaml')
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('failed')

  const data = await nodeRuns(task.id)
  const loop = onlyRun(data, 'loop_wrap')
  expect(loop.status).toBe('exhausted')
  expect(loop.errorMessage).toContain('max iterations reached')
  expect(runsFor(data, 'loop_worker').map((run) => run.iteration)).toEqual([0, 1])
})

test('a wrapper inside a fan-out never starts: the launch gate rejects it with the exact issue', async () => {
  // RFC-354: the fan-out body rule moved from a runtime failure
  // (`v1-unsupported-inner-kind`) to the schema-time
  // `wrapper-fanout-unsupported-inner-kind`, so the task is refused before any
  // row is minted.
  const result = await launch('wrapper-fanout-unsupported-inner.yaml', { docs: 'docs/a.md' })
  expect(result.response.status).toBe(422)
  const body = (await result.response.json()) as {
    code: string
    details?: { issues?: ValidationIssue[] }
  }
  expect(body.code).toBe('workflow-invalid')
  expect(body.details?.issues?.map((issue) => issue.code)).toContain(
    'wrapper-fanout-unsupported-inner-kind',
  )
  expect(result.task).toBeUndefined()
})

test('runtime lifecycle: a fresh-session process retry fails once, then succeeds on the configured retry', async () => {
  const task = await launchOk('runtime-lifecycle.yaml', { mode: 'retry' })
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const runs = runsFor(data, 'runtime_worker').sort((a, b) => a.retryIndex - b.retryIndex)
  expect(runs).toHaveLength(2)
  expect(runs.map((run) => run.retryIndex)).toEqual([0, 1])
  expect(runs.map((run) => run.status)).toEqual(['failed', 'done'])
  expect(outputValue(data, runs[1]!.id, 'result')).toBe('retry-recovered')
})

test('runtime lifecycle: a permanent process failure exhausts the configured retry budget', async () => {
  const task = await launchOk('runtime-lifecycle.yaml', { mode: 'fail' })
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('failed')

  const data = await nodeRuns(task.id)
  const runs = runsFor(data, 'runtime_worker').sort((a, b) => a.retryIndex - b.retryIndex)
  expect(runs).toHaveLength(2)
  expect(runs.every((run) => run.status === 'failed')).toBe(true)
  expect(runs.every((run) => run.errorMessage?.includes('exited with code 13') === true)).toBe(true)
})

test('runtime lifecycle: the global per-node timeout is applied to every retry and ends in failure', async () => {
  const task = await launchOk('runtime-lifecycle.yaml', { mode: 'timeout' })
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('failed')

  const data = await nodeRuns(task.id)
  const runs = runsFor(data, 'runtime_worker').sort((a, b) => a.retryIndex - b.retryIndex)
  expect(runs).toHaveLength(2)
  expect(runs.every((run) => run.status === 'failed')).toBe(true)
  expect(
    runs.every((run) => run.errorMessage?.includes('node-timeout: exceeded 2000ms') === true),
  ).toBe(true)
})

test('runtime lifecycle: cancel interrupts a running subprocess and prevents output projection', async () => {
  const task = await launchOk('runtime-lifecycle.yaml', { mode: 'cancel' })
  await waitForTask(task.id, (row) => row.status === 'running')

  const cancel = await apiFetch(`/api/tasks/${task.id}/cancel`, { method: 'POST' })
  await expectHttp(cancel, 200, 'cancel runtime workflow')
  const final = await waitForTask(task.id, (row) => row.status === 'canceled')
  expect(final.status).toBe('canceled')

  const data = await nodeRuns(task.id)
  const runs = runsFor(data, 'runtime_worker')
  expect(runs).toHaveLength(1)
  expect(runs[0]?.status).toBe('canceled')
  expect(runsFor(data, 'final_output')).toEqual([])
})

// RFC-354 —— loop-in-loop, through the whole daemon.
//
// The RFC-094 static ban (`wrapper-loop-nested`) is retired, but "it launches"
// is not the claim: the claim is that EVERY outer round re-enters the inner
// scope in a fresh generation. Before frames, `node_runs` carried only a flat
// `iteration`, so the outer loop's second round found round 1's done rows under
// the same (nodeId, iteration) key and dispatched nothing — the inner agent ran
// twice where the topology promises four, silently (audit S-6, now flipped in
// packages/backend/tests/rfc354-nested-loop-frames.test.ts).
//
// Here the same claim is asserted against the compiled daemon, its SQLite rows
// and the public node-runs projection — with the stub itself as a second oracle:
// `MATRIX_NESTED_LOOP` ends the inner loop on every even call and the outer loop
// only on call 4, and exits 16 if a fifth call ever arrives.
test('loop-in-loop: every outer round opens a fresh inner generation, and the agent really runs four times', async () => {
  const task = await launchOk('wrapper-loop-nested.yaml')
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const outer = onlyRun(data, 'outer_loop')
  expect(outer.status).toBe('done')
  expect(outer.containerRunId).toBeNull()
  expect(outer.scopePath).toBe('')

  // One inner GENERATION per outer round, both hanging off the outer row.
  const inner = runsFor(data, 'inner_loop')
  expect(inner).toHaveLength(2)
  expect(inner.every((run) => run.status === 'done')).toBe(true)
  expect(inner.every((run) => run.containerRunId === outer.id)).toBe(true)
  expect(sorted(inner.map((run) => String(run.iteration)))).toEqual(['0', '1'])
  expect(sorted(inner.map((run) => run.scopePath))).toEqual(['outer_loop:0', 'outer_loop:1'])

  // outer 2 × inner 2 = 4 agent runs, two rounds inside EACH inner generation.
  const workers = runsFor(data, 'loop_worker')
  expect(workers).toHaveLength(4)
  expect(workers.every((run) => run.status === 'done')).toBe(true)
  for (const generation of inner) {
    const inGeneration = workers.filter((run) => run.containerRunId === generation.id)
    expect(sorted(inGeneration.map((run) => String(run.iteration)))).toEqual(['0', '1'])
  }
  expect(sorted(workers.map((run) => run.scopePath))).toEqual([
    'outer_loop:0/inner_loop:0',
    'outer_loop:0/inner_loop:1',
    'outer_loop:1/inner_loop:0',
    'outer_loop:1/inner_loop:1',
  ])
  // The four frames are all distinct — the bare counter alone is not (each
  // value appears twice), which is exactly why the frame exists.
  expect(new Set(workers.map(frameKey)).size).toBe(4)

  // `{{__iteration__}}` renders the FRAME-LOCAL round: the second generation
  // starts again at 0 instead of continuing to 2.
  for (const run of workers) {
    expect(run.promptText).toContain(`iteration=${run.iteration}`)
  }

  // The loop's return values are promoted from the generation that just ran:
  // the last one, whose worker answered `done` on both ports.
  expect(outputValue(data, outer.id, 'final_status')).toBe('done')
  expect(outputValue(data, outer.id, 'outer_signal')).toBe('done')
})

// RFC-354 —— depth 3 (`loop ⊃ git ⊃ loop ⊃ agent`), authored directly in the v6
// edge model (this fixture is also the catalog's only hand-written v6 document,
// so the import path is exercised without the upgrader in front of it).
//
// Two levels of nesting were already covered in five combinations; three is
// where "nests to any depth" stops being a rewording of "nests". It is also
// where a shortcut that walks to the nearest enclosing loop, or that keys the
// git wrapper's change set on the node id alone, stops working.
test('depth-3 nesting: each outer round opens its own git generation, inner generation and change set', async () => {
  const task = await launchOk('wrapper-nested-depth3.yaml')
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('done')

  const data = await nodeRuns(task.id)
  const outer = onlyRun(data, 'd3_outer')
  expect(outer.containerRunId).toBeNull()

  // Level 1 — one git generation per outer round.
  const gits = runsFor(data, 'd3_git')
  expect(gits).toHaveLength(2)
  expect(gits.every((run) => run.status === 'done')).toBe(true)
  expect(gits.every((run) => run.containerRunId === outer.id)).toBe(true)
  expect(sorted(gits.map((run) => run.scopePath))).toEqual(['d3_outer:0', 'd3_outer:1'])

  // Level 2 — one inner-loop generation per git generation.
  const inners = runsFor(data, 'd3_inner')
  expect(inners).toHaveLength(2)
  expect(sorted(inners.map((run) => run.containerRunId))).toEqual(sorted(gits.map((run) => run.id)))

  // Level 3 — the agent, breadcrumbed root→here through all three wrappers.
  const workers = runsFor(data, 'd3_worker')
  expect(workers).toHaveLength(4)
  expect(workers.every((run) => run.status === 'done')).toBe(true)
  expect(sorted(workers.map((run) => run.scopePath))).toEqual([
    'd3_outer:0/d3_git:0/d3_inner:0',
    'd3_outer:0/d3_git:0/d3_inner:1',
    'd3_outer:1/d3_git:1/d3_inner:0',
    'd3_outer:1/d3_git:1/d3_inner:1',
  ])
  expect(new Set(workers.map(frameKey)).size).toBe(4)

  // Each git generation reports only ITS round's files, even though round 0's
  // two files are still uncommitted when round 1 captures its baseline
  // (per-round subtraction, RFC-098 B3 / audit S-4 — at depth 3).
  const round0 = gits.find((run) => run.iteration === 0)!
  const round1 = gits.find((run) => run.iteration === 1)!
  expect(pathsOf(data, round0.id, 'git_diff')).toEqual([
    'matrix-generated/depth3/call-1.txt',
    'matrix-generated/depth3/call-2.txt',
  ])
  expect(pathsOf(data, round1.id, 'git_diff')).toEqual([
    'matrix-generated/depth3/call-3.txt',
    'matrix-generated/depth3/call-4.txt',
  ])

  // The outer loop promotes the last round's return value.
  expect(pathsOf(data, outer.id, 'last_round_changed')).toEqual([
    'matrix-generated/depth3/call-3.txt',
    'matrix-generated/depth3/call-4.txt',
  ])
})
