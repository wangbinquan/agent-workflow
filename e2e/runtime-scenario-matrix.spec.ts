// Runtime parity E2E with no real model/provider dependency.
//
// For each built-in runtime this launches the production daemon and drives the
// public APIs, SQLite scheduler, real Git worktrees, runtime driver/parser,
// envelope protocol, retries, timeout/cancel and human clarification. Only the
// external CLI/model is replaced by the same data-driven scenario binary.

import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

type Protocol = 'opencode' | 'claude-code'

interface AgentRow {
  id: string
  name: string
}

interface WorkflowRow {
  id: string
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
  retryIndex: number
  status: string
  errorMessage: string | null
  failureCode: string | null
  opencodeSessionId: string | null
}

interface NodeRunsResponse {
  runs: NodeRunRow[]
  outputs: Array<{ nodeRunId: string; port: string; value: string }>
}

interface ClarifyRow {
  kind: 'self' | 'cross'
  askingNodeId: string
  intermediaryNodeRunId: string
  iteration: number
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

const TERMINAL = new Set(['done', 'failed', 'canceled', 'interrupted'])
const SCENARIO_AGENTS = {
  success: 'scenario-success',
  memory: 'scenario-memory-injection',
  retry: 'scenario-retry',
  envelope: 'scenario-envelope',
  clarify: 'scenario-clarify',
  sessionMissing: 'scenario-session-missing',
  timeout: 'scenario-timeout',
  cancel: 'scenario-cancel',
} as const
const RUNTIME_SCENARIO_TIMEOUT_MS = 8_000
const RUNTIME_TIMEOUT_DELAY_MS = 12_000

test.setTimeout(180_000)

for (const protocol of ['opencode', 'claude-code'] as const) {
  test.describe(`deterministic runtime parity: ${protocol}`, () => {
    let daemon: DaemonHandle
    let root: string
    let repoDir: string
    let stateDir: string
    const agents = new Map<string, AgentRow>()
    let taskSequence = 0

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

    async function expectHttp(response: Response, status: number, what: string): Promise<void> {
      if (response.status === status) return
      throw new Error(
        `${what}: expected HTTP ${status}, got ${response.status}: ${await response.text()}`,
      )
    }

    async function createWorkflow(
      scenario: keyof typeof SCENARIO_AGENTS,
      options: { clarify?: boolean } = {},
    ): Promise<WorkflowRow> {
      const agent = agents.get(SCENARIO_AGENTS[scenario])
      if (agent === undefined) throw new Error(`missing scenario agent: ${scenario}`)
      const nodes: Array<Record<string, unknown>> = [
        { id: 'request_input', kind: 'input', inputKey: 'request', position: { x: 0, y: 0 } },
        {
          id: 'scenario_agent',
          kind: 'agent-single',
          agentId: agent.id,
          promptTemplate: [
            'AW_SCENARIO_TASK={{__task_id__}}',
            'AW_SCENARIO_NODE=scenario_agent',
            'request={{request}}',
          ].join('\n'),
          position: { x: 300, y: 0 },
        },
        {
          id: 'final_output',
          kind: 'output',
          ports: [{ name: 'answer', bind: { nodeId: 'scenario_agent', portName: 'answer' } }],
          position: { x: 720, y: 0 },
        },
      ]
      const edges: Array<Record<string, unknown>> = [
        {
          id: 'request_to_agent',
          source: { nodeId: 'request_input', portName: 'request' },
          target: { nodeId: 'scenario_agent', portName: 'request' },
        },
        {
          id: 'agent_to_output',
          source: { nodeId: 'scenario_agent', portName: 'answer' },
          target: { nodeId: 'final_output', portName: 'answer' },
        },
      ]
      if (options.clarify === true) {
        nodes.push({
          id: 'clarify_gate',
          kind: 'clarify',
          title: 'Runtime parity clarification',
          description: 'Resume the same native runtime session after a human answer.',
          sessionMode: 'inline',
          position: { x: 500, y: 220 },
        })
        edges.push(
          {
            id: 'agent_to_clarify',
            source: { nodeId: 'scenario_agent', portName: '__clarify__' },
            target: { nodeId: 'clarify_gate', portName: 'questions' },
          },
          {
            id: 'clarify_to_agent',
            source: { nodeId: 'clarify_gate', portName: 'answers' },
            target: { nodeId: 'scenario_agent', portName: '__clarify_response__' },
          },
        )
      }

      const response = await apiFetch('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: `${protocol}-${scenario}-${crypto.randomUUID()}`,
          description: `Deterministic ${protocol} ${scenario} parity workflow`,
          definition: {
            $schema_version: 4,
            inputs: [{ kind: 'text', key: 'request', label: 'Request', required: true }],
            nodes,
            edges,
          },
        }),
      })
      await expectHttp(response, 201, `create ${scenario} workflow`)
      return (await response.json()) as WorkflowRow
    }

    async function launch(
      scenario: keyof typeof SCENARIO_AGENTS,
      options: { clarify?: boolean; request?: string } = {},
    ): Promise<TaskRow> {
      const workflow = await createWorkflow(scenario, { clarify: options.clarify })
      taskSequence += 1
      const response = await apiFetch('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: workflow.id,
          expectedWorkflowVersion: workflow.version,
          expectedWorkflowSnapshotHash: workflow.snapshotHash,
          name: `${protocol}-${scenario}-${taskSequence}`,
          repoUrl: repoRemoteUrl(repoDir),
          ref: 'main',
          inputs: { request: options.request ?? `${scenario}-request` },
        }),
      })
      await expectHttp(response, 201, `launch ${scenario} task`)
      return (await response.json()) as TaskRow
    }

    async function waitForTask(
      taskId: string,
      predicate: (task: TaskRow) => boolean,
      timeoutMs = 45_000,
    ): Promise<TaskRow> {
      const deadline = Date.now() + timeoutMs
      let last: TaskRow = { id: taskId, status: 'pending' }
      while (Date.now() < deadline) {
        const response = await apiFetch(`/api/tasks/${taskId}`)
        if (response.ok) {
          last = (await response.json()) as TaskRow
          if (predicate(last)) return last
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`task ${taskId} timed out; last=${JSON.stringify(last)}`)
    }

    function waitForTerminal(taskId: string): Promise<TaskRow> {
      return waitForTask(taskId, (task) => TERMINAL.has(task.status))
    }

    async function nodeRuns(taskId: string): Promise<NodeRunsResponse> {
      const response = await apiFetch(`/api/tasks/${taskId}/node-runs`)
      await expectHttp(response, 200, `read node runs for ${taskId}`)
      return (await response.json()) as NodeRunsResponse
    }

    async function answerFirstClarification(taskId: string): Promise<ClarifyRow> {
      expect((await waitForTask(taskId, (row) => row.status === 'awaiting_human')).status).toBe(
        'awaiting_human',
      )
      const clarifyResponse = await apiFetch(
        `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
      )
      await expectHttp(clarifyResponse, 200, 'list clarification')
      const clarification = ((await clarifyResponse.json()) as ClarifyRow[])[0]
      expect(clarification).toMatchObject({ kind: 'self', askingNodeId: 'scenario_agent' })

      const answerResponse = await apiFetch(
        `/api/clarify/${clarification!.intermediaryNodeRunId}/answers`,
        {
          method: 'POST',
          body: JSON.stringify({
            answers: [
              {
                questionId: 'q-runtime',
                selectedOptionIndices: [0],
                selectedOptionLabels: [],
                customText: '',
              },
            ],
            directive: 'stop',
            ifMatchIteration: clarification!.iteration,
          }),
        },
      )
      await expectHttp(answerResponse, 200, 'answer clarification')
      return clarification!
    }

    function agentRuns(data: NodeRunsResponse): NodeRunRow[] {
      return data.runs
        .filter((run) => run.nodeId === 'scenario_agent')
        .sort((left, right) => left.id.localeCompare(right.id))
    }

    function output(data: NodeRunsResponse, run: NodeRunRow): string | undefined {
      return data.outputs.find(
        (candidate) => candidate.nodeRunId === run.id && candidate.port === 'answer',
      )?.value
    }

    async function expectDone(task: TaskRow, scenario: string): Promise<NodeRunsResponse> {
      const terminal = await waitForTerminal(task.id)
      const data = await nodeRuns(task.id)
      if (terminal.status !== 'done') {
        const events = await Promise.all(
          data.runs
            .filter((run) => run.nodeId === 'scenario_agent')
            .map(async (run) => {
              const response = await apiFetch(`/api/tasks/${task.id}/node-runs/${run.id}/events`)
              return {
                runId: run.id,
                body: response.ok ? await response.json() : await response.text(),
              }
            }),
        )
        let allTraces: ScenarioTrace[] = []
        try {
          allTraces = readFileSync(join(stateDir, 'trace.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as ScenarioTrace)
        } catch {
          // Diagnostics only.
        }
        throw new Error(
          `${protocol} ${scenario} ended ${terminal.status}: ${JSON.stringify({
            taskError: terminal.errorMessage,
            runs: data.runs.map((run) => ({
              nodeId: run.nodeId,
              retryIndex: run.retryIndex,
              status: run.status,
              failureCode: run.failureCode,
              errorMessage: run.errorMessage,
            })),
            traces: allTraces.map((trace) => ({
              task: trace.task,
              node: trace.node,
              callIndex: trace.callIndex,
              agent: trace.agent,
              resumeSessionId: trace.resumeSessionId,
              prompt: trace.prompt,
            })),
            events,
          })}`,
        )
      }
      return data
    }

    function tracesFor(taskId: string): ScenarioTrace[] {
      let source = ''
      try {
        source = readFileSync(join(stateDir, 'trace.jsonl'), 'utf8')
      } catch {
        return []
      }
      return source
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as ScenarioTrace)
        .filter((trace) => trace.task === taskId)
    }

    async function waitForTrace(taskId: string, count: number): Promise<ScenarioTrace[]> {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const traces = tracesFor(taskId)
        if (traces.length >= count) return traces
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error(`scenario trace ${taskId} did not reach ${count} entries`)
    }

    test.beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), `aw-${protocol}-scenario-`))
      repoDir = join(root, 'repo')
      stateDir = join(root, 'state')
      mkdirSync(repoDir)
      writeFileSync(join(repoDir, 'README.md'), `# ${protocol} runtime scenario\n`)
      initGitRepo(repoDir)
      const planFile = join(root, 'scenario-plan.json')
      writeFileSync(
        planFile,
        JSON.stringify({
          version: 1,
          agents: {
            [SCENARIO_AGENTS.success]: [
              {
                requirePrompt: ['success-request'],
                output: { answer: 'success/{{protocol}}/{{task}}' },
                writeFiles: { 'runtime-proof.txt': 'proof from {{protocol}} for {{task}}\n' },
                sessionId: 'session-{{protocol}}-success',
                tokens: { input: 31, output: 9, cacheRead: 4, cacheCreate: 2 },
              },
            ],
            [SCENARIO_AGENTS.memory]: [
              {
                requireSystemPrompt: [
                  '--- BEGIN INJECTED MEMORY ---',
                  'Permanent runtime memory',
                  'PERMANENT_MEMORY_PROOF',
                  '--- END INJECTED MEMORY ---',
                ],
                output: { answer: 'memory-injected/{{protocol}}' },
              },
            ],
            [SCENARIO_AGENTS.retry]: [
              { exitCode: 19, stderr: 'first-attempt-crash/{{protocol}}' },
              { output: { answer: 'retry-recovered/{{protocol}}' } },
            ],
            [SCENARIO_AGENTS.envelope]: [
              {
                rawText: 'first attempt intentionally omitted its envelope',
                sessionId: 'session-{{protocol}}-envelope',
              },
              {
                output: { answer: 'envelope-recovered/{{protocol}}' },
                sessionId: 'session-{{protocol}}-envelope',
              },
            ],
            [SCENARIO_AGENTS.clarify]: [
              {
                clarify: {
                  questions: [
                    {
                      id: 'q-runtime',
                      title: 'Continue the runtime parity task?',
                      kind: 'single',
                      recommended: true,
                      options: ['Continue', 'Stop'],
                    },
                  ],
                },
                sessionId: 'session-{{protocol}}-clarify',
              },
              {
                requirePrompt: ['## Clarify Q&A'],
                output: { answer: 'clarify-resumed/{{protocol}}' },
                sessionId: 'session-{{protocol}}-clarify',
              },
            ],
            [SCENARIO_AGENTS.sessionMissing]: [
              {
                clarify: {
                  questions: [
                    {
                      id: 'q-runtime',
                      title: 'Exercise a missing native session?',
                      kind: 'single',
                      recommended: true,
                      options: ['Continue', 'Stop'],
                    },
                  ],
                },
                sessionId: 'session-{{protocol}}-missing',
              },
              {
                exitCode: 44,
                stderr: 'Error: session not found; No conversation found with session ID: missing',
              },
              {
                requirePrompt: ['## Clarify Q&A'],
                output: { answer: 'session-fallback/{{protocol}}' },
                sessionId: 'session-{{protocol}}-fresh',
              },
            ],
            [SCENARIO_AGENTS.timeout]: [
              { delayMs: RUNTIME_TIMEOUT_DELAY_MS, output: { answer: 'timeout-must-not-project' } },
            ],
            [SCENARIO_AGENTS.cancel]: [
              { delayMs: 10_000, output: { answer: 'cancel-must-not-project' } },
            ],
          },
        }),
      )

      daemon = await startDaemon({
        stubMode: 'runtime-scenario',
        extraEnv: { SCENARIO_PLAN_FILE: planFile, SCENARIO_STATE_DIR: stateDir },
        // macOS WebKit runners can spend more than two seconds paging in the
        // first compiled stub process. Keep that host cost outside the timeout
        // oracle; the dedicated scenario sleeps longer than this value, so
        // both attempts still prove the hard deadline and late-output fence.
        configOverrides: {
          defaultNodeRetries: 1,
          defaultPerNodeTimeoutMs: RUNTIME_SCENARIO_TIMEOUT_MS,
        },
      })

      for (const name of Object.values(SCENARIO_AGENTS)) {
        const response = await apiFetch('/api/agents', {
          method: 'POST',
          body: JSON.stringify({
            name,
            description: `${protocol} deterministic runtime scenario`,
            outputs: ['answer'],
            outputKinds: { answer: 'string' },
            readonly: name !== SCENARIO_AGENTS.success,
            runtime: protocol,
            bodyMd: `[AW_SCENARIO_AGENT:${name}]\nFollow the workflow protocol exactly.`,
          }),
        })
        await expectHttp(response, 201, `create ${name}`)
        const row = (await response.json()) as AgentRow
        agents.set(name, row)
      }
    })

    test.afterAll(async () => {
      if (daemon !== undefined) await daemon.stop()
      if (root !== undefined) rmSync(root, { recursive: true, force: true })
    })

    test('success: runtime parser, accounting, session, output and worktree mutation', async () => {
      const task = await launch('success')
      const data = await expectDone(task, 'success')
      const runs = agentRuns(data)
      expect(runs).toHaveLength(1)
      expect(runs[0]?.status).toBe('done')
      expect(runs[0]?.opencodeSessionId).toBe(`session-${protocol}-success`)
      expect(output(data, runs[0]!)).toBe(`success/${protocol}/${task.id}`)

      const fileResponse = await apiFetch(
        `/api/tasks/${task.id}/worktree-file?path=${encodeURIComponent('runtime-proof.txt')}`,
      )
      await expectHttp(fileResponse, 200, 'read runtime proof file')
      expect(((await fileResponse.json()) as { content: string }).content).toBe(
        `proof from ${protocol} for ${task.id}\n`,
      )

      expect(await waitForTrace(task.id, 1)).toMatchObject([
        { protocol, agent: SCENARIO_AGENTS.success, callIndex: 0, resumeSessionId: null },
      ])
    })

    test('approved memory reaches the actual native runtime prompt; candidates stay behind approval', async () => {
      const createResponse = await apiFetch('/api/memories', {
        method: 'POST',
        body: JSON.stringify({
          scopeType: 'global',
          scopeId: null,
          title: 'Permanent runtime memory',
          bodyMd: 'PERMANENT_MEMORY_PROOF must be present in the runtime prompt.',
          tags: ['runtime-injection', protocol],
        }),
      })
      await expectHttp(createResponse, 201, 'create candidate memory')
      const candidate = (await createResponse.json()) as {
        memory: { id: string; status: string }
      }
      expect(candidate.memory.status).toBe('candidate')

      const beforeApproval = await launch('memory')
      expect((await waitForTerminal(beforeApproval.id)).status).toBe('failed')
      const beforeRuns = agentRuns(await nodeRuns(beforeApproval.id))
      expect(beforeRuns).toHaveLength(2)
      expect(beforeRuns.map((run) => run.status)).toEqual(['failed', 'failed'])
      const beforeEventBodies = await Promise.all(
        beforeRuns.map(async (run) => {
          const response = await apiFetch(
            `/api/tasks/${beforeApproval.id}/node-runs/${run.id}/events`,
          )
          await expectHttp(response, 200, `read candidate-only memory events for ${run.id}`)
          return JSON.stringify(await response.json())
        }),
      )
      expect(beforeEventBodies.some((body) => body.includes('prompt is missing'))).toBe(true)

      const promoteResponse = await apiFetch(`/api/memories/${candidate.memory.id}/promote`, {
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      })
      await expectHttp(promoteResponse, 200, 'approve candidate memory')

      const afterApproval = await launch('memory')
      const afterData = await expectDone(afterApproval, 'approved memory injection')
      const afterRuns = agentRuns(afterData)
      expect(afterRuns).toHaveLength(1)
      expect(output(afterData, afterRuns[0]!)).toBe(`memory-injected/${protocol}`)
      expect(afterRuns[0]?.opencodeSessionId).toBeTruthy()
    })

    test('process crash retries in a fresh runtime process and recovers', async () => {
      const task = await launch('retry')
      const data = await expectDone(task, 'retry')
      const runs = agentRuns(data)
      expect(runs.map((run) => run.retryIndex)).toEqual([0, 1])
      expect(runs.map((run) => run.status)).toEqual(['failed', 'done'])
      expect(output(data, runs[1]!)).toBe(`retry-recovered/${protocol}`)
      expect((await waitForTrace(task.id, 2)).map((trace) => trace.callIndex)).toEqual([0, 1])
    })

    test('missing envelope gets protocol feedback, retries and recovers', async () => {
      const task = await launch('envelope')
      const data = await expectDone(task, 'envelope')
      const runs = agentRuns(data)
      expect(runs).toHaveLength(2)
      expect(runs[0]?.failureCode).toBe('envelope-missing')
      expect(runs[0]?.status).toBe('failed')
      expect(runs[1]?.status).toBe('done')
      expect(output(data, runs[1]!)).toBe(`envelope-recovered/${protocol}`)
      const traces = await waitForTrace(task.id, 2)
      expect(traces[1]?.prompt).toContain('Envelope missing — follow-up')
      expect(traces[1]?.resumeSessionId).toBe(`session-${protocol}-envelope`)
    })

    test('inline clarify pauses, accepts a human answer and resumes the native session', async () => {
      const task = await launch('clarify', { clarify: true })
      await answerFirstClarification(task.id)
      expect((await waitForTerminal(task.id)).status).toBe('done')

      const data = await nodeRuns(task.id)
      const runs = agentRuns(data)
      expect(runs).toHaveLength(2)
      expect(output(data, runs[1]!)).toBe(`clarify-resumed/${protocol}`)
      expect(runs.every((run) => run.opencodeSessionId === `session-${protocol}-clarify`)).toBe(
        true,
      )
      const traces = await waitForTrace(task.id, 2)
      expect(traces[0]?.resumeSessionId).toBeNull()
      expect(traces[1]?.resumeSessionId).toBe(`session-${protocol}-clarify`)
    })

    test('missing inline session warns and falls back to a fresh native session', async () => {
      const task = await launch('sessionMissing', { clarify: true })
      await answerFirstClarification(task.id)
      const data = await expectDone(task, 'session missing fallback')
      const runs = agentRuns(data)
      expect(output(data, runs.at(-1)!)).toBe(`session-fallback/${protocol}`)

      const traces = await waitForTrace(task.id, 3)
      expect(traces.map((trace) => trace.resumeSessionId)).toEqual([
        null,
        `session-${protocol}-missing`,
        null,
      ])

      const eventBodies = await Promise.all(
        runs.map(async (run) => {
          const response = await apiFetch(`/api/tasks/${task.id}/node-runs/${run.id}/events`)
          await expectHttp(response, 200, `read session fallback events for ${run.id}`)
          return JSON.stringify(await response.json())
        }),
      )
      expect(eventBodies.some((body) => body.includes('session-not-found'))).toBe(true)
    })

    test('timeout applies to every retry and never projects a late output', async () => {
      const task = await launch('timeout')
      expect((await waitForTerminal(task.id)).status).toBe('failed')
      const data = await nodeRuns(task.id)
      const runs = agentRuns(data)
      expect(runs).toHaveLength(2)
      expect(runs.every((run) => run.status === 'failed')).toBe(true)
      expect(runs.every((run) => run.errorMessage?.includes('node-timeout') === true)).toBe(true)
      expect(data.outputs.filter((candidate) => candidate.port === 'answer')).toEqual([])
      expect((await waitForTrace(task.id, 2)).map((trace) => trace.callIndex)).toEqual([0, 1])
    })

    test('cancel terminates the in-flight runtime and never projects output', async () => {
      const task = await launch('cancel')
      await waitForTrace(task.id, 1)
      const cancelResponse = await apiFetch(`/api/tasks/${task.id}/cancel`, { method: 'POST' })
      await expectHttp(cancelResponse, 200, 'cancel task')
      expect((await waitForTask(task.id, (row) => row.status === 'canceled')).status).toBe(
        'canceled',
      )
      const data = await nodeRuns(task.id)
      expect(agentRuns(data).map((run) => run.status)).toEqual(['canceled'])
      expect(data.outputs.filter((candidate) => candidate.port === 'answer')).toEqual([])
    })
  })
}
