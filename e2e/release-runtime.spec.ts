// Opt-in pre-release sweep against REAL OpenCode and Claude Code CLIs.
//
// This file is never activated by ordinary CI. It runs the production binary,
// inherits the operator's native runtime credentials/configuration, makes real
// model calls, and leaves a machine-readable Playwright JSON report. The broad
// state/fault matrix lives in runtime-scenario-matrix.spec.ts; this expensive
// layer is a representative compatibility proof for native CLI startup,
// streaming, tool use, session/token capture and workflow output parsing.

import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, runCommand, runGit, repoRemoteUrl } from './command'
import { defaultProductionBinaryPath, startDaemon, type DaemonHandle } from './harness'

type Protocol = 'opencode' | 'claude-code'

interface RuntimeConfig {
  protocol: Protocol
  binary: string
  model: string
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

interface NodeRunsResponse {
  runs: Array<{
    id: string
    nodeId: string
    status: string
    errorMessage: string | null
    opencodeSessionId: string | null
    tokInput: number
    tokOutput: number
    tokTotal: number
  }>
  outputs: Array<{ nodeRunId: string; port: string; value: string }>
}

const ENABLED = process.env.RUN_LIVE_RUNTIME_E2E === '1'
const REQUESTED = new Set(
  (process.env.AW_RELEASE_RUNTIME_MATRIX ?? 'opencode,claude-code')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
)
const UNKNOWN = [...REQUESTED].filter((value) => value !== 'opencode' && value !== 'claude-code')
if (UNKNOWN.length > 0) {
  throw new Error(`unknown AW_RELEASE_RUNTIME_MATRIX entries: ${UNKNOWN.join(', ')}`)
}

function shellVersion(command: string, args: string[]): string {
  return runCommand(command, args).trim()
}

function runtimeConfig(protocol: Protocol): RuntimeConfig {
  const binary =
    protocol === 'opencode'
      ? (process.env.AW_RELEASE_OPENCODE_BIN ?? 'opencode')
      : (process.env.AW_RELEASE_CLAUDE_CODE_BIN ?? 'claude')
  const model =
    protocol === 'opencode'
      ? process.env.AW_RELEASE_OPENCODE_MODEL
      : process.env.AW_RELEASE_CLAUDE_CODE_MODEL
  if (model === undefined || model.trim().length === 0) {
    throw new Error(
      `${protocol} release sweep requires ` +
        (protocol === 'opencode'
          ? 'AW_RELEASE_OPENCODE_MODEL (for example provider/model)'
          : 'AW_RELEASE_CLAUDE_CODE_MODEL'),
    )
  }
  return { protocol, binary, model: model.trim() }
}

function gitHead(): string {
  return runGit(['rev-parse', 'HEAD']).trim()
}

for (const protocol of ['opencode', 'claude-code'] as const) {
  test.describe(`pre-release real runtime: ${protocol}`, () => {
    test.skip(!ENABLED, 'real provider calls require RUN_LIVE_RUNTIME_E2E=1')
    test.skip(!REQUESTED.has(protocol), `${protocol} is not selected in AW_RELEASE_RUNTIME_MATRIX`)

    let daemon: DaemonHandle
    let root: string
    let repoDir: string
    let config: RuntimeConfig
    let cliVersion: string
    let agentId: string

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

    async function waitForTerminal(taskId: string): Promise<TaskRow> {
      const deadline = Date.now() + 10 * 60_000
      let last: TaskRow = { id: taskId, status: 'pending' }
      while (Date.now() < deadline) {
        const response = await apiFetch(`/api/tasks/${taskId}`)
        if (response.ok) {
          last = (await response.json()) as TaskRow
          if (['done', 'failed', 'canceled', 'interrupted'].includes(last.status)) return last
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      throw new Error(`live ${protocol} task timed out; last=${JSON.stringify(last)}`)
    }

    test.beforeAll(async () => {
      test.setTimeout(180_000)
      config = runtimeConfig(protocol)
      cliVersion = shellVersion(config.binary, ['--version'])
      root = mkdtempSync(join(tmpdir(), `aw-release-${protocol}-`))
      repoDir = join(root, 'repo')
      mkdirSync(repoDir)
      writeFileSync(join(repoDir, 'README.md'), `# real ${protocol} release verification\n`)
      initGitRepo(repoDir)

      daemon = await startDaemon({
        binary: process.env.AW_RELEASE_BINARY ?? defaultProductionBinaryPath(),
        runtimeMode: 'live',
        runtimeBinaries:
          protocol === 'opencode' ? { opencode: config.binary } : { claudeCode: config.binary },
        runtimeModels:
          protocol === 'opencode' ? { opencode: config.model } : { claudeCode: config.model },
        configOverrides: {
          defaultNodeRetries: 0,
          defaultPerNodeTimeoutMs: 8 * 60_000,
        },
      })

      const agentResponse = await apiFetch('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: `release-${protocol}`,
          description: `Real ${protocol} pre-release compatibility agent`,
          outputs: ['answer'],
          outputKinds: { answer: 'string' },
          readonly: false,
          runtime: protocol,
          bodyMd: [
            'You are a release verification agent.',
            'Use your native file-editing tools when the user asks you to create a proof file.',
            'Follow the workflow output envelope exactly and preserve proof tokens byte-for-byte.',
          ].join('\n'),
        }),
      })
      await expectHttp(agentResponse, 201, 'create live runtime agent')
      agentId = ((await agentResponse.json()) as { id: string }).id
    })

    test.afterAll(async () => {
      if (daemon !== undefined) await daemon.stop()
      if (root !== undefined) rmSync(root, { recursive: true, force: true })
    })

    test('native CLI streams a tool-using task through the production binary', async ({
      request: _request,
    }, testInfo) => {
      test.setTimeout(12 * 60_000)
      const token = `AW_RELEASE_${protocol.replace('-', '_')}_${crypto.randomUUID()}`
      await testInfo.attach('runtime-environment.json', {
        contentType: 'application/json',
        body: Buffer.from(
          JSON.stringify(
            {
              gitSha: gitHead(),
              productBinary: process.env.AW_RELEASE_BINARY ?? defaultProductionBinaryPath(),
              protocol,
              runtimeBinary: config.binary,
              runtimeVersion: cliVersion,
              model: config.model,
              startedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        ),
      })

      const workflowResponse = await apiFetch('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: `release-${protocol}-${crypto.randomUUID()}`,
          description: 'Real runtime startup, tool, stream and envelope verification',
          definition: {
            $schema_version: 4,
            inputs: [{ kind: 'text', key: 'proof_token', label: 'Proof token', required: true }],
            nodes: [
              {
                id: 'proof_input',
                kind: 'input',
                inputKey: 'proof_token',
                position: { x: 0, y: 0 },
              },
              {
                id: 'live_agent',
                kind: 'agent-single',
                agentId,
                promptTemplate: [
                  'Create a UTF-8 file named release-runtime-proof.txt in the current worktree.',
                  'Its entire content must be exactly this one line followed by a newline:',
                  'proof-token={{proof_token}}',
                  'After verifying the file, return the answer output port with exactly {{proof_token}}.',
                ].join('\n'),
                position: { x: 300, y: 0 },
              },
              {
                id: 'final_output',
                kind: 'output',
                ports: [{ name: 'answer', bind: { nodeId: 'live_agent', portName: 'answer' } }],
                position: { x: 700, y: 0 },
              },
            ],
            edges: [
              {
                id: 'proof_to_agent',
                source: { nodeId: 'proof_input', portName: 'proof_token' },
                target: { nodeId: 'live_agent', portName: 'proof_token' },
              },
              {
                id: 'agent_to_output',
                source: { nodeId: 'live_agent', portName: 'answer' },
                target: { nodeId: 'final_output', portName: 'answer' },
              },
            ],
          },
        }),
      })
      await expectHttp(workflowResponse, 201, 'create live workflow')
      const workflow = (await workflowResponse.json()) as WorkflowRow

      const launchResponse = await apiFetch('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: workflow.id,
          expectedWorkflowVersion: workflow.version,
          expectedWorkflowSnapshotHash: workflow.snapshotHash,
          name: `release-${protocol}-proof`,
          repoUrl: repoRemoteUrl(repoDir),
          ref: 'main',
          inputs: { proof_token: token },
        }),
      })
      await expectHttp(launchResponse, 201, 'launch live task')
      const task = (await launchResponse.json()) as TaskRow
      const terminal = await waitForTerminal(task.id)

      const runsResponse = await apiFetch(`/api/tasks/${task.id}/node-runs`)
      await expectHttp(runsResponse, 200, 'read live node runs')
      const data = (await runsResponse.json()) as NodeRunsResponse
      const run = data.runs.find((candidate) => candidate.nodeId === 'live_agent')
      const answer = data.outputs.find(
        (candidate) => candidate.nodeRunId === run?.id && candidate.port === 'answer',
      )?.value
      await testInfo.attach('runtime-result.json', {
        contentType: 'application/json',
        body: Buffer.from(
          JSON.stringify(
            {
              taskId: task.id,
              taskStatus: terminal.status,
              taskError: terminal.errorMessage ?? null,
              nodeStatus: run?.status ?? null,
              nodeError: run?.errorMessage ?? null,
              sessionCaptured: (run?.opencodeSessionId?.length ?? 0) > 0,
              tokenUsage: {
                input: run?.tokInput ?? 0,
                output: run?.tokOutput ?? 0,
                total: run?.tokTotal ?? 0,
              },
              outputMatched: answer === token,
              finishedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        ),
      })

      expect(terminal.status, terminal.errorMessage ?? undefined).toBe('done')
      expect(run?.status, run?.errorMessage ?? undefined).toBe('done')
      expect(run?.opencodeSessionId).toBeTruthy()
      expect(run?.tokTotal).toBeGreaterThan(0)
      expect(answer).toBe(token)

      const fileResponse = await apiFetch(
        `/api/tasks/${task.id}/worktree-file?path=${encodeURIComponent('release-runtime-proof.txt')}`,
      )
      await expectHttp(fileResponse, 200, 'read live proof file')
      expect(((await fileResponse.json()) as { content: string }).content).toBe(
        `proof-token=${token}\n`,
      )
    })
  })
}
