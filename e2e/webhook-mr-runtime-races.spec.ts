// RFC-294 pre-refactor E2E oracle for Webhook MR/runtime races.
//
// This suite never launches a task through POST /api/tasks.  Every task crosses
// the public GitLab ingress, durable delivery/fact linearization, trigger fire,
// scheduler, real runtime driver and terminal-control worker.  It protects the
// seams most likely to be split by the RFC-294 integration/task-execution move:
//
//   * verified but malformed JSON is auditable and cannot create work;
//   * close/update races converge without work surviving the terminal fact;
//   * closed can explicitly reopen without reviving an old task;
//   * merged is absorbing and later reopen/update cannot launch;
//   * close racing a runtime crash remains truthfully terminal and fenced;
//   * a daemon crash while terminal control owns a live runtime is recovered
//     from the durable effect after restart.

import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { querySqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const AGENTS = {
  long: 'webhook-mr-long-runtime',
  serialize: 'webhook-mr-serialized-runtime',
  crashRace: 'webhook-mr-crash-race-runtime',
  crashFirst: 'webhook-mr-crash-first-runtime',
  restart: 'webhook-mr-restart-runtime',
} as const

const REPOS = {
  long: 'platform/webhook-long',
  serialize: 'platform/webhook-serialized',
  crashRace: 'platform/webhook-crash-race',
  crashFirst: 'platform/webhook-crash-first',
  restart: 'platform/webhook-restart',
} as const

const TERMINATION_RELEASE_FILE = 'release-restart-owner'

type FixtureKind = keyof typeof AGENTS

interface AgentRow {
  id: string
}

interface WorkflowRow {
  id: string
}

interface EndpointRow {
  id: string
  urlToken: string
  secret: string
}

interface TriggerRow {
  id: string
}

interface WebhookReceipt {
  deliveryId: string
  status: string
}

interface FireRow {
  id: string
  deliveryId: string
  outcome: string
  taskId: string | null
  supersededTaskId: string | null
  error: string | null
}

interface TaskRow {
  id: string
  status: string
  errorMessage: string | null
  webhookSourceLink: { kind: string; url: string } | null
}

interface NodeRunsResponse {
  runs: Array<{
    id: string
    nodeId: string
    status: string
    pid: number | null
    exitCode: number | null
    failureCode: string | null
    errorMessage: string | null
  }>
  outputs: Array<{ nodeRunId: string; port: string; value: string }>
}

interface DeliveryListRow {
  id: string
  endpointId: string
  eventUuid: string | null
  status: string
  statusReason: string | null
}

interface DeliveryDetail extends DeliveryListRow {
  eventType: string | null
  mrStreamRevision: number | null
  mrStateAfter: string | null
  terminalControl: null | {
    kind: string
    status: string
    revision: number
    attemptCount: number
    lastError: string | null
    totalTargetCount: number
    targets: Array<{
      taskId: string
      priorStatus: string
      currentStatus: string
      fenceOutcome: string
      cancelOutcome: string
      releaseOutcome: string
      error: string | null
    }>
  }
}

interface ScenarioTrace {
  task: string
  agent: string
  callIndex: number
  prompt: string
}

interface ScenarioSignal {
  task: string
  agent: string
  signal: string
  terminationDelayMs: number
}

interface FixtureRef {
  triggerId: string
  repoPath: string
  projectId: number
  mrIid: number
}

let root = ''
let stateDir = ''
let planFile = ''
let daemon: DaemonHandle | undefined
let endpoint: EndpointRow
let preservedHome: string | undefined
const fixtures = new Map<FixtureKind, FixtureRef>()

function authHeaders(withJson = false): Record<string, string> {
  if (daemon === undefined) throw new Error('daemon is not running')
  return {
    Authorization: `Bearer ${daemon.token}`,
    ...(withJson ? { 'Content-Type': 'application/json' } : {}),
  }
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (daemon === undefined) throw new Error('daemon is not running')
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      ...authHeaders(init.body !== undefined),
      ...init.headers,
    },
  })
}

async function jsonOrThrow<T>(response: Response, label: string, expected = 200): Promise<T> {
  if (response.status !== expected) {
    throw new Error(
      `${label}: expected HTTP ${expected}, got ${response.status}: ${await response.text()}`,
    )
  }
  return (await response.json()) as T
}

async function postJson<T>(path: string, body: unknown, expected = 201): Promise<T> {
  return jsonOrThrow<T>(
    await apiFetch(path, { method: 'POST', body: JSON.stringify(body) }),
    `POST ${path}`,
    expected,
  )
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await read()
    if (accept(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${label} did not converge; last=${JSON.stringify(last)}`)
}

async function task(taskId: string): Promise<TaskRow> {
  return jsonOrThrow<TaskRow>(await apiFetch(`/api/tasks/${taskId}`), `GET task ${taskId}`)
}

async function nodeRuns(taskId: string): Promise<NodeRunsResponse> {
  return jsonOrThrow<NodeRunsResponse>(
    await apiFetch(`/api/tasks/${taskId}/node-runs`),
    `GET node runs ${taskId}`,
  )
}

async function waitForRuntimePid(taskId: string): Promise<number> {
  const execution = await waitFor(
    () => nodeRuns(taskId),
    (value) =>
      value.runs.some(
        (run) => run.nodeId === 'runtime' && run.status === 'running' && (run.pid ?? 0) > 0,
      ),
    `runtime pid for ${taskId}`,
  )
  return execution.runs.find((run) => run.nodeId === 'runtime' && run.status === 'running')!.pid!
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitForPidGone(pid: number, label: string): Promise<void> {
  await waitFor(
    async () => pidExists(pid),
    (alive) => !alive,
    `${label} pid ${pid} reaped`,
    20_000,
  )
}

async function waitForTask(
  taskId: string,
  accept: (row: TaskRow) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<TaskRow> {
  return waitFor(() => task(taskId), accept, label, timeoutMs)
}

async function fires(triggerId: string): Promise<FireRow[]> {
  return jsonOrThrow<FireRow[]>(
    await apiFetch(`/api/webhook-triggers/${triggerId}/fires?limit=200`),
    `GET fires ${triggerId}`,
  )
}

async function waitForFire(triggerId: string, deliveryId: string): Promise<FireRow> {
  const rows = await waitFor(
    () => fires(triggerId),
    (current) => current.some((row) => row.deliveryId === deliveryId),
    `fire for delivery ${deliveryId}`,
  )
  return rows.find((row) => row.deliveryId === deliveryId)!
}

async function delivery(deliveryId: string): Promise<DeliveryDetail> {
  return jsonOrThrow<DeliveryDetail>(
    await apiFetch(`/api/webhook-deliveries/${deliveryId}`),
    `GET delivery ${deliveryId}`,
  )
}

async function waitForDelivery(
  deliveryId: string,
  accept: (row: DeliveryDetail) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<DeliveryDetail> {
  return waitFor(() => delivery(deliveryId), accept, label, timeoutMs)
}

async function waitForTerminalControl(
  deliveryId: string,
  timeoutMs = 45_000,
): Promise<DeliveryDetail> {
  return waitForDelivery(
    deliveryId,
    (row) => row.terminalControl?.status === 'succeeded',
    `terminal control ${deliveryId}`,
    timeoutMs,
  )
}

function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T)
}

async function waitForTrace(taskId: string): Promise<ScenarioTrace> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const traces = readJsonLines<ScenarioTrace>(join(stateDir, 'trace.jsonl'))
    const trace = traces.find((row) => row.task === taskId)
    if (trace !== undefined) return trace
    const current = await task(taskId)
    if (['done', 'failed', 'canceled', 'interrupted'].includes(current.status)) {
      const execution = await nodeRuns(taskId)
      const events = await Promise.all(
        execution.runs
          .filter((run) => run.nodeId === 'runtime')
          .map(async (run) => {
            const response = await apiFetch(`/api/tasks/${taskId}/node-runs/${run.id}/events`)
            return response.ok ? await response.json() : await response.text()
          }),
      )
      throw new Error(
        `runtime ${taskId} became ${current.status} before scenario trace: ${JSON.stringify({
          runs: execution.runs.filter((run) => run.nodeId === 'runtime'),
          events,
        })}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`runtime trace for ${taskId} did not converge`)
}

function expectWebhookPrompt(
  trace: ScenarioTrace,
  expectedEvent: 'mr_opened' | 'mr_updated',
  expectedMrIid: number,
): void {
  // Dynamic webhook values are intentionally wrapped in the prompt's
  // untrusted-input boundary.  Match the field label, boundary identity and
  // exact value together so the assertion cannot pass on unrelated prose.
  expect(trace.prompt).toMatch(
    new RegExp(
      `event=<aw-input name="trigger-webhook-event_type"[^>]*>\\s*${expectedEvent}\\s*</aw-input>`,
    ),
  )
  expect(trace.prompt).toMatch(
    new RegExp(
      `mr=<aw-input name="trigger-webhook-mr_iid"[^>]*>\\s*${expectedMrIid}\\s*</aw-input>`,
    ),
  )
}

function expectWebhookTerminalError(
  row: TaskRow,
  terminal: 'closed' | 'merged',
  deliveryId: string,
  streamRevision: number | null,
): void {
  if (streamRevision === null) throw new Error(`${terminal} control is missing a stream revision`)
  expect(row.errorMessage).toBe(
    `webhook-mr-${terminal}: delivery=${deliveryId} revision=${streamRevision}`,
  )
}

function mrBody(input: {
  fixture: FixtureRef
  action: 'open' | 'reopen' | 'update' | 'close' | 'merge'
}): string {
  const { fixture, action } = input
  const terminal = action === 'close' ? 'closed' : action === 'merge' ? 'merged' : 'opened'
  return JSON.stringify({
    object_kind: 'merge_request',
    user: { id: 7001, username: 'webhook-developer', name: 'Webhook Developer' },
    project: {
      id: fixture.projectId,
      path_with_namespace: fixture.repoPath,
      git_http_url: `https://gitlab.invalid/${fixture.repoPath}.git`,
      git_ssh_url: `git@gitlab.invalid:${fixture.repoPath}.git`,
    },
    object_attributes: {
      id: fixture.projectId * 100 + fixture.mrIid,
      iid: fixture.mrIid,
      action,
      state: terminal,
      title: `${fixture.repoPath} MR`,
      source_branch: `feature/mr-${fixture.mrIid}`,
      target_branch: 'main',
      url: mrUrl(fixture),
      last_commit: { id: `${fixture.projectId}${fixture.mrIid}${action}` },
    },
  })
}

function mrUrl(fixture: FixtureRef): string {
  return `https://gitlab.invalid/${fixture.repoPath}/-/merge_requests/${fixture.mrIid}`
}

async function postIngress(
  fixture: FixtureRef,
  action: 'open' | 'reopen' | 'update' | 'close' | 'merge',
  uuid: string,
): Promise<WebhookReceipt> {
  if (daemon === undefined) throw new Error('daemon is not running')
  return jsonOrThrow<WebhookReceipt>(
    await fetch(`${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gitlab-token': endpoint.secret,
        'x-gitlab-event': 'Merge Request Hook',
        'x-gitlab-event-uuid': uuid,
      },
      body: mrBody({ fixture, action }),
    }),
    `${action} ingress ${uuid}`,
  )
}

async function launchFromWebhook(
  fixture: FixtureRef,
  uuid: string,
  action: 'open' | 'reopen' | 'update' = 'open',
): Promise<{ delivery: WebhookReceipt; fire: FireRow; task: TaskRow }> {
  const receipt = await postIngress(fixture, action, uuid)
  expect(receipt.status).toBe('received')
  const fire = await waitForFire(fixture.triggerId, receipt.deliveryId)
  expect(fire.outcome).toBe('launched')
  expect(fire.taskId).not.toBeNull()
  const launched = await waitForTask(
    fire.taskId!,
    (row) => row.status === 'running',
    `${action} task ${fire.taskId} running`,
  )
  expect(launched.webhookSourceLink).toEqual({ kind: 'merge_request', url: mrUrl(fixture) })
  const trace = await waitForTrace(launched.id)
  const expectedEvent = action === 'update' ? 'mr_updated' : 'mr_opened'
  expectWebhookPrompt(trace, expectedEvent, fixture.mrIid)
  const provenance = querySqlite<{
    origin: string | null
    legacyTriggerId: string | null
    legacyFireId: string | null
    eventSubscriptionId: string | null
    eventDeliveryId: string | null
  }>(
    join(daemon!.home, 'db.sqlite'),
    `SELECT launch_origin AS origin,
            webhook_trigger_id AS legacyTriggerId,
            webhook_fire_id AS legacyFireId,
            event_subscription_id AS eventSubscriptionId,
            event_delivery_id AS eventDeliveryId
       FROM tasks WHERE id = ?`,
    [launched.id],
  )
  expect(provenance).toHaveLength(1)
  expect(provenance[0]).toMatchObject({
    origin: 'event',
    legacyTriggerId: null,
    legacyFireId: null,
    eventDeliveryId: fire.id,
  })
  expect(provenance[0]?.eventSubscriptionId).toContain(`route:${fixture.triggerId}:`)
  return { delivery: receipt, fire, task: launched }
}

async function createFixture(
  kind: FixtureKind,
  projectId: number,
  mrIid: number,
): Promise<FixtureRef> {
  const agent = await postJson<AgentRow>('/api/agents', {
    name: AGENTS[kind],
    description: `Webhook MR ${kind} runtime fixture`,
    outputs: ['answer'],
    outputKinds: { answer: 'string' },
    readonly: true,
    runtime: kind === 'crashRace' || kind === 'crashFirst' ? 'claude-code' : 'opencode',
    bodyMd: `[AW_SCENARIO_AGENT:${AGENTS[kind]}]\nFollow the workflow protocol exactly.`,
  })
  const workflow = await postJson<WorkflowRow>('/api/workflows', {
    name: `webhook-mr-${kind}-${crypto.randomUUID()}`,
    description: `Webhook-only ${kind} runtime`,
    definition: {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'runtime',
          kind: 'agent-single',
          agentId: agent.id,
          promptTemplate: [
            'AW_SCENARIO_TASK={{__task_id__}}',
            'AW_SCENARIO_NODE=runtime',
            'event={{trigger.webhook.event_type}}',
            'mr={{trigger.webhook.mr_iid}}',
          ].join('\n'),
          position: { x: 200, y: 0 },
        },
        {
          id: 'output',
          kind: 'output',
          ports: [{ name: 'answer', bind: { nodeId: 'runtime', portName: 'answer' } }],
          position: { x: 600, y: 0 },
        },
      ],
      edges: [
        {
          id: 'runtime-output',
          source: { nodeId: 'runtime', portName: 'answer' },
          target: { nodeId: 'output', portName: 'answer' },
        },
      ],
    },
  })
  const trigger = await postJson<TriggerRow>('/api/webhook-triggers', {
    name: `webhook-mr-${kind}`,
    endpointId: endpoint.id,
    repoScope: { kind: 'exact', paths: [REPOS[kind]] },
    eventTypes: ['mr_opened', 'mr_updated'],
    ignoreUsernames: [],
    maxConsecutiveFires: 100,
    autoRegisterRepos: false,
    cancelOnMrTerminal: true,
    launchKind: 'workflow',
    launchRefId: workflow.id,
    launchPayload: { inputs: {}, scratch: true },
  })
  return { triggerId: trigger.id, repoPath: REPOS[kind], projectId, mrIid }
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'aw-webhook-mr-runtime-races-'))
  stateDir = join(root, 'state')
  mkdirSync(stateDir)
  planFile = join(root, 'plan.json')
  writeFileSync(
    planFile,
    JSON.stringify({
      version: 1,
      agents: {
        [AGENTS.long]: [
          {
            requirePrompt: [
              'event=',
              'name="trigger-webhook-event_type"',
              'mr=',
              'name="trigger-webhook-mr_iid"',
              '\n41\n',
            ],
            delayMs: 120_000,
            output: { answer: 'terminal-must-suppress-this-output' },
          },
        ],
        [AGENTS.serialize]: [
          {
            requirePrompt: [
              'event=',
              'name="trigger-webhook-event_type"',
              'mr=',
              'name="trigger-webhook-mr_iid"',
              '\n42\n',
            ],
            delayMs: 120_000,
            output: { answer: 'superseded-output-must-not-project' },
          },
        ],
        [AGENTS.crashRace]: [
          {
            requirePrompt: [
              'event=',
              '\nmr_opened\n',
              'mr=',
              'name="trigger-webhook-mr_iid"',
              '\n43\n',
            ],
            waitForFile: 'release-runtime-crash',
            stderr: 'runtime-crash-raced-with-mr-close',
            exitCode: 23,
          },
        ],
        [AGENTS.crashFirst]: [
          {
            requirePrompt: [
              'event=',
              '\nmr_opened\n',
              'mr=',
              'name="trigger-webhook-mr_iid"',
              '\n45\n',
            ],
            waitForFile: 'release-runtime-crash-first',
            stderr: 'runtime-crash-won-before-terminal-control',
            exitCode: 23,
          },
        ],
        [AGENTS.restart]: [
          {
            requirePrompt: [
              'event=',
              '\nmr_opened\n',
              'mr=',
              'name="trigger-webhook-mr_iid"',
              '\n44\n',
            ],
            delayMs: 120_000,
            terminationDelayMs: 30_000,
            terminationReleaseFile: TERMINATION_RELEASE_FILE,
            output: { answer: 'restart-must-suppress-this-output' },
          },
        ],
      },
    }),
  )

  daemon = await startDaemon({
    stubMode: 'runtime-scenario',
    extraEnv: { SCENARIO_PLAN_FILE: planFile, SCENARIO_STATE_DIR: stateDir },
    configOverrides: {
      defaultNodeRetries: 0,
      // RFC-313: 上限已是两个预算的乘积；置 0 保持「1+defaultNodeRetries」的既有计数。
      sessionRestartBudget: 0,
      defaultPerNodeTimeoutMs: 150_000,
    },
  })
  endpoint = await postJson<EndpointRow>('/api/webhook-endpoints', {
    name: 'Webhook MR runtime races',
    provider: 'gitlab',
  })
  fixtures.set('long', await createFixture('long', 9401, 41))
  fixtures.set('serialize', await createFixture('serialize', 9402, 42))
  fixtures.set('crashRace', await createFixture('crashRace', 9403, 43))
  fixtures.set('restart', await createFixture('restart', 9404, 44))
  fixtures.set('crashFirst', await createFixture('crashFirst', 9405, 45))
})

test.afterAll(async () => {
  if (stateDir !== '' && existsSync(stateDir)) {
    writeFileSync(join(stateDir, TERMINATION_RELEASE_FILE), 'afterAll release\n')
  }
  if (daemon !== undefined) await daemon.stop()
  if (preservedHome !== undefined) rmSync(preservedHome, { recursive: true, force: true })
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

test('verified malformed JSON is a parse-failed audit row and creates zero fire/task', async () => {
  const beforeFireIds = new Set(
    (await Promise.all([...fixtures.values()].map((fixture) => fires(fixture.triggerId))))
      .flat()
      .map((row) => row.id),
  )
  const uuid = 'webhook-mr-malformed-json'
  const response = await fetch(`${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gitlab-token': endpoint.secret,
      'x-gitlab-event': 'Merge Request Hook',
      'x-gitlab-event-uuid': uuid,
    },
    body: '{"object_kind":"merge_request",',
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'invalid-json' })

  const page = await jsonOrThrow<{ items: DeliveryListRow[] }>(
    await apiFetch(`/api/webhook-deliveries?endpointId=${endpoint.id}&limit=200`),
    'list malformed delivery audit',
  )
  const ignored = page.items.find((row) => row.eventUuid === uuid)
  expect(ignored).toMatchObject({
    endpointId: endpoint.id,
    status: 'ignored',
    statusReason: 'parse-failed',
  })
  // Observe a short stability window: the ingress returns synchronously, but a
  // regression that accidentally queued dispatch could otherwise land its
  // fire/task just after one immediate read and leave this test falsely green.
  const stableUntil = Date.now() + 750
  do {
    const afterFires = (
      await Promise.all([...fixtures.values()].map((fixture) => fires(fixture.triggerId)))
    ).flat()
    expect(afterFires.filter((row) => !beforeFireIds.has(row.id))).toEqual([])
    const tasksPage = await jsonOrThrow<{ items: TaskRow[] }>(
      await apiFetch('/api/task-catalog?scope=mine&limit=50'),
      'list tasks after malformed ingress',
    )
    expect(tasksPage.items).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < stableUntil)
})

test('different-UUID close/update facts on one MR stream linearize; reopen and absorbing merge leave no stale runtime work', async () => {
  const fixture = fixtures.get('long')!
  const original = await launchFromWebhook(fixture, 'webhook-mr-long-open')
  const originalPid = await waitForRuntimePid(original.task.id)

  // Start both HTTP requests without awaiting either response.  The durable
  // stream revisions below tell us which fact linearized first; assertions do
  // not pretend JavaScript promise order is ingress order.
  const closePromise = postIngress(fixture, 'close', 'webhook-mr-long-close')
  const updatePromise = postIngress(fixture, 'update', 'webhook-mr-long-racing-update')
  const [closeReceipt, updateReceipt] = await Promise.all([closePromise, updatePromise])

  const closeControl = await waitForTerminalControl(closeReceipt.deliveryId)
  await waitForPidGone(originalPid, 'closed long runtime')
  const updateDetail = await waitForDelivery(
    updateReceipt.deliveryId,
    (row) => row.status === 'matched',
    'racing update delivery terminal',
  )
  expect(closeControl).toMatchObject({
    status: 'matched',
    statusReason: 'terminal-control-accepted',
    eventType: 'mr_closed',
    mrStateAfter: 'closed',
  })
  expect(closeControl.mrStreamRevision).not.toBe(updateDetail.mrStreamRevision)
  const closeRevision = closeControl.mrStreamRevision
  const updateRevision = updateDetail.mrStreamRevision
  if (closeRevision === null || updateRevision === null) {
    throw new Error('close/update MR facts must both have durable revisions')
  }
  expect(Math.abs(closeRevision - updateRevision)).toBe(1)
  expect(
    (await fires(fixture.triggerId)).some((row) => row.deliveryId === closeReceipt.deliveryId),
  ).toBe(false)

  const racingUpdateFire = await waitForFire(fixture.triggerId, updateReceipt.deliveryId)
  if (updateRevision > closeRevision) {
    expect(updateDetail.mrStateAfter).toBe('closed')
    expect(racingUpdateFire.outcome).toBe('skipped-mr-stream-closed')
    expect(racingUpdateFire.taskId).toBeNull()
  } else {
    expect(updateDetail.mrStateAfter).toBe('open')
    expect(['launched', 'skipped-mr-stream-terminal']).toContain(racingUpdateFire.outcome)
  }
  const possiblyLaunchedTaskIds = [original.task.id]
  if (racingUpdateFire.taskId !== null) possiblyLaunchedTaskIds.push(racingUpdateFire.taskId)
  for (const taskId of possiblyLaunchedTaskIds) {
    const canceledTask = await waitForTask(
      taskId,
      (row) => row.status === 'canceled',
      `close cancel ${taskId}`,
    )
    expect(canceledTask.status).toBe('canceled')
    const closeTarget = closeControl.terminalControl?.targets.find((row) => row.taskId === taskId)
    expect(closeTarget).toMatchObject({ fenceOutcome: 'fenced-closed', currentStatus: 'canceled' })
    if (closeTarget?.cancelOutcome === 'canceled') {
      expectWebhookTerminalError(
        canceledTask,
        'closed',
        closeReceipt.deliveryId,
        closeControl.mrStreamRevision,
      )
    } else {
      // If the racing update launched first, webhook supersede may already
      // have canceled the prior task. Terminal control must add the fence but
      // preserve that winning provenance instead of rewriting it as MR-close.
      expect(closeTarget?.cancelOutcome).toBe('already-terminal')
      expect(['canceled-by-user', 'no active scheduler at cancel time']).toContain(
        canceledTask.errorMessage,
      )
    }
    const execution = await jsonOrThrow<NodeRunsResponse>(
      await apiFetch(`/api/tasks/${taskId}/node-runs`),
      `read closed long-runtime node runs ${taskId}`,
    )
    const runtimeRuns = execution.runs.filter((run) => run.nodeId === 'runtime')
    if (taskId === original.task.id) expect(runtimeRuns).toHaveLength(1)
    expect(
      runtimeRuns.every((run) => run.status === 'canceled'),
      `terminal control left non-canceled runtime rows: ${JSON.stringify(runtimeRuns)}`,
    ).toBe(true)
    for (const run of runtimeRuns) {
      if (run.pid !== null) await waitForPidGone(run.pid, `closed long runtime ${taskId}`)
    }
    expect(execution.outputs.filter((row) => row.port === 'answer')).toEqual([])
  }

  const lateUpdate = await postIngress(fixture, 'update', 'webhook-mr-long-late-update')
  const lateUpdateFire = await waitForFire(fixture.triggerId, lateUpdate.deliveryId)
  expect(await delivery(lateUpdate.deliveryId)).toMatchObject({ mrStateAfter: 'closed' })
  expect(lateUpdateFire.outcome).toBe('skipped-mr-stream-closed')
  expect(lateUpdateFire.taskId).toBeNull()

  // Reopen is an explicit new provider fact: it may launch a fresh task, but
  // must not revive either canceled pre-close identity.
  const reopened = await launchFromWebhook(fixture, 'webhook-mr-long-explicit-reopen', 'reopen')
  const reopenedPid = await waitForRuntimePid(reopened.task.id)
  expect(await delivery(reopened.delivery.deliveryId)).toMatchObject({
    eventType: 'mr_opened',
    mrStateAfter: 'open',
  })
  const reopenControl = await waitForTerminalControl(reopened.delivery.deliveryId)
  expect(reopenControl.terminalControl).toMatchObject({ kind: 'clear-closed', status: 'succeeded' })
  expect(possiblyLaunchedTaskIds).not.toContain(reopened.task.id)
  for (const oldTaskId of possiblyLaunchedTaskIds) {
    expect((await task(oldTaskId)).status).toBe('canceled')
    expect(
      reopenControl.terminalControl?.targets.find((row) => row.taskId === oldTaskId),
    ).toMatchObject({
      currentStatus: 'canceled',
      fenceOutcome: 'cleared-closed',
      cancelOutcome: 'not-applicable',
    })
    expect(
      querySqlite<{ fence: string | null }>(
        join(daemon!.home, 'db.sqlite'),
        'SELECT source_termination_fence AS fence FROM tasks WHERE id = ?',
        [oldTaskId],
      ),
    ).toEqual([{ fence: null }])
  }

  const merged = await postIngress(fixture, 'merge', 'webhook-mr-long-merge')
  const mergeControl = await waitForTerminalControl(merged.deliveryId)
  await waitForPidGone(reopenedPid, 'merged long runtime')
  expect(mergeControl).toMatchObject({ eventType: 'mr_merged', mrStateAfter: 'merged' })
  const mergedTask = await waitForTask(
    reopened.task.id,
    (row) => row.status === 'canceled',
    'merge cancel',
  )
  expectWebhookTerminalError(mergedTask, 'merged', merged.deliveryId, mergeControl.mrStreamRevision)
  expect(
    mergeControl.terminalControl?.targets.find((row) => row.taskId === reopened.task.id),
  ).toMatchObject({ fenceOutcome: 'fenced-merged', currentStatus: 'canceled' })
  expect((await fires(fixture.triggerId)).some((row) => row.deliveryId === merged.deliveryId)).toBe(
    false,
  )

  const reopenAfterMerge = await postIngress(
    fixture,
    'reopen',
    'webhook-mr-long-reopen-after-merge',
  )
  const updateAfterMerge = await postIngress(
    fixture,
    'update',
    'webhook-mr-long-update-after-merge',
  )
  for (const receipt of [reopenAfterMerge, updateAfterMerge]) {
    expect(await delivery(receipt.deliveryId)).toMatchObject({ mrStateAfter: 'merged' })
    const fire = await waitForFire(fixture.triggerId, receipt.deliveryId)
    expect(fire.outcome).toBe('skipped-mr-stream-merged')
    expect(fire.taskId).toBeNull()
  }

  const allFires = await fires(fixture.triggerId)
  const launchedTaskIds = allFires
    .filter((row) => row.outcome === 'launched' && row.taskId !== null)
    .map((row) => row.taskId!)
  expect(launchedTaskIds).toContain(original.task.id)
  expect(launchedTaskIds).toContain(reopened.task.id)
  for (const taskId of launchedTaskIds) {
    expect((await task(taskId)).status).toBe('canceled')
  }
  const reopenedExecution = await jsonOrThrow<NodeRunsResponse>(
    await apiFetch(`/api/tasks/${reopened.task.id}/node-runs`),
    'read merged long-runtime node runs',
  )
  expect(reopenedExecution.runs.filter((run) => run.nodeId === 'runtime')).toHaveLength(1)
  expect(
    reopenedExecution.runs
      .filter((run) => run.nodeId === 'runtime')
      .every((run) => run.status === 'canceled'),
  ).toBe(true)
  expect(reopenedExecution.outputs.filter((row) => row.port === 'answer')).toEqual([])
})

test('different-UUID launch-eligible facts serialize, supersede to one live runtime, then close clears the stream', async () => {
  const fixture = fixtures.get('serialize')!
  const openPromise = postIngress(fixture, 'open', 'webhook-mr-serialized-open')
  const updatePromise = postIngress(fixture, 'update', 'webhook-mr-serialized-update')
  const [openReceipt, updateReceipt] = await Promise.all([openPromise, updatePromise])

  const [openDetail, updateDetail] = await Promise.all([
    waitForDelivery(openReceipt.deliveryId, (row) => row.status === 'matched', 'serialized open'),
    waitForDelivery(
      updateReceipt.deliveryId,
      (row) => row.status === 'matched',
      'serialized update',
    ),
  ])
  expect(openDetail).toMatchObject({ eventType: 'mr_opened', mrStateAfter: 'open' })
  expect(updateDetail).toMatchObject({ eventType: 'mr_updated', mrStateAfter: 'open' })
  if (openDetail.mrStreamRevision === null || updateDetail.mrStreamRevision === null) {
    throw new Error('launch-eligible MR facts must both have durable revisions')
  }
  expect(Math.abs(openDetail.mrStreamRevision - updateDetail.mrStreamRevision)).toBe(1)

  const [openFire, updateFire] = await Promise.all([
    waitForFire(fixture.triggerId, openReceipt.deliveryId),
    waitForFire(fixture.triggerId, updateReceipt.deliveryId),
  ])
  expect(openFire.outcome).toBe('launched')
  expect(updateFire.outcome).toBe('launched')
  expect(openFire.taskId).not.toBeNull()
  expect(updateFire.taskId).not.toBeNull()
  expect(openFire.taskId).not.toBe(updateFire.taskId)
  const taskIds = [openFire.taskId!, updateFire.taskId!]
  expect([openFire, updateFire].filter((fire) => fire.supersededTaskId !== null)).toHaveLength(1)
  expect(
    [openFire, updateFire].find((fire) => fire.supersededTaskId !== null)?.supersededTaskId,
  ).toBe([openFire, updateFire].find((fire) => fire.supersededTaskId === null)?.taskId)

  const converged = await waitFor(
    async () => Promise.all(taskIds.map((taskId) => task(taskId))),
    (rows) =>
      rows.filter((row) => row.status === 'running').length === 1 &&
      rows.filter((row) => row.status === 'canceled').length === 1,
    'serialized launch supersede convergence',
  )
  const live = converged.find((row) => row.status === 'running')!
  const superseded = converged.find((row) => row.status === 'canceled')!
  expect(live.id).not.toBe(superseded.id)

  const supersededExecution = await waitFor(
    () => nodeRuns(superseded.id),
    (execution) =>
      execution.runs
        .filter((run) => run.nodeId === 'runtime')
        .every((run) => run.status === 'canceled'),
    'superseded runtime node settles canceled',
  )
  const supersededRuntimePids = supersededExecution.runs
    .filter((run) => run.nodeId === 'runtime' && run.pid !== null)
    .map((run) => run.pid!)
  for (const pid of supersededRuntimePids) {
    await waitForPidGone(pid, 'superseded serialized runtime')
  }

  const fireByTaskId = new Map(
    [
      { fire: openFire, detail: openDetail },
      { fire: updateFire, detail: updateDetail },
    ].map(({ fire, detail }) => [fire.taskId!, { fire, detail }]),
  )
  for (const row of converged) {
    const launch = fireByTaskId.get(row.id)!
    expect(row.webhookSourceLink).toEqual({ kind: 'merge_request', url: mrUrl(fixture) })
    const provenance = querySqlite<{
      origin: string | null
      legacyTriggerId: string | null
      legacyFireId: string | null
      eventSubscriptionId: string | null
      eventDeliveryId: string | null
    }>(
      join(daemon!.home, 'db.sqlite'),
      `SELECT launch_origin AS origin,
              webhook_trigger_id AS legacyTriggerId,
              webhook_fire_id AS legacyFireId,
              event_subscription_id AS eventSubscriptionId,
              event_delivery_id AS eventDeliveryId
         FROM tasks WHERE id = ?`,
      [row.id],
    )
    expect(provenance).toHaveLength(1)
    expect(provenance[0]).toMatchObject({
      origin: 'event',
      legacyTriggerId: null,
      legacyFireId: null,
      eventDeliveryId: launch.fire.id,
    })
    expect(provenance[0]?.eventSubscriptionId).toContain(`route:${fixture.triggerId}:`)
  }

  const liveTrace = await waitForTrace(live.id)
  const liveEvent = fireByTaskId.get(live.id)!.detail.eventType
  if (liveEvent !== 'mr_opened' && liveEvent !== 'mr_updated') {
    throw new Error(`launch-eligible runtime has unexpected event ${liveEvent}`)
  }
  expectWebhookPrompt(liveTrace, liveEvent, fixture.mrIid)
  const livePid = await waitForRuntimePid(live.id)
  expect(pidExists(livePid)).toBe(true)
  expect(supersededRuntimePids.filter((pid) => pidExists(pid))).toEqual([])

  const close = await postIngress(fixture, 'close', 'webhook-mr-serialized-close')
  const control = await waitForTerminalControl(close.deliveryId)
  await waitForPidGone(livePid, 'serialized stream close')
  expect(
    (await fires(fixture.triggerId)).some((fire) => fire.deliveryId === close.deliveryId),
  ).toBe(false)
  for (const taskId of taskIds) {
    const closedTask = await task(taskId)
    expect(closedTask.status).toBe('canceled')
    if (taskId === live.id) {
      expectWebhookTerminalError(closedTask, 'closed', close.deliveryId, control.mrStreamRevision)
    }
    expect(
      control.terminalControl?.targets.find((target) => target.taskId === taskId),
    ).toMatchObject({ currentStatus: 'canceled', fenceOutcome: 'fenced-closed' })
    const execution = await nodeRuns(taskId)
    const runtimeRuns = execution.runs.filter((run) => run.nodeId === 'runtime')
    expect(runtimeRuns.every((run) => run.status === 'canceled')).toBe(true)
    for (const run of runtimeRuns) {
      if (run.pid !== null) await waitForPidGone(run.pid, `serialized close ${taskId}`)
    }
    expect(execution.outputs.filter((output) => output.port === 'answer')).toEqual([])
  }
})

test('terminal close wins against an active runtime with a canceled node, reaped PID and no output', async () => {
  const fixture = fixtures.get('crashRace')!
  const launched = await launchFromWebhook(fixture, 'webhook-mr-crash-open')
  const runtimePid = await waitForRuntimePid(launched.task.id)

  const closeReceipt = await postIngress(fixture, 'close', 'webhook-mr-crash-close')
  const control = await waitForTerminalControl(closeReceipt.deliveryId)
  expect(control).toMatchObject({
    status: 'matched',
    statusReason: 'terminal-control-accepted',
    eventType: 'mr_closed',
    mrStateAfter: 'closed',
    terminalControl: { kind: 'fence-closed', status: 'succeeded' },
  })
  await waitForPidGone(runtimePid, 'crash-race runtime')
  writeFileSync(join(stateDir, 'release-runtime-crash'), 'release\n')
  const terminal = await waitForTask(
    launched.task.id,
    (row) => row.status === 'canceled',
    'terminal-close runtime result',
  )
  expect(terminal.status).toBe('canceled')
  expectWebhookTerminalError(terminal, 'closed', closeReceipt.deliveryId, control.mrStreamRevision)

  const target = control.terminalControl?.targets.find((row) => row.taskId === launched.task.id)
  expect(target).toMatchObject({
    currentStatus: 'canceled',
    fenceOutcome: 'fenced-closed',
    cancelOutcome: 'canceled',
    releaseOutcome: 'no-active-owner',
  })

  const runs = await nodeRuns(launched.task.id)
  const runtimeRuns = runs.runs.filter((run) => run.nodeId === 'runtime')
  expect(runtimeRuns).toHaveLength(1)
  expect(runtimeRuns[0]?.status).toBe('canceled')
  expect(runs.outputs.filter((row) => row.port === 'answer')).toEqual([])

  const fire = await waitForFire(fixture.triggerId, launched.delivery.deliveryId)
  expect(fire).toMatchObject({ outcome: 'launched', taskId: launched.task.id })
  expect((await delivery(launched.delivery.deliveryId)).status).toBe('matched')
  expect(
    (await fires(fixture.triggerId)).some((row) => row.deliveryId === closeReceipt.deliveryId),
  ).toBe(false)
})

test('runtime crash settles before a later close, which only adds the terminal fence', async () => {
  const fixture = fixtures.get('crashFirst')!
  const crashRelease = join(stateDir, 'release-runtime-crash-first')
  rmSync(crashRelease, { force: true })

  try {
    const crashing = await launchFromWebhook(fixture, 'webhook-mr-crash-first-open')
    const crashingPid = await waitForRuntimePid(crashing.task.id)
    writeFileSync(crashRelease, 'release crash-first runtime\n')

    const failed = await waitForTask(
      crashing.task.id,
      (row) => row.status === 'failed',
      'runtime crash before close',
    )
    // 前缀锁：exit code 在行首，其后可跟 T132 的 `; stderr tail: …`。
    expect(failed.errorMessage).toMatch(/^claude-code exited with code 23(;|$)/)
    await waitForPidGone(crashingPid, 'crash-first runtime')
    const failedExecution = await nodeRuns(crashing.task.id)
    const failedRuntimeRuns = failedExecution.runs.filter((run) => run.nodeId === 'runtime')
    expect(failedRuntimeRuns).toHaveLength(1)
    expect(failedRuntimeRuns[0]).toMatchObject({
      status: 'failed',
      exitCode: 23,
      failureCode: null,
    })
    expect(failedRuntimeRuns[0]?.errorMessage).toMatch(/^claude-code exited with code 23(;|$)/)
    expect(failedExecution.outputs.filter((row) => row.port === 'answer')).toEqual([])

    const close = await postIngress(fixture, 'close', 'webhook-mr-crash-first-close')
    const control = await waitForTerminalControl(close.deliveryId)
    expect(control).toMatchObject({
      status: 'matched',
      statusReason: 'terminal-control-accepted',
      eventType: 'mr_closed',
      mrStateAfter: 'closed',
      terminalControl: { kind: 'fence-closed', status: 'succeeded' },
    })
    const target = control.terminalControl?.targets.find((row) => row.taskId === crashing.task.id)
    expect(target).toMatchObject({
      currentStatus: 'failed',
      fenceOutcome: 'fenced-closed',
      cancelOutcome: 'already-terminal',
      releaseOutcome: 'no-active-owner',
    })
    expect((await task(crashing.task.id)).errorMessage).toBe(failed.errorMessage)
    expect(
      (await fires(fixture.triggerId)).some((row) => row.deliveryId === close.deliveryId),
    ).toBe(false)
  } finally {
    writeFileSync(crashRelease, 'finally release crash-first runtime\n')
  }
})

if (process.platform !== 'win32') {
  test('daemon crash while terminal control owns the runtime converges after same-home restart', async () => {
    const fixture = fixtures.get('restart')!
    rmSync(join(stateDir, TERMINATION_RELEASE_FILE), { force: true })
    const launched = await launchFromWebhook(fixture, 'webhook-mr-restart-open')
    const runtimePid = await waitForRuntimePid(launched.task.id)
    const close = await postIngress(fixture, 'close', 'webhook-mr-restart-close')

    const effect = await waitFor(
      async () =>
        querySqlite<{ status: string; attemptCount: number }>(
          join(daemon!.home, 'db.sqlite'),
          'SELECT status, attempt_count AS attemptCount FROM webhook_mr_control_effects WHERE delivery_id = ?',
          [close.deliveryId],
        )[0] ?? null,
      (row) => row?.status === 'leased',
      'terminal effect leased while runtime termination is delayed',
    )
    expect(effect?.attemptCount).toBeGreaterThanOrEqual(1)

    const signal = await waitFor(
      async () => readJsonLines<ScenarioSignal>(join(stateDir, 'signals.jsonl')),
      (rows) => rows.some((row) => row.task === launched.task.id && row.signal === 'SIGTERM'),
      'runtime SIGTERM observation',
    )
    expect(signal.find((row) => row.task === launched.task.id)).toMatchObject({
      agent: AGENTS.restart,
      signal: 'SIGTERM',
      terminationDelayMs: 30_000,
    })

    preservedHome = daemon!.home
    await daemon!.killChild('SIGKILL')
    daemon = undefined
    daemon = await startDaemon({
      home: preservedHome,
      stubMode: 'runtime-scenario',
      extraEnv: { SCENARIO_PLAN_FILE: planFile, SCENARIO_STATE_DIR: stateDir },
      configOverrides: {
        defaultNodeRetries: 0,
        // RFC-313: 上限已是两个预算的乘积；置 0 保持「1+defaultNodeRetries」的既有计数。
        sessionRestartBudget: 0,
        defaultPerNodeTimeoutMs: 150_000,
      },
    })

    const recovered = await waitForTerminalControl(close.deliveryId, 50_000)
    await waitForPidGone(runtimePid, 'recovered restart runtime')
    expect(recovered.terminalControl).toMatchObject({
      status: 'succeeded',
      lastError: null,
    })
    expect(recovered.terminalControl!.attemptCount).toBeGreaterThanOrEqual(2)
    const finalTask = await waitForTask(
      launched.task.id,
      (row) => row.status === 'canceled',
      'recovered terminal task',
    )
    expect(finalTask.status).toBe('canceled')
    expectWebhookTerminalError(finalTask, 'closed', close.deliveryId, recovered.mrStreamRevision)

    const target = recovered.terminalControl!.targets.find((row) => row.taskId === launched.task.id)
    expect(target).toBeDefined()
    expect(target?.currentStatus).toBe('canceled')
    // The first daemon durably wrote the task fence, then died while waiting for
    // the runtime owner and before it could persist its effect receipt.  The
    // recovering attempt must therefore report an idempotent `unchanged`, while
    // the task row remains exactly fenced closed.
    expect(target?.fenceOutcome).toBe('unchanged')
    expect(
      querySqlite<{ fence: string | null }>(
        join(daemon.home, 'db.sqlite'),
        'SELECT source_termination_fence AS fence FROM tasks WHERE id = ?',
        [launched.task.id],
      ),
    ).toEqual([{ fence: 'closed' }])
    expect(target?.cancelOutcome).toBe('already-terminal')
    expect(target?.releaseOutcome).toBe('no-active-owner')

    const recoveredExecution = await jsonOrThrow<NodeRunsResponse>(
      await apiFetch(`/api/tasks/${launched.task.id}/node-runs`),
      'read recovered restart node runs',
    )
    expect(recoveredExecution.runs.filter((run) => run.nodeId === 'runtime')).toHaveLength(1)
    expect(recoveredExecution.runs.find((run) => run.nodeId === 'runtime')?.status).toBe(
      'interrupted',
    )
    expect(recoveredExecution.outputs.filter((row) => row.port === 'answer')).toEqual([])

    const late = await postIngress(fixture, 'update', 'webhook-mr-restart-late-update')
    const lateFire = await waitForFire(fixture.triggerId, late.deliveryId)
    expect(await delivery(late.deliveryId)).toMatchObject({ mrStateAfter: 'closed' })
    expect(lateFire.outcome).toBe('skipped-mr-stream-closed')
    expect(lateFire.taskId).toBeNull()
    expect(
      (await fires(fixture.triggerId)).some((row) => row.deliveryId === close.deliveryId),
    ).toBe(false)
  })
}
