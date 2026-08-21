// RFC-294 pre-refactor compatibility oracle — a webhook launch must retain its
// durable delivery -> fire -> task -> node lineage when the selected runtime
// fails.  This spec intentionally enters through the public GitLab webhook
// ingress; posting /api/tasks directly would miss the asynchronous delivery
// dispatcher, deduplication index and webhook-owned task launch metadata.
//
// Only the external model CLI is deterministic.  The daemon, public HTTP
// routes, SQLite stores, scheduler, runtime drivers, managed child processes,
// timeout/reap path and manual node retry are all production code.

import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { querySqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

type Protocol = 'opencode' | 'claude-code'
type Scenario = 'crash' | 'terminal' | 'timeout' | 'empty' | 'wrong-nonce'

interface AgentRow {
  id: string
  name: string
}

interface WorkflowRow {
  id: string
}

interface TriggerRow {
  id: string
}

interface IngressResponse {
  deliveryId: string
  status: 'received' | 'duplicate'
  attemptCount?: number
}

interface DeliveryRow {
  id: string
  eventUuid: string | null
  attemptCount: number
  status: string
  statusReason: string | null
  eventType: string | null
  repoPath: string | null
}

interface FireRow {
  id: string
  deliveryId: string
  triggerId: string
  outcome: string
  taskId: string | null
  error: string | null
}

interface TaskRow {
  id: string
  status: string
  failureCode?: string | null
  errorMessage: string | null
  failedNodeId: string | null
  webhookSourceLink?: { kind: string; url: string } | null
}

interface NodeRunRow {
  id: string
  nodeId: string
  retryIndex: number
  status: string
  pid: number | null
  exitCode: number | null
  errorMessage: string | null
  failureCode: string | null
  opencodeSessionId: string | null
}

interface NodeRunsResponse {
  runs: NodeRunRow[]
  outputs: Array<{ nodeRunId: string; port: string; value: string }>
}

interface ScenarioTrace {
  protocol: Protocol
  agent: string
  task: string
  node: string
  callIndex: number
  resumeSessionId: string | null
  prompt: string
}

interface Fixture {
  triggerId: string
  repoPath: string
  agentName: string
}

interface DurableTaskProvenance {
  origin: string | null
  legacyTriggerId: string | null
  legacyFireId: string | null
  eventSubscriptionId: string | null
  eventDeliveryId: string | null
  triggerContextJson: string | null
}

const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'canceled', 'interrupted'])
const AGENT_NODE_ID = 'runtime_agent'
const NODE_TIMEOUT_MS = 2_500
const TIMEOUT_STUB_DELAY_MS = 4_000
// The per-node deadline starts before the compiled stub has finished parsing
// its invocation.  Keep the post-SIGTERM window comfortably wider than the
// remaining 4s response delay, otherwise a cold start can make the fixture's
// own exit timer win before it writes the deliberately late envelope.
const TIMEOUT_TERMINATION_DELAY_MS = 6_000

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

function scenarioAgent(scenario: Scenario): string {
  return `webhook-runtime-${scenario}`
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM still means the process exists.  Treat every other failure as the
    // expected post-reap ESRCH/invalid-pid shape.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

for (const protocol of ['opencode', 'claude-code'] as const) {
  test.describe(`webhook runtime failure lineage: ${protocol}`, () => {
    let daemon: DaemonHandle
    let root: string
    let stateDir: string
    const fixtures = new Map<Scenario, Fixture>()

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

    async function expectHttp(response: Response, status: number, label: string): Promise<void> {
      if (response.status === status) return
      throw new Error(
        `${label}: expected HTTP ${status}, got ${response.status}: ${await response.text()}`,
      )
    }

    async function postJson<T>(path: string, body: unknown): Promise<T> {
      const response = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) })
      await expectHttp(response, 201, `POST ${path}`)
      return (await response.json()) as T
    }

    async function waitFor<T>(
      read: () => Promise<T>,
      predicate: (value: T) => boolean,
      label: string,
      timeoutMs = 30_000,
    ): Promise<T> {
      const deadline = Date.now() + timeoutMs
      let last: T | undefined
      while (Date.now() < deadline) {
        last = await read()
        if (predicate(last)) return last
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      }
      throw new Error(`${label} timed out; last=${JSON.stringify(last)}`)
    }

    async function createFixture(endpointId: string, scenario: Scenario): Promise<void> {
      const agentName = scenarioAgent(scenario)
      const agent = await postJson<AgentRow>('/api/agents', {
        name: agentName,
        description: `${protocol} webhook ${scenario} runtime failure fixture`,
        outputs: ['answer'],
        outputKinds: { answer: 'string' },
        readonly: true,
        runtime: protocol,
        bodyMd: `[AW_SCENARIO_AGENT:${agentName}]\nFollow the workflow protocol exactly.`,
      })
      const workflow = await postJson<WorkflowRow>('/api/workflows', {
        name: `${protocol}-webhook-runtime-${scenario}`,
        description: 'Webhook-to-runtime failure durability fixture.',
        definition: {
          $schema_version: 5,
          inputs: [],
          nodes: [
            {
              id: AGENT_NODE_ID,
              kind: 'agent-single',
              agentId: agent.id,
              agentName: agent.name,
              promptTemplate: [
                'AW_SCENARIO_TASK={{__task_id__}}',
                `AW_SCENARIO_NODE=${AGENT_NODE_ID}`,
                'repo={{trigger.webhook.repo_path}}',
                'pipeline={{trigger.webhook.pipeline_status}}',
              ].join('\n'),
              position: { x: 240, y: 0 },
            },
            {
              id: 'final_output',
              kind: 'output',
              ports: [{ name: 'answer', bind: { nodeId: AGENT_NODE_ID, portName: 'answer' } }],
              position: { x: 600, y: 0 },
            },
          ],
          edges: [
            {
              id: 'runtime_to_output',
              source: { nodeId: AGENT_NODE_ID, portName: 'answer' },
              target: { nodeId: 'final_output', portName: 'answer' },
            },
          ],
        },
      })
      const repoPath = `runtime-faults/${protocol}/${scenario}`
      const trigger = await postJson<TriggerRow>('/api/webhook-triggers', {
        name: `${protocol}-runtime-${scenario}`,
        endpointId,
        repoScope: { kind: 'exact', paths: [repoPath] },
        eventTypes: ['pipeline_failed'],
        ignoreUsernames: [],
        autoRegisterRepos: false,
        launchKind: 'workflow',
        launchRefId: workflow.id,
        launchPayload: { inputs: {}, scratch: true },
      })
      fixtures.set(scenario, { triggerId: trigger.id, repoPath, agentName })
    }

    function webhookBody(repoPath: string): string {
      return JSON.stringify({
        object_kind: 'pipeline',
        user: { username: 'runtime-operator' },
        project: {
          path_with_namespace: repoPath,
          web_url: `https://gitlab.invalid/${repoPath}`,
          git_http_url: `https://gitlab.invalid/${repoPath}.git`,
          git_ssh_url: `git@gitlab.invalid:${repoPath}.git`,
        },
        object_attributes: {
          id: 294,
          ref: 'feature/runtime-fault',
          status: 'failed',
          sha: '294294',
          url: `https://gitlab.invalid/${repoPath}/-/pipelines/294`,
        },
      })
    }

    async function deliver(
      endpoint: { urlToken: string; secret: string },
      fixture: Fixture,
      eventUuid: string,
    ): Promise<IngressResponse> {
      const response = await fetch(`${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-gitlab-token': endpoint.secret,
          'x-gitlab-event': 'Pipeline Hook',
          'x-gitlab-event-uuid': eventUuid,
        },
        body: webhookBody(fixture.repoPath),
      })
      await expectHttp(response, 200, `deliver ${eventUuid}`)
      return (await response.json()) as IngressResponse
    }

    async function delivery(id: string): Promise<DeliveryRow> {
      const response = await apiFetch(`/api/webhook-deliveries/${id}`)
      await expectHttp(response, 200, `read delivery ${id}`)
      return (await response.json()) as DeliveryRow
    }

    async function fires(triggerId: string): Promise<FireRow[]> {
      const response = await apiFetch(`/api/webhook-triggers/${triggerId}/fires`)
      await expectHttp(response, 200, `read fires ${triggerId}`)
      return (await response.json()) as FireRow[]
    }

    async function task(taskId: string): Promise<TaskRow> {
      const response = await apiFetch(`/api/tasks/${taskId}`)
      await expectHttp(response, 200, `read task ${taskId}`)
      return (await response.json()) as TaskRow
    }

    async function nodeRuns(taskId: string): Promise<NodeRunsResponse> {
      const response = await apiFetch(`/api/tasks/${taskId}/node-runs`)
      await expectHttp(response, 200, `read node runs ${taskId}`)
      return (await response.json()) as NodeRunsResponse
    }

    async function nodeEvents(taskId: string, nodeRunId: string): Promise<unknown> {
      const response = await apiFetch(`/api/tasks/${taskId}/node-runs/${nodeRunId}/events`)
      await expectHttp(response, 200, `read node events ${nodeRunId}`)
      return response.json()
    }

    async function waitForLaunchedLineage(
      fixture: Fixture,
      deliveryId: string,
    ): Promise<{ delivery: DeliveryRow; fire: FireRow; task: TaskRow }> {
      const durableDelivery = await waitFor(
        () => delivery(deliveryId),
        (row) => row.status === 'matched',
        `delivery ${deliveryId} matched`,
      )
      const history = await waitFor(
        () => fires(fixture.triggerId),
        (rows) => rows.some((row) => row.deliveryId === deliveryId && row.outcome === 'launched'),
        `fire for delivery ${deliveryId}`,
      )
      const fire = history.find(
        (row) => row.deliveryId === deliveryId && row.outcome === 'launched',
      )!
      expect(fire.taskId).not.toBeNull()
      const terminalTask = await waitFor(
        () => task(fire.taskId!),
        (row) => TERMINAL_TASK_STATUSES.has(row.status),
        `task ${fire.taskId} terminal`,
        45_000,
      )
      expect(terminalTask.id).toBe(fire.taskId)
      expect(terminalTask.webhookSourceLink).toEqual({
        kind: 'pipeline',
        url: `https://gitlab.invalid/${fixture.repoPath}/-/pipelines/294`,
      })
      const provenance = querySqlite<DurableTaskProvenance>(
        join(daemon.home, 'db.sqlite'),
        `SELECT launch_origin AS origin,
                webhook_trigger_id AS legacyTriggerId,
                webhook_fire_id AS legacyFireId,
                event_subscription_id AS eventSubscriptionId,
                event_delivery_id AS eventDeliveryId,
                trigger_context_json AS triggerContextJson
           FROM tasks WHERE id = ?`,
        [terminalTask.id],
      )
      expect(provenance).toHaveLength(1)
      expect(provenance[0]).toMatchObject({
        origin: 'event',
        legacyTriggerId: null,
        legacyFireId: null,
        eventDeliveryId: fire.id,
      })
      expect(provenance[0]?.eventSubscriptionId).toContain(`route:${fixture.triggerId}:`)
      expect(provenance[0]?.triggerContextJson).not.toBeNull()
      expect(JSON.parse(provenance[0]!.triggerContextJson!)).toMatchObject({
        trigger: {
          webhook: {
            event_type: 'pipeline_failed',
            repo_path: fixture.repoPath,
            pipeline_url: `https://gitlab.invalid/${fixture.repoPath}/-/pipelines/294`,
          },
        },
      })
      return { delivery: durableDelivery, fire, task: terminalTask }
    }

    function agentRuns(data: NodeRunsResponse): NodeRunRow[] {
      return data.runs
        .filter((row) => row.nodeId === AGENT_NODE_ID)
        .sort((left, right) => left.retryIndex - right.retryIndex)
    }

    function tracesFor(taskId: string): ScenarioTrace[] {
      try {
        return readFileSync(join(stateDir, 'trace.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as ScenarioTrace)
          .filter((trace) => trace.task === taskId)
      } catch {
        return []
      }
    }

    async function expectProcessesReaped(runs: NodeRunRow[]): Promise<void> {
      const pids = runs.map((run) => run.pid)
      expect(pids.every((pid): pid is number => typeof pid === 'number' && pid > 0)).toBe(true)
      await waitFor(
        async () => pids.map((pid) => (pid === null ? false : pidIsAlive(pid))),
        (alive) => alive.every((value) => value === false),
        `runtime pids ${pids.join(',')} reaped`,
        10_000,
      )
    }

    async function retryNodeAfterDriverRelease(taskId: string, nodeRunId: string): Promise<void> {
      const deadline = Date.now() + 10_000
      let last = ''
      while (Date.now() < deadline) {
        const response = await apiFetch(
          `/api/tasks/${taskId}/nodes/${nodeRunId}/retry?cascade=false`,
          { method: 'POST' },
        )
        if (response.ok) return
        last = await response.text()
        if (response.status !== 409 || !last.includes('task-still-running')) {
          throw new Error(`retry ${nodeRunId} failed: HTTP ${response.status}: ${last}`)
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      }
      throw new Error(`task driver did not release for retry ${nodeRunId}; last=${last}`)
    }

    let endpoint: { id: string; urlToken: string; secret: string }

    test.beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), `aw-webhook-runtime-${protocol}-`))
      stateDir = join(root, 'state')
      mkdirSync(stateDir)
      const planFile = join(root, 'scenario-plan.json')
      writeFileSync(
        planFile,
        JSON.stringify({
          version: 1,
          agents: {
            [scenarioAgent('crash')]: [
              { exitCode: 23, stderr: 'simulated-webhook-runtime-crash/{{protocol}}/0' },
              { exitCode: 23, stderr: 'simulated-webhook-runtime-crash/{{protocol}}/1' },
              {
                requirePrompt: [`runtime-faults/${protocol}/crash`],
                output: { answer: 'manual-retry-recovered/{{protocol}}' },
              },
            ],
            [scenarioAgent('timeout')]: [
              {
                requirePrompt: [`runtime-faults/${protocol}/timeout`],
                delayMs: TIMEOUT_STUB_DELAY_MS,
                terminationDelayMs: TIMEOUT_TERMINATION_DELAY_MS,
                output: { answer: 'timeout-output-must-never-project' },
              },
            ],
            [scenarioAgent('terminal')]: [
              {
                requirePrompt: [`runtime-faults/${protocol}/terminal`],
                terminalError: 'provider quota rejected the webhook runtime request',
              },
            ],
            [scenarioAgent('empty')]: [
              {
                silentExit: true,
                stderr: 'diagnostic-only-empty-output/{{protocol}}',
              },
            ],
            [scenarioAgent('wrong-nonce')]: [
              {
                rawText:
                  '<workflow-output nonce="wrong-webhook-nonce"><port name="answer">corrupt-output-must-not-project</port></workflow-output>',
                sessionId: 'wrong-nonce-session-{{protocol}}',
              },
            ],
          },
        }),
      )
      daemon = await startDaemon({
        stubMode: 'runtime-scenario',
        extraEnv: { SCENARIO_PLAN_FILE: planFile, SCENARIO_STATE_DIR: stateDir },
        // Each failed node gets exactly one automatic retry.  2.5s leaves
        // headroom for a cold compiled-stub spawn while remaining below the
        // timeout scenario's 4s late output.
        configOverrides: {
          defaultNodeRetries: 1,
          // RFC-313: 上限已是两个预算的乘积；置 0 保持「1+defaultNodeRetries」的既有计数。
          sessionRestartBudget: 0,
          defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
        },
      })
      endpoint = await postJson('/api/webhook-endpoints', {
        name: `${protocol}-runtime-failure-endpoint`,
      })
      for (const scenario of ['crash', 'terminal', 'timeout', 'empty', 'wrong-nonce'] as const) {
        await createFixture(endpoint.id, scenario)
      }
    })

    test.afterAll(async () => {
      if (daemon !== undefined) await daemon.stop()
      if (root !== undefined) rmSync(root, { recursive: true, force: true })
    })

    test('concurrent duplicate delivery launches one crashing task; manual retry proves driver/process release', async () => {
      const fixture = fixtures.get('crash')!
      const uuid = `${protocol}-webhook-crash-dedup`
      const ingress = await Promise.all([
        deliver(endpoint, fixture, uuid),
        deliver(endpoint, fixture, uuid),
      ])
      expect(ingress.map((row) => row.status).sort()).toEqual(['duplicate', 'received'])
      expect(new Set(ingress.map((row) => row.deliveryId)).size).toBe(1)
      expect(ingress.find((row) => row.status === 'duplicate')?.attemptCount).toBe(2)

      const deliveryId = ingress[0]!.deliveryId
      const lineage = await waitForLaunchedLineage(fixture, deliveryId)
      expect(lineage.delivery).toMatchObject({
        eventUuid: uuid,
        attemptCount: 2,
        status: 'matched',
        statusReason: null,
        eventType: 'pipeline_failed',
        repoPath: fixture.repoPath,
      })
      const history = await fires(fixture.triggerId)
      expect(history.filter((row) => row.deliveryId === deliveryId)).toHaveLength(1)
      expect(lineage.fire).toMatchObject({ outcome: 'launched', error: null })
      expect(lineage.task).toMatchObject({
        status: 'failed',
        failedNodeId: AGENT_NODE_ID,
        failureCode: null,
      })

      const failedData = await nodeRuns(lineage.task.id)
      const failedRuns = agentRuns(failedData)
      expect(failedRuns.map((run) => run.retryIndex)).toEqual([0, 1])
      expect(failedRuns.map((run) => run.status)).toEqual(['failed', 'failed'])
      expect(failedRuns.map((run) => run.exitCode)).toEqual([23, 23])
      expect(
        // 前缀锁：exit code 必须在行首，其后可跟 T132 的 `; stderr tail: …`。
        failedRuns.every(
          (run) => run.errorMessage?.startsWith(`${protocol} exited with code 23`) === true,
        ),
      ).toBe(true)
      expect(failedData.outputs.filter((row) => row.port === 'answer')).toEqual([])
      await expectProcessesReaped(failedRuns)

      // retryNode rejects while task.ts still owns an active scheduler.  A
      // successful public retry therefore proves that the terminal driver was
      // released, not merely that the task row flipped to failed.
      await retryNodeAfterDriverRelease(lineage.task.id, failedRuns[1]!.id)
      const recovered = await waitFor(
        () => task(lineage.task.id),
        (row) => row.status === 'done',
        `manually retried task ${lineage.task.id} done`,
      )
      expect(recovered.status).toBe('done')
      const recoveredData = await nodeRuns(lineage.task.id)
      const allRuns = agentRuns(recoveredData)
      // retryNode first mints the durable `queued for retry` failed marker;
      // runTask then mints the process-owning attempt that consumes it.
      expect(allRuns.map((run) => run.status)).toEqual(['failed', 'failed', 'failed', 'done'])
      const queued = allRuns.find((run) => run.errorMessage === 'queued for retry')
      expect(queued).toMatchObject({ status: 'failed', pid: null })
      const recoveredRun = allRuns.find((run) => run.status === 'done')!
      expect(
        recoveredData.outputs.find(
          (row) => row.nodeRunId === recoveredRun.id && row.port === 'answer',
        )?.value,
      ).toBe(`manual-retry-recovered/${protocol}`)
      expect(tracesFor(lineage.task.id).map((trace) => trace.callIndex)).toEqual([0, 1, 2])
      expect(tracesFor(lineage.task.id)[2]?.prompt).toContain(fixture.repoPath)
      await expectProcessesReaped([...failedRuns, recoveredRun])
    })

    test('runtime timeout kills every attempt, records node-timeout and suppresses late output', async () => {
      const fixture = fixtures.get('timeout')!
      const uuid = `${protocol}-webhook-runtime-timeout`
      const accepted = await deliver(endpoint, fixture, uuid)
      expect(accepted.status).toBe('received')
      const lineage = await waitForLaunchedLineage(fixture, accepted.deliveryId)

      expect(lineage.delivery).toMatchObject({
        eventUuid: uuid,
        attemptCount: 1,
        status: 'matched',
        statusReason: null,
      })
      expect(lineage.fire).toMatchObject({ outcome: 'launched', error: null })
      expect(lineage.task).toMatchObject({ status: 'failed', failedNodeId: AGENT_NODE_ID })

      const data = await nodeRuns(lineage.task.id)
      const runs = agentRuns(data)
      expect(runs.map((run) => run.retryIndex)).toEqual([0, 1])
      expect(runs.map((run) => run.status)).toEqual(['failed', 'failed'])
      expect(
        runs.every((run) => run.errorMessage === `node-timeout: exceeded ${NODE_TIMEOUT_MS}ms`),
      ).toBe(true)
      expect(data.outputs.filter((row) => row.port === 'answer')).toEqual([])
      expect(tracesFor(lineage.task.id).map((trace) => trace.callIndex)).toEqual([0, 1])
      expect(
        tracesFor(lineage.task.id).every((trace) => trace.prompt.includes(fixture.repoPath)),
      ).toBe(true)
      await expectProcessesReaped(runs)

      // On POSIX, `terminationDelayMs` keeps the child alive after SIGTERM long
      // enough for the valid envelope to be emitted.  Wait on the exact durable
      // marker instead of coupling the public task read to an internal event
      // projection instant; both attempts still have to prove real late bytes.
      // Windows has no signal handler fixture; it still locks timeout/reap and
      // zero durable outputs without pretending the late bytes were emitted.
      if (process.platform !== 'win32') {
        const lateEventsByRun = await waitFor(
          () => Promise.all(runs.map((run) => nodeEvents(lineage.task.id, run.id))),
          (eventsByRun) =>
            eventsByRun.every((events) =>
              JSON.stringify(events).includes('timeout-output-must-never-project'),
            ),
          `late timeout envelopes for node runs ${runs.map((run) => run.id).join(',')}`,
          10_000,
        )
        for (const lateEvents of lateEventsByRun) {
          expect(JSON.stringify(lateEvents)).toContain('timeout-output-must-never-project')
        }
      }

      const settled = await nodeRuns(lineage.task.id)
      expect(agentRuns(settled)).toHaveLength(2)
      expect(settled.outputs.filter((row) => row.port === 'answer')).toEqual([])
      expect(tracesFor(lineage.task.id)).toHaveLength(2)
      expect((await task(lineage.task.id)).status).toBe('failed')
    })

    // Claude's native stream has a documented terminal result record.  The
    // OpenCode driver currently exposes no parseTerminalResultError contract;
    // feeding it an `error` event degrades to envelope-missing and burns a
    // retry.  That is a red-first RFC-294 gap, not behavior to lock in here.
    if (protocol === 'claude-code') {
      test('structured runtime terminal error is permanent and does not burn the retry budget', async () => {
        const fixture = fixtures.get('terminal')!
        const uuid = `${protocol}-webhook-runtime-terminal-error`
        const accepted = await deliver(endpoint, fixture, uuid)
        expect(accepted.status).toBe('received')
        const lineage = await waitForLaunchedLineage(fixture, accepted.deliveryId)

        expect(lineage.delivery).toMatchObject({
          eventUuid: uuid,
          status: 'matched',
          statusReason: null,
        })
        expect(lineage.fire).toMatchObject({ outcome: 'launched', error: null })
        expect(lineage.task).toMatchObject({
          status: 'failed',
          failedNodeId: AGENT_NODE_ID,
          failureCode: 'runtime-result-error',
        })

        const data = await nodeRuns(lineage.task.id)
        const runs = agentRuns(data)
        expect(runs).toHaveLength(1)
        expect(runs[0]).toMatchObject({
          retryIndex: 0,
          status: 'failed',
          exitCode: 0,
          failureCode: 'runtime-result-error',
          errorMessage: 'runtime-result-error: provider quota rejected the webhook runtime request',
        })
        expect(data.outputs.filter((row) => row.port === 'answer')).toEqual([])
        expect(tracesFor(lineage.task.id).map((trace) => trace.callIndex)).toEqual([0])
        expect(tracesFor(lineage.task.id)[0]?.prompt).toContain(fixture.repoPath)
        await expectProcessesReaped(runs)
      })
    }

    test('stderr-only clean runtime exit retries fresh and never creates a ghost value', async () => {
      const fixture = fixtures.get('empty')!
      const uuid = `${protocol}-webhook-runtime-empty`
      const accepted = await deliver(endpoint, fixture, uuid)
      expect(accepted.status).toBe('received')
      const lineage = await waitForLaunchedLineage(fixture, accepted.deliveryId)

      expect(lineage.delivery).toMatchObject({ status: 'matched', statusReason: null })
      expect(lineage.fire).toMatchObject({ outcome: 'launched', error: null })
      expect(lineage.task).toMatchObject({
        status: 'failed',
        failedNodeId: AGENT_NODE_ID,
        failureCode: 'envelope-missing',
      })

      const data = await nodeRuns(lineage.task.id)
      const runs = agentRuns(data)
      expect(runs.map((run) => run.retryIndex)).toEqual([0, 1])
      expect(runs.map((run) => run.status)).toEqual(['failed', 'failed'])
      expect(runs.every((run) => run.exitCode === 0)).toBe(true)
      expect(runs.every((run) => run.failureCode === 'envelope-missing')).toBe(true)
      expect(
        runs.every((run) => run.errorMessage === 'no <workflow-output> envelope found in stdout'),
      ).toBe(true)
      expect(data.outputs.filter((row) => row.port === 'answer')).toEqual([])

      const traces = tracesFor(lineage.task.id)
      expect(traces.map((trace) => trace.callIndex)).toEqual([0, 1])
      expect(traces[0]?.prompt).toContain(fixture.repoPath)
      expect(runs.every((run) => run.opencodeSessionId === null)).toBe(true)
      expect(traces[1]?.resumeSessionId).toBeNull()
      expect(traces[1]?.prompt).toContain(fixture.repoPath)
      expect(traces.every((trace) => !trace.prompt.includes('Envelope missing — follow-up'))).toBe(
        true,
      )
      await expectProcessesReaped(runs)
    })

    test('well-formed output carrying the wrong nonce is rejected and never becomes a durable port', async () => {
      const fixture = fixtures.get('wrong-nonce')!
      const uuid = `${protocol}-webhook-runtime-wrong-nonce`
      const accepted = await deliver(endpoint, fixture, uuid)
      expect(accepted.status).toBe('received')
      const lineage = await waitForLaunchedLineage(fixture, accepted.deliveryId)

      expect(lineage.delivery).toMatchObject({
        eventUuid: uuid,
        status: 'matched',
        statusReason: null,
      })
      expect(lineage.fire).toMatchObject({ outcome: 'launched', error: null })
      expect(lineage.task).toMatchObject({
        status: 'failed',
        failedNodeId: AGENT_NODE_ID,
        failureCode: 'envelope-missing',
      })

      const data = await nodeRuns(lineage.task.id)
      const runs = agentRuns(data)
      expect(runs.map((run) => run.retryIndex)).toEqual([0, 1])
      expect(runs.map((run) => run.status)).toEqual(['failed', 'failed'])
      expect(runs.every((run) => run.exitCode === 0)).toBe(true)
      expect(runs.every((run) => run.failureCode === 'envelope-missing')).toBe(true)
      expect(data.outputs.filter((row) => row.port === 'answer')).toEqual([])

      // Prove the runtime really emitted a structurally complete envelope and
      // that rejection was nonce-bound, rather than accidentally exercising
      // the empty-output case above.
      const firstEvents = JSON.stringify(await nodeEvents(lineage.task.id, runs[0]!.id))
      expect(firstEvents).toContain('wrong-webhook-nonce')
      expect(firstEvents).toContain('corrupt-output-must-not-project')
      const traces = tracesFor(lineage.task.id)
      expect(traces.map((trace) => trace.callIndex)).toEqual([0, 1])
      expect(traces[0]?.prompt).toContain(fixture.repoPath)
      expect(traces[1]?.resumeSessionId).toBe(`wrong-nonce-session-${protocol}`)
      expect(traces[1]?.prompt).toContain('Envelope missing — follow-up')
      await expectProcessesReaped(runs)
    })
  })
}
