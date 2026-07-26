// End-to-end workflow catalog.
//
// Every definition under examples/workflows/e2e is imported through the
// public YAML endpoint, validated at an exact revision, and (except for the
// intentional static-invalid fixture) launched through POST /api/tasks.
// Execution uses the real daemon, SQLite, scheduler, wrapper scopes, git
// worktrees and output parser. Only the external model is replaced by the
// deterministic MATRIX_* OpenCode stub.

import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { initGitRepo } from './command'
import { startDaemon, type DaemonHandle } from './harness'

const HERE = dirname(fileURLToPath(import.meta.url))
const CATALOG_DIR = join(HERE, '..', 'examples', 'workflows', 'e2e')
const MATRIX_STUB = join(HERE, 'fixtures', 'stub-opencode-workflow-matrix.sh')

const CATALOG_FILES = [
  'prompt-input-kinds.yaml',
  'upload-input-roundtrip.yaml',
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
  'wrapper-loop-review.yaml',
  'clarify-self-roundtrip.yaml',
  'clarify-cross-agent-roundtrip.yaml',
  'wrapper-loop-exhausted.yaml',
  'wrapper-fanout-unsupported-inner.yaml',
  'invalid-wrapper-loop-nested.yaml',
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
    stubOpencode: MATRIX_STUB,
    extraEnv: { MATRIX_STATE_DIR: matrixStateDir },
    configOverrides: {
      defaultNodeRetries: 1,
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
    const yamlText = readFileSync(join(CATALOG_DIR, file), 'utf-8')
    const res = await apiFetch('/api/workflows/import', {
      method: 'POST',
      body: JSON.stringify({ yamlText, mode: 'fail' }),
    })
    await expectHttp(res, 201, `import ${file}`)
    const result = (await res.json()) as {
      outcome: 'created'
      workflow: WorkflowRow
    }
    expect(result.outcome).toBe('created')
    workflows.set(file, result.workflow)
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
      repoUrl: pathToFileURL(repoDir).href,
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
      repoUrl: pathToFileURL(repoDir).href,
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

test('catalog: every YAML imports; runnable definitions validate; nested loop is rejected', async () => {
  const staticallyValid = CATALOG_FILES.filter(
    (file) => file !== 'invalid-wrapper-loop-nested.yaml',
  )
  for (const file of staticallyValid) {
    const receipt = await validate(file)
    const errors = receipt.issues.filter((issue) => (issue.severity ?? 'error') === 'error')
    expect(errors, `${file} validation errors`).toEqual([])
    expect(receipt.ok, `${file} validation result`).toBe(true)
  }

  const invalid = await validate('invalid-wrapper-loop-nested.yaml')
  expect(invalid.ok).toBe(false)
  expect(invalid.issues.map((issue) => issue.code)).toContain('wrapper-loop-nested')
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

test('wrapper-fanout current v1 limitation fails closed before an inner wrapper can run', async () => {
  const task = await launchOk('wrapper-fanout-unsupported-inner.yaml', {
    docs: 'docs/a.md',
  })
  const final = await waitForTerminal(task.id)
  expect(final.status).toBe('failed')

  const data = await nodeRuns(task.id)
  const fanout = onlyRun(data, 'fan_wrap')
  expect(fanout.status).toBe('failed')
  expect(fanout.errorMessage).toContain('v1-unsupported-inner-kind:wrapper-git')
  expect(runsFor(data, 'inner_git')).toEqual([])
  expect(runsFor(data, 'inner_mutator')).toEqual([])
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

test('invalid loop-in-loop never starts: launch gate returns workflow-invalid with the exact issue', async () => {
  const result = await launch('invalid-wrapper-loop-nested.yaml')
  expect(result.response.status).toBe(422)
  const body = (await result.response.json()) as {
    code: string
    details?: { issues?: ValidationIssue[] }
  }
  expect(body.code).toBe('workflow-invalid')
  expect(body.details?.issues?.map((issue) => issue.code)).toContain('wrapper-loop-nested')
  expect(result.task).toBeUndefined()
})
