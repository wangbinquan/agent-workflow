// RFC-143 PR-4 (T14) — buildBusinessSpawn 收口前后对拍。
//
// §4.2 的验收方式：收口 = 把 runner 的两个 spawn 分支体整块搬进各自 driver，
// driver 内部仍调用既有 buildOpencodeSpawn / buildClaudeSpawn 自由函数——所以
// 「driver.buildBusinessSpawn(原材料)」必须与「收口前 runner 公式手拍出来的
// 直调结果」argv/env 逐字一致。opencode 侧直接对拍两个完整 plan（golden 锁的
// 延伸：golden 锁 buildOpencodeSpawn 的输出形状，这里锁 driver 传给它的输入
// 不漂移）；claude 侧锁 flag 结构 + system-prompt-file 内容 + stdin + 凭据桥
// 决策。红了 = 收口引入了行为漂移，先回滚该处重做（design §6）。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CONFIG_DIR_PROFILE,
  type Agent,
  type Mcp,
  type Plugin,
} from '@agent-workflow/shared'
import { getRuntimeDriver } from '../src/services/runtime'
import type { BusinessNodeSpawnContext } from '../src/services/runtime/types'
import { buildOpencodeSpawn } from '../src/services/runtime/opencode/spawn'
import { machineSkillRoots, opencodeDataDir } from '../src/services/execution/workspaceBoundary'
import { buildInlineConfig } from '../src/services/runtime/opencode/inlineConfig'
import { toClaudeAgents, toClaudeMcpConfig } from '../src/services/runtime/claudeCode/inject'
import { claudeBusinessGate } from '../src/services/runtime/claudeCode/permissionMap'
import { createLogger } from '../src/util/log'
import type { RuntimeProfile } from '../src/services/runtimeRegistry'

function mkAgent(name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-' + name,
    name,
    description: 'desc-' + name,
    outputs: ['result'],
    syncOutputsOnIterate: true,
    permission: { bash: 'allow' },
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: `## body of ${name}`,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function localMcp(name: string, enabled = true): Mcp {
  return {
    id: 'mcp-' + name,
    name,
    description: '',
    type: 'local',
    config: { command: ['uvx', name + '-mcp'], env: { TOKEN: 't-' + name } } as Extract<
      Mcp,
      { type: 'local' }
    >['config'],
    enabled,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function mkPlugin(name: string, enabled = true): Plugin {
  return {
    id: 'p-' + name,
    name,
    spec: `${name}@1.0.0`,
    options: { key: 'v-' + name },
    description: '',
    enabled,
    sourceKind: 'npm',
    cachedPath: `/tmp/aw-plugins/${name}/node_modules/${name}`,
    resolvedVersion: '1.0.0',
    installedAt: 0,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

const log = createLogger('rfc143-test')

/** 全量原材料的 ctx（inventory 默认关，逐 case 打开）。 */
function mkCtx(runRoot: string, overrides: Partial<BusinessNodeSpawnContext> = {}) {
  const worktreePath = join(runRoot, 'worktree')
  mkdirSync(worktreePath, { recursive: true })
  const agent = mkAgent('root-agent')
  const dep = mkAgent('helper-agent')
  const params = new Map<string, RuntimeProfile>([
    [
      'root-agent',
      {
        model: 'opus',
        variant: 'v1',
        temperature: 0.3,
        steps: null,
        maxSteps: 40,
        isSandbox: true,
      },
    ],
    [
      'helper-agent',
      {
        model: 'mini',
        variant: null,
        temperature: null,
        steps: 5,
        maxSteps: null,
        isSandbox: false,
      },
    ],
  ])
  const ctx: BusinessNodeSpawnContext = {
    agent,
    prompt: 'THE BUSINESS PROMPT',
    injectedMemoryBlock: '## Injected memory\n- fact A',
    dependents: [dep],
    mcps: [localMcp('search'), localMcp('disabled-mcp', false)],
    plugins: [mkPlugin('tracer'), mkPlugin('disabled-plugin', false)],
    resolvedParamsByAgent: params,
    skills: [],
    resumeSessionId: 'ses_42',
    worktreePath,
    taskMounts: [worktreePath],
    runRoot,
    // RFC-154: the runner always supplies the frozen/default profile.
    configDir: DEFAULT_CONFIG_DIR_PROFILE.opencode,
    gitUserName: 'Ada',
    gitUserEmail: 'ada@x.io',
    wantsInventory: false,
    nodeRunId: 'nr-1',
    log,
    ...overrides,
  }
  return ctx
}

describe('RFC-143 PR-4 — opencode buildBusinessSpawn 对拍（收口前 runner 公式）', () => {
  test('全量原材料：driver 输出与收口前公式（buildInlineConfig+织入+序列化+buildOpencodeSpawn）逐字一致', async () => {
    // RFC-154: buildBusinessSpawn 现在真的建 config dir + stage skills，
    // runRoot 必须是真实可写目录（收口前 driver 不碰 FS、假路径能混过）。
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc143-oc-'))
    try {
      const ctx = mkCtx(runRoot, { opencodeCmd: ['bun', 'run', '/mock-opencode.ts'] })
      const plan = await getRuntimeDriver('opencode').buildBusinessSpawn(ctx)

      // 收口前 runner 的公式，手拍出期望 plan：
      // RFC-281 T1: the driver injects the workspace boundary through
      // buildInlineConfig's boundaryCtx, so the hand-rolled formula must
      // reproduce the SAME ctx (driver.ts derives it from runDir / taskMounts /
      // tmp). Same process → tmpdir() and runDir match byte-for-byte.
      const runDir = join(runRoot, ctx.configDir.name)
      const inline = buildInlineConfig(
        ctx.agent,
        ctx.resolvedParamsByAgent,
        ctx.dependents,
        ctx.mcps,
        ctx.plugins,
        {
          taskMounts: ctx.taskMounts,
          runDir,
          stagedSkillDirs: [join(runDir, 'skills'), ...machineSkillRoots()],
          tmpGlobs: [`${join(tmpdir(), 'opencode')}/*`, `${opencodeDataDir()}/tool-output/*`],
        },
      )
      const primary = inline.agent[ctx.agent.name]
      if (primary !== undefined && typeof primary.prompt === 'string') {
        primary.prompt = `${primary.prompt}\n\n${ctx.injectedMemoryBlock}`
      }
      const expected = buildOpencodeSpawn({
        opencodeCmd: ['bun', 'run', '/mock-opencode.ts'],
        agentName: ctx.agent.name,
        prompt: ctx.prompt,
        resumeSessionId: ctx.resumeSessionId,
        worktreePath: ctx.worktreePath,
        runDir: join(runRoot, '.opencode'),
        inlineConfigSerialized: JSON.stringify(inline),
        gitUserName: ctx.gitUserName,
        gitUserEmail: ctx.gitUserEmail,
      })

      expect(plan.cmd).toEqual(expected.cmd)
      expect(plan.env).toEqual(expected.env)
      // 关键 env 面显式锚定（对拍失效时也能一眼看出哪半边坏了）。
      expect(plan.env.OPENCODE_CONFIG_DIR).toBe(join(runRoot, '.opencode'))
      expect(plan.env.OPENCODE_AW_INVENTORY_OUT).toBeUndefined()
      expect(plan.env.GIT_AUTHOR_NAME).toBe('Ada')
      const cfg = JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT ?? '{}') as {
        agent: Record<string, Record<string, unknown>>
        mcp?: Record<string, unknown>
        plugin?: unknown[]
        permission?: { external_directory?: Record<string, unknown> }
      }
      // 织入结果：primary prompt 尾接 memory block；dependent 不织入。
      expect(cfg.agent['root-agent']?.prompt).toBe(
        '## body of root-agent\n\n## Injected memory\n- fact A',
      )
      expect(cfg.agent['helper-agent']?.prompt).toBe('## body of helper-agent')
      // RFC-113 参数按 agent 各取各的。
      expect(cfg.agent['root-agent']?.model).toBe('opus')
      expect(cfg.agent['helper-agent']?.model).toBe('mini')
      // enabled 过滤。
      expect(Object.keys(cfg.mcp ?? {})).toEqual(['search'])
      expect(cfg.plugin).toEqual([
        ['file:///tmp/aw-plugins/tracer/node_modules/tracer', { key: 'v-tracer' }],
      ] as never)
      // RFC-281 T1: the top-level external_directory boundary is now emitted
      // (covers opencode's native subagents), and every agent entry carries the
      // boundary in its own permission map (deny baseline + re-allow).
      expect(cfg.permission?.external_directory?.['*']).toBe('deny')
      expect(
        (cfg.agent['root-agent']?.permission as { external_directory?: Record<string, unknown> })
          ?.external_directory?.['*'],
      ).toBe('deny')

      // §4.4 诊断回传 = 收口前 runner 从 inline config 派生的同一组字段。
      expect(plan.diagnostics).toEqual({
        inlineModel: 'opus',
        inlineVariant: 'v1',
        inlineTemperature: 0.3,
        mcpCount: 1,
        mcpKeys: ['search'],
        pluginCount: 1,
        pluginNames: ['tracer'],
      })
      // RFC-154: skills 落点目录随 spawn 装配建出（空列表也建 — opencode 启动前置）。
      expect(existsSync(join(runRoot, '.opencode', 'skills'))).toBe(true)
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  test('wantsInventory=true：materialize dump plugin + OPENCODE_AW_INVENTORY_OUT（RFC-029 原位搬迁）', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc143-inv-'))
    try {
      const ctx = mkCtx(runRoot, { wantsInventory: true, opencodeCmd: ['oc'] })
      const plan = await getRuntimeDriver('opencode').buildBusinessSpawn(ctx)
      expect(plan.env.OPENCODE_AW_INVENTORY_OUT).toBe(join(runRoot, 'inventory.json'))
      const cfg = JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT ?? '{}') as { plugin?: unknown[] }
      const last = (cfg.plugin ?? []).at(-1)
      expect(typeof last).toBe('string')
      expect(last as string).toStartWith('file://')
      // 插件文件真的物化到了 runRoot 下（dev 源树路径 / 二进制 embed 都走这条）。
      expect(existsSync((last as string).replace(/^file:\/\//, ''))).toBe(true)
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  test('runtimeBinary（custom fork）覆盖 opencodeCmd 头（pickRuntimeHead 语义原位）', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc143-oc3-'))
    try {
      const ctx = mkCtx(runRoot, {
        opencodeCmd: ['bun', 'run', '/mock.ts'],
        runtimeBinary: '/opt/fork-oc',
      })
      const plan = await getRuntimeDriver('opencode').buildBusinessSpawn(ctx)
      expect(plan.cmd[0]).toBe('/opt/fork-oc')
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })
})

describe('RFC-143 PR-4 — claude buildBusinessSpawn 对拍（收口前 runner claude 分支公式）', () => {
  test('全量原材料：flags / system-prompt-file / stdin / env 与收口前分支一致', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc143-cc-'))
    try {
      // runtimeCmd（test 头）在场 ⇒ 凭据桥关闭（CI 不碰 keychain），同收口前
      // `bridgeCredentials: opts.runtimeCmd === undefined` 的语义。
      const ctx = mkCtx(runRoot, {
        runtimeCmd: ['bun', 'run', '/mock-claude.ts'],
        configDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
      })
      const plan = await getRuntimeDriver('claude-code').buildBusinessSpawn(ctx)

      // head = test 头（claude 绝不吃 opencodeCmd —— Codex P1-1）。
      expect(plan.cmd.slice(0, 3)).toEqual(['bun', 'run', '/mock-claude.ts'])
      // 收口前公式的 flag 面。
      const mcpJson = JSON.stringify(toClaudeMcpConfig(ctx.mcps))
      // 2026-08-09 显式改判：`--agents` 不再只是 {description,prompt}。每个
      // dependent 现在带自己解析出的 model，以及自己 permission 推出的 tools
      // （上限是父的装载集，且永不含 Task）。收口前的 runner 公式丢掉了这两样
      // ——dep 跑父的模型、拿父的全部工具——所以这里对拍的是**新公式**，参数与
      // driver 同源。
      const agentsJson = JSON.stringify(
        toClaudeAgents(ctx.dependents, {
          profileByName: ctx.resolvedParamsByAgent,
          parentTools: claudeBusinessGate(ctx.agent.permission)?.tools ?? null,
        })?.agents,
      )
      const cmdStr = plan.cmd.join(' ')
      expect(plan.cmd).toContain('--mcp-config')
      // RFC-280 §7.1: the MCP config (headers may carry user tokens) is a
      // 0600 FILE under runRoot passed by path — inline JSON on argv leaked
      // secrets into /proc/<pid>/cmdline.
      const mcpConfigPath = plan.cmd[plan.cmd.indexOf('--mcp-config') + 1]!
      expect(mcpConfigPath.endsWith('mcp-config.json')).toBe(true)
      expect(readFileSync(mcpConfigPath, 'utf8')).toBe(mcpJson)
      expect(statSync(mcpConfigPath).mode & 0o777).toBe(0o600)
      expect(cmdStr).not.toContain('--strict-mcp-config')
      expect(plan.cmd[plan.cmd.indexOf('--agents') + 1]).toBe(agentsJson)
      // RFC-113：model 来自 root 的 FROZEN runtime profile。
      expect(plan.cmd[plan.cmd.indexOf('--model') + 1]).toBe('opus')
      expect(plan.cmd[plan.cmd.indexOf('--resume') + 1]).toBe('ses_42')
      // prompt 走 stdin（D12）。
      expect(plan.stdin).toEqual({ mode: 'pipe', data: 'THE BUSINESS PROMPT' })
      // persona 织入 memory block 落 system-prompt-file。
      const sysFile = plan.cmd[plan.cmd.indexOf('--append-system-prompt-file') + 1]
      expect(readFileSync(sysFile ?? '', 'utf8')).toBe(
        '## body of root-agent\n\n## Injected memory\n- fact A',
      )
      // RFC-276：不再改写 CLAUDE_CONFIG_DIR；机器环境按 Claude 原生规则继承。
      expect(plan.env.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR)
      // runtime profile 显式开启后注入兼容标记，但它不表示 OS 沙箱。
      expect(plan.env.IS_SANDBOX).toBe('1')
      expect(plan.env.GIT_COMMITTER_EMAIL).toBe('ada@x.io')
      // 2026-08-09 显式改判：这条日志是运维看「这次 spawn 到底注入了什么」的
      // 唯一窗口，所以它不能声称一个根本不发生的注入。`pluginCount`/`pluginNames`
      // 在一个**没有插件面**的运行时上报告「选中的插件数」——日志说 N、进程装载 0，
      // 就是在说谎。改名说实话，与 opencode 侧 `machineConfigIgnoredPlugins`
      // （RFC-256）同一命名法。同时补上此前完全缺席的三类真实注入面，它们与
      // runner 的 fail-closed 校验**同一份派生**，构造上不可能互相矛盾。
      expect(plan.diagnostics).toEqual({
        inlineModel: 'opus',
        inlineVariant: 'v1',
        inlineTemperature: 0.3,
        mcpCount: 1,
        mcpKeys: ['search'],
        pluginsIgnoredUnsupported: 1,
        pluginsIgnoredNames: ['tracer'],
        skillNames: [],
        skillProjectConfigPath: join(ctx.worktreePath, '.claude'),
        subagentNames: ['helper-agent'],
        subagentProjectConfigPath: join(ctx.worktreePath, '.claude'),
        declaredToolNames: ['Bash'],
        // 2026-08-04 审计 P2-9：能力**被移除**的事实此前只在 daemon 日志里。
        // diagnostics 本就是「这次 spawn 装配里实际落了什么」的通道。
        businessTools: 'Bash',
        businessToolWarnings: [],
      })
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  test('空 mcp/依赖/记忆块：不发 --mcp-config/--agents/--model；persona 纯 bodyMd', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc143-cc2-'))
    try {
      const ctx = mkCtx(runRoot, {
        runtimeCmd: ['bun', 'run', '/mock-claude.ts'],
        configDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
        injectedMemoryBlock: null,
        dependents: [],
        mcps: [],
        plugins: [],
        resolvedParamsByAgent: new Map(),
      })
      delete (ctx as { resumeSessionId?: string }).resumeSessionId
      const plan = await getRuntimeDriver('claude-code').buildBusinessSpawn(ctx)
      expect(plan.cmd).not.toContain('--mcp-config')
      expect(plan.cmd).not.toContain('--agents')
      expect(plan.cmd).not.toContain('--model')
      expect(plan.cmd).not.toContain('--resume')
      const sysFile = plan.cmd[plan.cmd.indexOf('--append-system-prompt-file') + 1]
      expect(readFileSync(sysFile ?? '', 'utf8')).toBe('## body of root-agent')
      expect(plan.diagnostics).toEqual({
        inlineModel: null,
        inlineVariant: null,
        inlineTemperature: null,
        mcpCount: 0,
        mcpKeys: [],
        // 2026-08-09：同上改判。空闭包 ⇒ 无 subagent、无 Task。
        pluginsIgnoredUnsupported: 0,
        pluginsIgnoredNames: [],
        skillNames: [],
        skillProjectConfigPath: join(ctx.worktreePath, '.claude'),
        subagentNames: [],
        subagentProjectConfigPath: join(ctx.worktreePath, '.claude'),
        declaredToolNames: ['Bash'],
        // 2026-08-04 审计 P2-9：能力**被移除**的事实此前只在 daemon 日志里。
        // diagnostics 本就是「这次 spawn 装配里实际落了什么」的通道。
        businessTools: 'Bash',
        businessToolWarnings: [],
      })
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  test('runtimeBinary（custom fork）覆盖 runtimeCmd 头', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc143-cc3-'))
    try {
      const ctx = mkCtx(runRoot, {
        runtimeCmd: ['bun', 'run', '/mock-claude.ts'],
        configDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
        runtimeBinary: '/opt/fork-claude',
      })
      const plan = await getRuntimeDriver('claude-code').buildBusinessSpawn(ctx)
      expect(plan.cmd[0]).toBe('/opt/fork-claude')
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })
})
