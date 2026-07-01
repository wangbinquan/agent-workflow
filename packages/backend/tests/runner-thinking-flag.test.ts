// Locks in: `buildCommand` always appends `--thinking` so opencode emits
// `reasoning` events to stdout in `--format json` mode. Without this
// flag opencode's run.ts:671 filters reasoning parts out, so the
// NodeDetailDrawer Session tab never gets thinking content to display.
//
// Regression context: feature request "运行界面的工作流状态-节点信息-会话
// 里，要能把 thinking 内容也打印出来". If a future refactor drops the
// flag this test goes red before users notice the empty thinking blocks.

import { describe, expect, test } from 'bun:test'
import type { Agent } from '@agent-workflow/shared'
import { buildCommand, type RunNodeOptions } from '../src/services/runner'

const AGENT: Agent = {
  id: 'a',
  name: 'tester',
  description: '',
  outputs: ['design'],
  syncOutputsOnIterate: false,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: 'body',
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
}

function baseOpts(overrides: Partial<RunNodeOptions> = {}): RunNodeOptions {
  return {
    taskId: 't',
    nodeRunId: 'nr',
    nodeId: 'n',
    agent: AGENT,
    inputs: {},
    worktreePath: '/tmp/wt',
    templateMeta: { repoPath: '/tmp/wt', baseBranch: 'main', taskId: 't' },
    promptTemplate: 'go',
    skills: [],
    appHome: '/tmp/home',
    db: {} as unknown as RunNodeOptions['db'],
    ...overrides,
  }
}

describe('runner buildCommand — thinking flag', () => {
  test('always emits `--thinking` so reasoning events reach stdout', () => {
    const cmd = buildCommand(baseOpts(), 'PROMPT')
    expect(cmd).toContain('--thinking')
  })

  test('`--thinking` coexists with `--format json` and `--session <id>`', () => {
    const cmd = buildCommand(baseOpts({ resumeSessionId: 'opc_abc' }), 'PROMPT')
    expect(cmd).toContain('--thinking')
    expect(cmd).toContain('--format')
    expect(cmd[cmd.indexOf('--format') + 1]).toBe('json')
    expect(cmd).toContain('--session')
    expect(cmd[cmd.indexOf('--session') + 1]).toBe('opc_abc')
  })
})
