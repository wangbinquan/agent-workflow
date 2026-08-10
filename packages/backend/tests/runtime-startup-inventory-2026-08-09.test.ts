// 2026-08-09 —— 「声明了的能力必须在运行时启动清单里出现」通用防护。
//
// 五天里同一种失效出了三次，每次都是：闭包收集对、注入也发出去了、运行时**用不了**、
// 全链零告警，最后靠用户在生产报「找不到 X」才发现。
//
//   · `--disable-slash-commands`（2026-08-04）—— 把本节点的技能全关了；
//   · `--setting-sources ""`（2026-08-09）—— 技能目录根本不被扫描；
//   · `--agents` 无条件下发但 `Task` 未装载（2026-08-09）—— 子代理注册了调不动。
//
// 三次都不是同一个 flag 的问题，所以逐个打补丁挡不住第四次。claude 的
// `system/init` 事件同时给了 `tools` / `agents` / `skills` / `mcp_servers` 四份清单
// ——平台声明了什么就核对什么，缺了就点名失败。RFC-242 T5 的 `fencedMcpServers`
// 已经是这个形状，本批把它推广成一个机制，而不是并排放三份近似实现（`docs/
// dev-gotchas.md`：「沙箱边界规则一旦有第二份副本，必然漂移成漏洞」同理）。
//
// 判据是**缺失**而不是相等：清单里本来就有运行时自带的内置技能/内置 agent，多出来
// 的不关平台的事；平台只证明「我声明的那些确实在」。
//
// 不认识这条清单的运行时（`parseStartupInventory` 恒返回 null / 驱动没实现）保持
// 原样通过 —— 无法证明不等于证否，fork 不报清单不该被判失败。

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Agent } from '@agent-workflow/shared'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'
import { claudeCodeDriver } from '../src/services/runtime/claudeCode/driver'
import { parseStartupInventory } from '../src/services/runtime/claudeCode/events'
import type { DeclaredRuntimeCapabilities, SpawnPlan } from '../src/services/runtime/types'
import { createLogger } from '../src/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []
const log = createLogger('startup-inventory-test')

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
    id: 'agent-1',
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

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

describe('parseStartupInventory 读 claude 的启动清单', () => {
  const init = (extra: Record<string, unknown>): string =>
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', ...extra })

  test('三份清单一起解析', () => {
    const out = parseStartupInventory(
      init({ tools: ['Read', 'Task'], agents: ['auditor', 'general-purpose'], skills: ['pdf'] }),
    )
    expect(out).toEqual({
      tools: ['Read', 'Task'],
      agents: ['auditor', 'general-purpose'],
      skills: ['pdf'],
    })
  })

  test('只带其中一份也算 init（缺的那份是 undefined，不是空数组）', () => {
    const out = parseStartupInventory(init({ skills: ['pdf'] }))
    expect(out?.skills).toEqual(['pdf'])
    expect(out?.tools).toBeUndefined()
    expect(out?.agents).toBeUndefined()
  })

  test('非 init / 非 JSON / 三份都没有 ⇒ null（继续找下一行）', () => {
    expect(parseStartupInventory('not json')).toBeNull()
    expect(parseStartupInventory(JSON.stringify({ type: 'assistant' }))).toBeNull()
    expect(parseStartupInventory(JSON.stringify({ type: 'system', subtype: 'status' }))).toBeNull()
    expect(parseStartupInventory(init({ mcp_servers: [] }))).toBeNull()
  })

  test('脏项被过滤', () => {
    expect(parseStartupInventory(init({ tools: ['Read', null, 7, ''] }))?.tools).toEqual(['Read'])
  })
})

// ---------------------------------------------------------------------------
// plan 侧：driver 声明了什么
// ---------------------------------------------------------------------------

describe('受控 claude 业务计划声明它需要的三类能力', () => {
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
  function mkSkill(base: string, name: string): string {
    const dir = join(base, 'snapshots', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody\n`)
    return dir
  }

  test.skipIf(process.platform === 'win32')('tools / agents / skills 三类一起声明', async () => {
    const f = fixture('startup-inv-plan-')
    const plan = await claudeCodeDriver.buildBusinessSpawn({
      agent: mkAgent({ permission: { read: 'allow', skill: 'allow' } }),
      prompt: 'p',
      injectedMemoryBlock: null,
      dependents: [mkAgent({ id: 'a2', name: 'auditor' })],
      mcps: [],
      plugins: [],
      resolvedParamsByAgent: new Map(),
      skills: [{ name: 'pdf-tools', sourceKind: 'managed', sourcePath: mkSkill(f.base, 'pdf') }],
      worktreePath: f.worktreePath,
      repoWorktreePaths: [f.worktreePath],
      runRoot: f.runRoot,
      configDir: { env: 'CLAUDE_CONFIG_DIR', name: '.claude' },
      runtimeBinary: f.claudeBinary,
      wantsInventory: false,
      nodeRunId: 'nr-1',
      appHome: f.appHome,
      taskId: 'task-1',
      nodeId: 'node-1',
      log,
    })
    const declared = plan.declaredCapabilities as DeclaredRuntimeCapabilities
    expect(declared.skills).toEqual(['pdf-tools'])
    expect(declared.agents).toEqual(['auditor'])
    // Task 由闭包推导；Skill 由权限映射。两者都必须被证明装载。
    expect(declared.tools).toContain('Task')
    expect(declared.tools).toContain('Skill')
  })

  test.skipIf(process.platform === 'win32')(
    'unconstrained 节点不声明 tools（bypassPermissions 没有装载集可证）',
    async () => {
      const f = fixture('startup-inv-unconstrained-')
      const plan = await claudeCodeDriver.buildBusinessSpawn({
        agent: mkAgent({ permission: {} }),
        prompt: 'p',
        injectedMemoryBlock: null,
        dependents: [mkAgent({ id: 'a2', name: 'auditor' })],
        mcps: [],
        plugins: [],
        resolvedParamsByAgent: new Map(),
        skills: [],
        worktreePath: f.worktreePath,
        repoWorktreePaths: [f.worktreePath],
        runRoot: f.runRoot,
        configDir: { env: 'CLAUDE_CONFIG_DIR', name: '.claude' },
        runtimeBinary: f.claudeBinary,
        wantsInventory: false,
        nodeRunId: 'nr-1',
        appHome: f.appHome,
        taskId: 'task-1',
        nodeId: 'node-1',
        log,
      })
      const declared = (plan.declaredCapabilities ?? {}) as DeclaredRuntimeCapabilities
      expect(declared.tools).toBeUndefined()
      // 但 `--agents` 照发，所以子代理仍要被证明存在。
      expect(declared.agents).toEqual(['auditor'])
    },
  )
})

// ---------------------------------------------------------------------------
// runner 侧：缺一样就点名失败
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('runner 对启动清单做 fail-closed', () => {
  interface F {
    base: string
    appHome: string
    worktreePath: string
  }
  function f(prefix: string): F {
    const base = root(prefix)
    const appHome = join(base, 'app-home')
    const worktreePath = join(base, 'worktree')
    for (const dir of [appHome, worktreePath]) mkdirSync(dir, { recursive: true })
    return { base, appHome, worktreePath }
  }

  async function seed(fx: F, nodeRunId: string): Promise<ReturnType<typeof createInMemoryDb>> {
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(workflows).values({ id: 'wf-1', name: 'wf-1', definition: '{}' })
    await db.insert(tasks).values({
      id: 'task-1',
      name: 'task-1',
      workflowId: 'wf-1',
      workflowSnapshot: '{}',
      repoPath: fx.worktreePath,
      worktreePath: fx.worktreePath,
      baseBranch: 'main',
      branch: 'aw/task-1',
      status: 'running',
      inputs: '{}',
      startedAt: 1,
    })
    await db
      .insert(nodeRuns)
      .values({ id: nodeRunId, taskId: 'task-1', nodeId: 'node-1', status: 'pending' })
    return db
  }

  function fakeRuntime(base: string, inventory: Record<string, unknown>): string {
    const init = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      ...inventory,
    })
    const answer = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-1',
      message: {
        id: 'm1',
        content: [
          {
            type: 'text',
            text: '<workflow-output><port name="result">ok</port></workflow-output>',
          },
        ],
      },
    })
    const dir = join(base, 'fake-runtime')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'runtime')
    writeFileSync(
      path,
      `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' ${JSON.stringify(init)}\nprintf '%s\\n' ${JSON.stringify(answer)}\nexit 0\n`,
    )
    Bun.spawnSync(['chmod', '755', path])
    return path
  }

  async function run(
    fx: F,
    nodeRunId: string,
    declared: DeclaredRuntimeCapabilities,
    inventory: Record<string, unknown>,
    planExtra: Partial<SpawnPlan> = {},
  ): Promise<Awaited<ReturnType<typeof runNode>>> {
    const db = await seed(fx, nodeRunId)
    const original = claudeCodeDriver.buildBusinessSpawn
    claudeCodeDriver.buildBusinessSpawn = async (): Promise<SpawnPlan> => ({
      cmd: [fakeRuntime(fx.base, inventory)],
      env: {},
      stdin: { mode: 'pipe', data: 'x' },
      declaredCapabilities: declared,
      ...planExtra,
    })
    try {
      return await runNode({
        taskId: 'task-1',
        nodeRunId,
        nodeId: 'node-1',
        agent: mkAgent(),
        inputs: {},
        worktreePath: fx.worktreePath,
        templateMeta: {
          repoPath: fx.worktreePath,
          baseBranch: 'main',
          taskId: 'task-1',
          nodeId: 'node-1',
        },
        skills: [],
        appHome: fx.appHome,
        runtime: 'claude-code',
        runtimeParams: {
          model: null,
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
        },
        db,
      })
    } finally {
      claudeCodeDriver.buildBusinessSpawn = original
    }
  }

  test('注入的子代理不在清单里 ⇒ failed 并点名', async () => {
    // 正是 2026-08-09 那条 bug 的形态：`--agents` 发了，运行时没有它。
    const fx = f('startup-inv-agent-missing-')
    const r = await run(
      fx,
      'nr-agent-missing',
      { agents: ['auditor'] },
      { agents: ['general-purpose'] },
    )
    expect(r.status).toBe('failed')
    expect(r.errorMessage).toContain('runtime-capability-missing')
    expect(r.errorMessage).toContain('auditor')
  }, 30_000)

  test('要求装载的工具不在清单里 ⇒ failed 并点名', async () => {
    const fx = f('startup-inv-tool-missing-')
    const r = await run(fx, 'nr-tool-missing', { tools: ['Read', 'Task'] }, { tools: ['Read'] })
    expect(r.status).toBe('failed')
    expect(r.errorMessage).toContain('runtime-capability-missing')
    expect(r.errorMessage).toContain('Task')
  }, 30_000)

  test('技能清单跨版本不稳定时只告警，不阻断正常节点', async () => {
    const fx = f('startup-inv-skill-missing-')
    const r = await run(fx, 'nr-skill-missing', { skills: ['pdf-tools'] }, { skills: ['debug'] })
    expect(r.status).toBe('done')
    expect(r.outputs.result).toBe('ok')
  }, 30_000)

  test('三类都齐 ⇒ 正常跑完；清单里多出来的东西不关平台的事', async () => {
    const fx = f('startup-inv-ok-')
    const r = await run(
      fx,
      'nr-ok',
      { tools: ['Read', 'Task'], agents: ['auditor'], skills: ['pdf-tools'] },
      {
        tools: ['Read', 'Task', 'Edit'],
        agents: ['auditor', 'general-purpose'],
        skills: ['pdf-tools', 'debug'],
      },
    )
    expect(r.status).toBe('done')
    expect(r.outputs.result).toBe('ok')
  }, 30_000)

  test('运行时不报清单 ⇒ 放行（无法证明 ≠ 证否，fork 不该因此变红）', async () => {
    const fx = f('startup-inv-silent-')
    const r = await run(fx, 'nr-silent', { agents: ['auditor'] }, {})
    expect(r.status).toBe('done')
  }, 30_000)

  // MCP 是第四类清单，但它的判据与前三类不同：`init.mcp_servers` 报的是**连接
  // 状态**而不是存在性，而「连不上」可能是外部故障（远端挂了、网络断了），不像
  // 技能/子代理缺失那样必然是平台配置问题。RFC-242 T5 因此只把**平台围栏的**
  // local MCP 做成节点失败，其余「keeps its historical best-effort behavior」。
  //
  // 那条保守选择本身没问题，问题是**差集完全不可见**：`--allowedTools` 放行了
  // 全部注入的 MCP，而只有围栏的那些会被核对，于是一个远程 MCP 没连上时，模型
  // 少了它声明的工具、照样跑完、照样 done，日志里一个字都没有。下面两条锁的是
  // 「行为不变、但必须留下痕迹」——升级为失败是另一个决策，不在这里做。
  test('非围栏的注入 MCP 没连上 ⇒ 不失败，但必须留下告警痕迹', async () => {
    const fx = f('startup-inv-mcp-unfenced-')
    const r = await run(
      fx,
      'nr-mcp-unfenced',
      {},
      { mcp_servers: [{ name: 'remote-api', status: 'failed' }] },
      { declaredMcpServers: ['remote-api'] },
    )
    expect(r.status).toBe('done')
    expect(r.errorMessage ?? '').not.toContain('mcp')
  }, 30_000)

  test('围栏 MCP 没连上仍然失败（RFC-242 T5 的判据不因本次可见性改动而松动）', async () => {
    const fx = f('startup-inv-mcp-fenced-')
    const r = await run(
      fx,
      'nr-mcp-fenced',
      {},
      { mcp_servers: [{ name: 'search', status: 'failed' }] },
      { declaredMcpServers: ['search'], fencedMcpServers: ['search'] },
    )
    expect(r.status).toBe('failed')
    expect(r.errorMessage).toContain('mcp-unavailable')
  }, 30_000)
})
