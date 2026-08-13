// 2026-08-09 —— claude 运行时「dependsOn 传递依赖注入」回归锁。
//
// 与同日的 skill 修复同一根因族：闭包收集是对的（RFC-271 T6f 四处归位），注入也
// 发出去了，但**运行时用不了**，且全链零告警。三条各自独立：
//
// ① `--agents` 无条件下发，而 `Task` 工具只在 agent 自己写了 `task:'allow'` 时才
//    进 `--tools`（`permissionMap.ts`）。于是「声明了 dependsOn 的受控节点」把子代理
//    注册进去了却一个都调不动。**两个运行时语义相反**：opencode 侧由闭包非空**自动**
//    开 `task` 并限定到成员名（`hermetic.ts:864-868`），从不问用户 permission。同一份
//    agent 定义换个 runtime 就失去委派能力。
//
//    真机（claude 2.1.226）：`--tools Read,Skill` 与 `--tools Read,Skill,Task` 两种形态
//    下 `init.agents` 都列出注入的 dep，但前者 `init.tools` 无 `Task`。
//
//    修它是否会开提权面？**实测证否**：内置 `general-purpose` 的定义带 `tools:["*"]`，
//    但在 `--tools Read,Task` 的父进程里委派过去，它自报 `TOOLS=Agent, Read` —— 父的
//    `--tools` 是**硬上界**，内置 agent 的 `*` 只在父的装载集内展开。所以给 `Task`
//    不会让模型借内置 agent 拿到父没有的能力。
//
// ② 平台**已经**为每个 dependent 解析了 RFC-113 profile（`resolvedParamsByAgent` 的
//    契约原文：「root INCLUDED — frozen params for the root, live-resolved for each
//    dependent」），opencode 侧逐成员用上了 model/variant/temperature/steps，claude 侧
//    `toClaudeAgents` 只产 `{description,prompt}` ⇒ 每个 dep 的 model 配置被丢弃。
//    而 claude 的 agent schema 是支持的（二进制取到的完整定义含
//    `model` / `tools` / `disallowedTools` / `permissionMode` / `skills` / …）。
//
// ③ 同一处丢掉的还有 dep 自己的 `permission`。实测（同上）：subagent 的可用工具就是
//    父的装载集，dep 的声明完全不参与 ⇒ dep 声明只读、父能写时 dep **过宽**。
//    修法取**只收窄不扩张**的一侧：dep 的 tools = `dep 映射 ∩ 父装载集`，并且永不含
//    `Task`（v1 无嵌套委派，与 opencode 的 `buildPermission(dep,false)` 对齐）。
//    dep 声明了父没有的工具时**显式告警**——那是 claude 的结构限制（父是硬上界），
//    不能静默吞掉。父 unconstrained（bypassPermissions）时整组不发，历史形状不变。

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG_DIR_PROFILE, type Agent } from '@agent-workflow/shared'
import { toClaudeAgents } from '../src/services/runtime/claudeCode/inject'
import { claudeExplicitPermissionArgv } from '../src/services/runtime/claudeCode/spawn'
import type { BusinessNodeSpawnContext } from '../src/services/runtime/types'
import type { RuntimeProfile } from '../src/services/runtimeRegistry'
import { createLogger } from '../src/util/log'
import { assembleClaudeBusinessSpawn } from '../src/services/runtime/claudeCode/driver'

const tempDirs: string[] = []
const log = createLogger('claude-dependency-injection-test')

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(prefix: string): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(value)
  return value
}

function mkAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: `agent-${overrides.name ?? 'root'}`,
    name: 'claude-agent',
    description: 'desc',
    outputs: ['result'],
    syncOutputsOnIterate: true,
    permission: { read: 'allow' },
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '## persona',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function profile(model: string | null): RuntimeProfile {
  return { model, variant: null, temperature: null, steps: null, maxSteps: null, isSandbox: false }
}

interface Fixture {
  base: string
  appHome: string
  worktreePath: string
  runRoot: string
  claudeBinary: string
}

function fixture(prefix: string): Fixture {
  const base = root(prefix)
  const appHome = join(base, 'app-home')
  const worktreePath = join(base, 'worktree')
  const runRoot = join(appHome, 'runs', 'task-1', 'nr-1')
  for (const dir of [appHome, worktreePath, runRoot]) mkdirSync(dir, { recursive: true })
  const binDir = join(base, 'bin')
  mkdirSync(binDir, { recursive: true })
  const claudeBinary = join(binDir, 'claude')
  writeFileSync(claudeBinary, '#!/bin/sh\nexit 0\n')
  Bun.spawnSync(['chmod', '755', claudeBinary])
  return { base, appHome, worktreePath, runRoot, claudeBinary }
}

function mkCtx(
  f: Fixture,
  overrides: Partial<BusinessNodeSpawnContext> = {},
): BusinessNodeSpawnContext {
  return {
    agent: mkAgent(),
    prompt: 'PROMPT',
    injectedMemoryBlock: null,
    dependents: [],
    mcps: [],
    plugins: [],
    resolvedParamsByAgent: new Map<string, RuntimeProfile>(),
    skills: [],
    worktreePath: f.worktreePath,
    taskMounts: [f.worktreePath],
    runRoot: f.runRoot,
    configDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
    runtimeBinary: f.claudeBinary,
    freshAgentRun: false,
    nodeRunId: 'nr-1',
    log,
    ...overrides,
  }
}

function toolsOf(argv: readonly string[]): string[] {
  const i = argv.indexOf('--tools')
  return i === -1 ? [] : (argv[i + 1] ?? '').split(',').filter((t) => t.length > 0)
}

// ---------------------------------------------------------------------------
// ① Task 由闭包推导，不问用户 permission
// ---------------------------------------------------------------------------

describe('闭包非空 ⇒ 平台自己开 Task（与 opencode 语义对齐）', () => {
  test('subagentsGranted ⇒ Task 进装载集', () => {
    const argv = claudeExplicitPermissionArgv({ tools: 'Read', subagentsGranted: true })
    expect(toolsOf(argv)).toContain('Task')
    expect(toolsOf(argv)).toContain('Read')
  })

  test('未声明 ⇒ 不加（历史形状字节不变）', () => {
    const argv = claudeExplicitPermissionArgv({ tools: 'Read' })
    expect(toolsOf(argv)).not.toContain('Task')
  })

  test('用户自己写了 task:allow ⇒ 不重复出现', () => {
    const argv = claudeExplicitPermissionArgv({ tools: 'Read,Task', subagentsGranted: true })
    expect(toolsOf(argv).filter((t) => t === 'Task')).toHaveLength(1)
  })

  test('装载集为空（all-deny 系统面）也不会因为本改动被撑开', () => {
    const argv = claudeExplicitPermissionArgv({ tools: '' })
    expect(toolsOf(argv)).toEqual([])
  })

  test.skipIf(process.platform === 'win32')(
    '受控业务节点 + 非空 dependsOn ⇒ argv 同时有 Task 和 --agents',
    async () => {
      const f = fixture('claude-deps-task-')
      const plan = await assembleClaudeBusinessSpawn(
        mkCtx(f, { dependents: [mkAgent({ name: 'auditor', id: 'agent-auditor' })] }),
      )
      // 修复前：--agents 有、Task 无 —— 子代理注册了却调不动。
      expect(toolsOf(plan.cmd)).toContain('Task')
      expect(plan.cmd).toContain('--agents')
    },
  )

  test.skipIf(process.platform === 'win32')('空闭包 ⇒ 既无 Task 也无 --agents', async () => {
    const f = fixture('claude-deps-empty-')
    const plan = await assembleClaudeBusinessSpawn(mkCtx(f))
    expect(toolsOf(plan.cmd)).not.toContain('Task')
    expect(plan.cmd).not.toContain('--agents')
  })
})

// ---------------------------------------------------------------------------
// ② 每个 dependent 的 model 必须跟着它自己走
// ---------------------------------------------------------------------------

describe('传递依赖带自己的 model（平台早就解析好了）', () => {
  test('逐成员取自己的 profile，root 的不会泄漏过去', () => {
    const deps = [mkAgent({ name: 'auditor', id: 'a1' }), mkAgent({ name: 'fixer', id: 'a2' })]
    const out = toClaudeAgents(deps, {
      profileByName: new Map([
        ['claude-agent', profile('root/model')],
        ['auditor', profile('anthropic/audit')],
        ['fixer', profile('anthropic/fix')],
      ]),
    })
    expect(out?.agents.auditor?.model).toBe('anthropic/audit')
    expect(out?.agents.fixer?.model).toBe('anthropic/fix')
  })

  test('没有 profile / model 为 null ⇒ 不发该字段（绝不编造）', () => {
    const out = toClaudeAgents([mkAgent({ name: 'auditor', id: 'a1' })], {
      profileByName: new Map([['auditor', profile(null)]]),
    })
    expect(out?.agents.auditor && 'model' in out.agents.auditor).toBe(false)
    const bare = toClaudeAgents([mkAgent({ name: 'auditor', id: 'a1' })])
    expect(bare?.agents.auditor && 'model' in bare.agents.auditor).toBe(false)
  })

  test('description / prompt 仍逐字来自该 dependent', () => {
    const dep = mkAgent({ name: 'auditor', id: 'a1', description: 'audits', bodyMd: 'BODY' })
    const out = toClaudeAgents([dep])
    expect(out?.agents.auditor).toMatchObject({ description: 'audits', prompt: 'BODY' })
  })

  test('空闭包 ⇒ null（调用方据此省掉 --agents）', () => {
    expect(toClaudeAgents([])).toBeNull()
  })

  test.skipIf(process.platform === 'win32')(
    'driver 把 dep 的 model 真的写进 --agents',
    async () => {
      const f = fixture('claude-deps-model-')
      const plan = await assembleClaudeBusinessSpawn(
        mkCtx(f, {
          dependents: [mkAgent({ name: 'auditor', id: 'a1' })],
          resolvedParamsByAgent: new Map([
            ['claude-agent', profile('root/model')],
            ['auditor', profile('anthropic/audit')],
          ]),
        }),
      )
      const agentsJson = JSON.parse(plan.cmd[plan.cmd.indexOf('--agents') + 1] ?? '{}')
      expect(agentsJson.auditor.model).toBe('anthropic/audit')
      // root 的 model 走 --model，两者不得串台
      expect(plan.cmd[plan.cmd.indexOf('--model') + 1]).toBe('root/model')
    },
  )
})

// ---------------------------------------------------------------------------
// ③ 每个 dependent 的 permission → 自己的 tools（只收窄，不扩张）
// ---------------------------------------------------------------------------

describe('传递依赖的能力面：dep 映射 ∩ 父装载集，且永不含 Task', () => {
  test('dep 声明只读、父能写 ⇒ dep 被收窄（此前 dep 直接继承父的写能力）', () => {
    const dep = mkAgent({ name: 'auditor', id: 'a1', permission: { read: 'allow' } })
    const out = toClaudeAgents([dep], { parentTools: ['Read', 'Edit', 'Write', 'Task'] })
    expect(out?.agents.auditor?.tools).toEqual(['Read'])
  })

  test('dep 要的工具父没有 ⇒ 收窄到交集 + 显式告警（claude 的父集合是硬上界）', () => {
    const dep = mkAgent({ name: 'auditor', id: 'a1', permission: { read: 'allow', bash: 'allow' } })
    const out = toClaudeAgents([dep], { parentTools: ['Read', 'Task'] })
    expect(out?.agents.auditor?.tools).toEqual(['Read'])
    expect(out?.warnings.some((w) => w.includes('auditor') && w.includes('Bash'))).toBe(true)
  })

  test('dep 永远拿不到 Task —— v1 不做嵌套委派（对齐 opencode 的 buildPermission(dep,false)）', () => {
    const dep = mkAgent({ name: 'auditor', id: 'a1', permission: { read: 'allow', task: 'allow' } })
    const out = toClaudeAgents([dep], { parentTools: ['Read', 'Task'] })
    expect(out?.agents.auditor?.tools).not.toContain('Task')
  })

  test('dep 未声明 permission ⇒ 继承父集合但仍剔掉 Task', () => {
    const dep = mkAgent({ name: 'auditor', id: 'a1', permission: {} })
    const out = toClaudeAgents([dep], { parentTools: ['Read', 'Edit', 'Task'] })
    expect(out?.agents.auditor?.tools).toEqual(['Read', 'Edit'])
  })

  test('父 unconstrained ⇒ 整组不发 tools（bypassPermissions 没有装载集，历史形状不变）', () => {
    const dep = mkAgent({ name: 'auditor', id: 'a1', permission: { read: 'allow' } })
    const out = toClaudeAgents([dep], { parentTools: null })
    expect(out?.agents.auditor && 'tools' in out.agents.auditor).toBe(false)
  })

  test.skipIf(process.platform === 'win32')(
    'driver：受控父 + 只读 dep ⇒ --agents 里 dep 的 tools 被收窄',
    async () => {
      const f = fixture('claude-deps-tools-')
      const plan = await assembleClaudeBusinessSpawn(
        mkCtx(f, {
          agent: mkAgent({ permission: { read: 'allow', edit: 'allow' } }),
          dependents: [mkAgent({ name: 'auditor', id: 'a1', permission: { read: 'allow' } })],
        }),
      )
      const agentsJson = JSON.parse(plan.cmd[plan.cmd.indexOf('--agents') + 1] ?? '{}')
      expect(agentsJson.auditor.tools).toEqual(['Read'])
      expect(agentsJson.auditor.tools).not.toContain('Write')
    },
  )

  test.skipIf(process.platform === 'win32')(
    'driver：unconstrained 父 ⇒ --agents 保持历史形状（只有 description/prompt）',
    async () => {
      const f = fixture('claude-deps-unconstrained-')
      const plan = await assembleClaudeBusinessSpawn(
        mkCtx(f, {
          agent: mkAgent({ permission: {} }),
          dependents: [mkAgent({ name: 'auditor', id: 'a1', permission: { read: 'allow' } })],
        }),
      )
      const agentsJson = JSON.parse(plan.cmd[plan.cmd.indexOf('--agents') + 1] ?? '{}')
      expect(Object.keys(agentsJson.auditor).sort()).toEqual(['description', 'prompt'])
      expect(plan.cmd).toContain('bypassPermissions')
    },
  )
})
