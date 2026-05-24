// RFC-061 PR-B T9-extra — runner-v2 invocation prep tests (pure functions).
//
// Locks the OPENCODE_CONFIG_DIR / OPENCODE_CONFIG_CONTENT contract +
// CLI argv shape for the future runner-v2 subprocess loop. No
// subprocess actually spawns here; these are pure tests.

import { describe, expect, test } from 'bun:test'

import {
  buildOpencodeCommand,
  prepareRunnerV2Invocation,
} from '../src/scheduler-v2/runnerV2Invocation'
import type { Agent, Scope } from '@agent-workflow/shared'

function fakeAgent(name = 'mAlice'): Agent {
  return {
    name,
    description: '',
    prompt: 'you are a designer',
    model: 'claude-sonnet-4-6',
    variant: undefined,
    temperature: undefined,
    permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' } as never,
    tools: undefined,
    mcp: undefined,
    body: '',
    readonly: false,
    role: undefined,
    dependsOn: undefined,
    skillIds: undefined,
    outputs: undefined,
  } as unknown as Agent
}

const baseScope: Scope = { nodeId: 'n1', loopIter: 0, shardKey: '', iter: 0 }

describe('buildOpencodeCommand', () => {
  test('minimal argv: opencode run <prompt> --agent <name> --format json --thinking', () => {
    const cmd = buildOpencodeCommand({
      opencodeCmd: ['opencode'],
      agentName: 'mAlice',
      prompt: 'do a thing',
      dangerouslySkipPermissions: false,
    })
    expect(cmd).toEqual([
      'opencode',
      'run',
      'do a thing',
      '--agent',
      'mAlice',
      '--format',
      'json',
      '--thinking',
    ])
  })

  test('--dangerously-skip-permissions appended when true', () => {
    const cmd = buildOpencodeCommand({
      opencodeCmd: ['opencode'],
      agentName: 'mAlice',
      prompt: 'go',
      dangerouslySkipPermissions: true,
    })
    expect(cmd).toContain('--dangerously-skip-permissions')
  })

  test('--session <id> appended when resumeSessionId is set', () => {
    const cmd = buildOpencodeCommand({
      opencodeCmd: ['opencode'],
      agentName: 'mAlice',
      prompt: 'go',
      dangerouslySkipPermissions: false,
      resumeSessionId: 'sess_abc',
    })
    const i = cmd.indexOf('--session')
    expect(i).toBeGreaterThan(-1)
    expect(cmd[i + 1]).toBe('sess_abc')
  })

  test('empty resumeSessionId is treated as undefined', () => {
    const cmd = buildOpencodeCommand({
      opencodeCmd: ['opencode'],
      agentName: 'mAlice',
      prompt: 'go',
      dangerouslySkipPermissions: false,
      resumeSessionId: '',
    })
    expect(cmd).not.toContain('--session')
  })

  test('opencodeCmd override (multi-arg head)', () => {
    const cmd = buildOpencodeCommand({
      opencodeCmd: ['/usr/local/bin/opencode-wrapper', '--telemetry'],
      agentName: 'mAlice',
      prompt: 'go',
      dangerouslySkipPermissions: false,
    })
    expect(cmd.slice(0, 2)).toEqual(['/usr/local/bin/opencode-wrapper', '--telemetry'])
    expect(cmd[2]).toBe('run')
  })
})

describe('prepareRunnerV2Invocation', () => {
  test('configDir + runRoot are per-attempt under appHome/runs/<task>/<attempt>', () => {
    const inv = prepareRunnerV2Invocation({
      appHome: '/h',
      taskId: 't1',
      attemptId: 'att_x',
      scope: baseScope,
      worktreePath: '/wt',
      agent: fakeAgent(),
      prompt: 'go',
    })
    expect(inv.runRoot).toBe('/h/runs/t1/att_x')
    expect(inv.configDir).toBe('/h/runs/t1/att_x/.opencode')
  })

  test('env carries OPENCODE_CONFIG_DIR + OPENCODE_CONFIG_CONTENT', () => {
    const inv = prepareRunnerV2Invocation({
      appHome: '/h',
      taskId: 't1',
      attemptId: 'att_x',
      scope: baseScope,
      worktreePath: '/wt',
      agent: fakeAgent(),
      prompt: 'go',
    })
    expect(inv.env.OPENCODE_CONFIG_DIR).toBe(inv.configDir)
    expect(typeof inv.env.OPENCODE_CONFIG_CONTENT).toBe('string')
    const parsed = JSON.parse(inv.env.OPENCODE_CONFIG_CONTENT!)
    expect(parsed.agent).toBeDefined()
    expect(parsed.agent.mAlice).toBeDefined()
  })

  test('cwd is the task worktree path (RFC-001 isolation contract)', () => {
    const inv = prepareRunnerV2Invocation({
      appHome: '/h',
      taskId: 't1',
      attemptId: 'att_x',
      scope: baseScope,
      worktreePath: '/var/repos/x/worktrees/y',
      agent: fakeAgent(),
      prompt: 'go',
    })
    expect(inv.cwd).toBe('/var/repos/x/worktrees/y')
  })

  test('command argv mirrors buildOpencodeCommand output', () => {
    const inv = prepareRunnerV2Invocation({
      appHome: '/h',
      taskId: 't1',
      attemptId: 'att_x',
      scope: baseScope,
      worktreePath: '/wt',
      agent: fakeAgent('mBob'),
      prompt: 'design',
      dangerouslySkipPermissions: false,
    })
    expect(inv.command).toEqual([
      'opencode',
      'run',
      'design',
      '--agent',
      'mBob',
      '--format',
      'json',
      '--thinking',
    ])
  })

  test('inlineConfig.agent map keyed by agent.name', () => {
    const inv = prepareRunnerV2Invocation({
      appHome: '/h',
      taskId: 't1',
      attemptId: 'att_x',
      scope: baseScope,
      worktreePath: '/wt',
      agent: fakeAgent('mCarol'),
      prompt: 'go',
    })
    expect(Object.keys(inv.inlineConfig.agent)).toEqual(['mCarol'])
  })

  test('dependents added to inlineConfig.agent (RFC-022)', () => {
    const inv = prepareRunnerV2Invocation({
      appHome: '/h',
      taskId: 't1',
      attemptId: 'att_x',
      scope: baseScope,
      worktreePath: '/wt',
      agent: fakeAgent('mAlice'),
      dependents: [fakeAgent('mAuditor')],
      prompt: 'go',
    })
    expect(Object.keys(inv.inlineConfig.agent).sort()).toEqual(['mAlice', 'mAuditor'])
  })

  test('no mcps + no plugins → keys absent (compact wire format)', () => {
    const inv = prepareRunnerV2Invocation({
      appHome: '/h',
      taskId: 't1',
      attemptId: 'att_x',
      scope: baseScope,
      worktreePath: '/wt',
      agent: fakeAgent(),
      prompt: 'go',
    })
    expect(inv.inlineConfig.mcp).toBeUndefined()
    expect(inv.inlineConfig.plugin).toBeUndefined()
  })
})
