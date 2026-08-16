// Runtime-neutral E2E model stand-in contract.
//
// This test deliberately derives both invocations from the production spawn
// builders. A historical task scenario can therefore be replayed without a
// provider while still exercising the exact OpenCode argv and Claude Code
// stdin/stream-json seams that production uses.

import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildClaudeSpawn } from '../src/services/runtime/claudeCode/spawn'
import { buildCommand } from '../src/services/runtime/opencode/spawn'

type Protocol = 'opencode' | 'claude-code'

interface InvocationResult {
  status: number | null
  stdout: string
  stderr: string
}

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const STUB = resolve(REPO_ROOT, 'packages', 'system-mocks', 'src', 'runtime', 'dispatch.ts')
const scratch: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-runtime-scenario-'))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function invoke(
  protocol: Protocol,
  options: {
    prompt: string
    agent: string
    planFile: string
    stateDir: string
    worktree: string
    resumeSessionId?: string
  },
): InvocationResult {
  const scenarioEnv = {
    AW_STUB_MODE: 'runtime-scenario',
    SCENARIO_PLAN_FILE: options.planFile,
    SCENARIO_STATE_DIR: options.stateDir,
  }

  if (protocol === 'opencode') {
    const cmd = buildCommand(
      {
        opencodeCmd: [process.execPath, 'run', STUB],
        agent: { name: options.agent },
        resumeSessionId: options.resumeSessionId,
      },
      options.prompt,
    )
    const result = spawnSync(cmd[0]!, cmd.slice(1), {
      cwd: options.worktree,
      env: { ...process.env, ...scenarioEnv },
      encoding: 'utf8',
    })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  const attemptDir = join(options.stateDir, `attempt-${crypto.randomUUID()}`)
  const spawnPlan = buildClaudeSpawn({
    claudeCmd: [process.execPath, 'run', STUB],
    prompt: options.prompt,
    systemPromptText: `[AW_SCENARIO_AGENT:${options.agent}]`,
    resumeSessionId: options.resumeSessionId,
    attemptDir,
    worktreePath: options.worktree,
  })
  const result = spawnSync(spawnPlan.cmd[0]!, spawnPlan.cmd.slice(1), {
    cwd: options.worktree,
    env: { ...spawnPlan.env, ...scenarioEnv },
    input: spawnPlan.stdin?.mode === 'pipe' ? spawnPlan.stdin.data : undefined,
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function writePlan(root: string, agents: Record<string, unknown[]>): string {
  const file = join(root, 'plan.json')
  writeFileSync(file, JSON.stringify({ version: 1, agents }))
  return file
}

function prompt(task: string, node: string, nonce: string): string {
  return [
    `AW_SCENARIO_TASK=${task}`,
    `AW_SCENARIO_NODE=${node}`,
    'preserve this exact input',
    `<workflow-output nonce="${nonce}">`,
  ].join('\n')
}

describe('runtime-scenario deterministic stand-in', () => {
  for (const protocol of ['opencode', 'claude-code'] as const) {
    test(`${protocol}: production spawn contract carries output, session, tokens and worktree effects`, () => {
      const root = tempDir()
      const stateDir = join(root, 'state')
      const worktree = join(root, 'worktree')
      mkdirSync(worktree)
      const planFile = writePlan(root, {
        worker: [
          {
            requirePrompt: ['preserve this exact input'],
            output: { answer: '{{protocol}}/{{task}}/{{node}}/{{callIndex}}' },
            writeFiles: { 'proof/result.txt': '{{protocol}} proof' },
            sessionId: 'session-{{protocol}}-0',
            tokens: { input: 17, output: 5, cacheRead: 4, cacheCreate: 3 },
          },
        ],
      })
      const result = invoke(protocol, {
        prompt: prompt(`${protocol}-task`, 'worker-node', 'nonce-happy'),
        agent: 'worker',
        planFile,
        stateDir,
        worktree,
      })

      expect(`${result.stderr}\n${result.stdout}`).not.toContain('stub-runtime-scenario:')
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('nonce-happy')
      expect(result.stdout).toContain(`${protocol}/${protocol}-task/worker-node/0`)
      expect(result.stdout).toContain(`session-${protocol}-0`)
      expect(result.stdout).toContain(protocol === 'opencode' ? '"input":17' : '"input_tokens":17')
      expect(readFileSync(join(worktree, 'proof', 'result.txt'), 'utf8')).toBe(`${protocol} proof`)

      const trace = JSON.parse(readFileSync(join(stateDir, 'trace.jsonl'), 'utf8')) as {
        protocol: Protocol
        callIndex: number
        resumeSessionId: string | null
      }
      expect(trace).toMatchObject({ protocol, callIndex: 0, resumeSessionId: null })
    })

    test(`${protocol}: one plan covers clarify, malformed text, clean runtime error and crash`, () => {
      const root = tempDir()
      const stateDir = join(root, 'state')
      const worktree = join(root, 'worktree')
      mkdirSync(worktree)
      const planFile = writePlan(root, {
        failure: [
          {
            clarify: { question: 'Need approval?', choices: ['yes', 'no'] },
            sessionId: 'resume-me',
          },
          { rawText: 'assistant omitted the output envelope' },
          { terminalError: 'provider rejected request' },
          { exitCode: 23, stderr: 'simulated process crash' },
        ],
      })
      const base = {
        agent: 'failure',
        planFile,
        stateDir,
        worktree,
      }

      const clarify = invoke(protocol, {
        ...base,
        prompt: prompt(`${protocol}-failure`, 'same-node', 'nonce-failure'),
      })
      expect(clarify.status).toBe(0)
      expect(clarify.stdout).toContain('<workflow-clarify')
      expect(clarify.stdout).toContain('Need approval?')

      const malformed = invoke(protocol, {
        ...base,
        prompt: prompt(`${protocol}-failure`, 'same-node', 'nonce-failure'),
        resumeSessionId: 'resume-me',
      })
      expect(malformed.status).toBe(0)
      expect(malformed.stdout).toContain('assistant omitted the output envelope')
      expect(malformed.stdout).not.toContain('<workflow-output nonce=')

      const terminalError = invoke(protocol, {
        ...base,
        prompt: prompt(`${protocol}-failure`, 'same-node', 'nonce-failure'),
      })
      expect(terminalError.status).toBe(0)
      expect(terminalError.stdout).toContain('provider rejected request')
      expect(terminalError.stdout).toContain(
        protocol === 'opencode' ? '"type":"error"' : '"subtype":"error"',
      )

      const crash = invoke(protocol, {
        ...base,
        prompt: prompt(`${protocol}-failure`, 'same-node', 'nonce-failure'),
      })
      expect(crash.status).toBe(23)
      expect(crash.stderr).toContain('simulated process crash')

      const traces = readFileSync(join(stateDir, 'trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { callIndex: number; resumeSessionId: string | null })
      expect(traces.map((trace) => trace.callIndex)).toEqual([0, 1, 2, 3])
      expect(traces[1]?.resumeSessionId).toBe('resume-me')
    })

    test(`${protocol}: silent exit records stderr diagnostics without native stdout`, () => {
      const root = tempDir()
      const stateDir = join(root, 'state')
      const worktree = join(root, 'worktree')
      mkdirSync(worktree)
      const planFile = writePlan(root, {
        silent: [
          {
            silentExit: true,
            stderr: 'diagnostic-only/{{protocol}}/{{callIndex}}',
          },
        ],
      })
      const result = invoke(protocol, {
        prompt: prompt(`${protocol}-silent`, 'silent-node', 'nonce-silent'),
        agent: 'silent',
        planFile,
        stateDir,
        worktree,
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`diagnostic-only/${protocol}/0\n`)
      const trace = JSON.parse(readFileSync(join(stateDir, 'trace.jsonl'), 'utf8')) as {
        protocol: Protocol
        task: string
        callIndex: number
        resumeSessionId: string | null
      }
      expect(trace).toMatchObject({
        protocol,
        task: `${protocol}-silent`,
        callIndex: 0,
        resumeSessionId: null,
      })
    })
  }
})
