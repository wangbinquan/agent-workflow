// 2026-08-09 —— claude 运行时「技能注入全链失效」回归锁。
//
// 起因：一台用定制 claude 二进制的机器上，agent 依赖里配了技能，运行时报「找不到
// skill」。查下来是 2026-08-04 那条 `--disable-slash-commands` 事故的**下一层**：
// 上一层修好之后，技能仍然一个都进不去。
//
// 根因（本机 claude 2.1.226 二进制反查 + 实测对照）：受控 argv 无条件下发
// `--setting-sources ""`，而 CLI 的用户级技能扫描是
//
//     let r = join(Hn(), "skills")                       // Hn() = CLAUDE_CONFIG_DIR
//     Tg("userSettings") && !s ? Y0r(r, "userSettings", t) : Promise.resolve([])
//
// `Tg(x) = fC().includes(x)`；`fC()` 读 `allowedSettingSources`；`--setting-sources ""`
// 经 `zkc("")` 解析成 `[]` ⇒ `Tg("userSettings") === false` ⇒ `$CLAUDE_CONFIG_DIR/skills/*`
// **整个目录不扫**。模型调用时 CLI 回 `Unknown skill: <name>`。
//
// 实测对照（把 API 指向死回环端口，只跑启动期发现，读 `system/init` 的 `skills` 数组）：
//   --setting-sources ""    → 15 条（全是 bundled），平台 stage 的技能不在其中
//   --setting-sources user  → 16 条，平台技能可见
//   不带该 flag              → 16 条，平台技能可见
//
// 于是「拿到 Skill 工具的唯一途径是声明 permission」而「声明 permission 的唯一后果
// 是进受控分支拿到 `--setting-sources ''`」——用户唯一会**故意开启技能**的配置，正好
// 是唯一必挂的配置。
//
// 本文件锁三件事：
//   1. 授予 Skill ⇒ `--setting-sources user`；其余形态维持 `''`（字节不变）。
//   2. stage 技能树时剔除 `.claude-plugin`。开了 `user` 之后，技能目录里只要有
//      `.claude-plugin/plugin.json`，CLI 就把它当**插件**加载（实测 init 的 `plugins`
//      里出现 `evil-skill@skills-dir`），而插件可带 hooks/agents/mcpServers ——
//      hooks 就是任意命令执行。`""` 此前只是**碰巧**把这条提权面一起挡住了。
//   3. init 的 `skills` 清单做 fail-closed 校验（与 RFC-242 T5 的 `fencedMcpServers`
//      同构）：授予了 Skill、技能也 stage 了，但 CLI 的启动清单里没有 ⇒ 节点失败，
//      而不是让模型在没有技能的情况下跑完一整轮再报 done。

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_CONFIG_DIR_PROFILE, type Agent } from '@agent-workflow/shared'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'
import { claudeCodeDriver } from '../src/services/runtime/claudeCode/driver'
import { parseStartupInventory } from '../src/services/runtime/claudeCode/events'
import {
  buildClaudeSpawn,
  claudeDeclaredControlArgv,
} from '../src/services/runtime/claudeCode/spawn'
import { stageSkills } from '../src/services/runtime/stageSkills'
import type {
  BusinessNodeSpawnContext,
  ResolvedSkill,
  SpawnPlan,
} from '../src/services/runtime/types'
import type { RuntimeProfile } from '../src/services/runtimeRegistry'
import { createLogger } from '../src/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []
const log = createLogger('claude-skill-injection-test')

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(prefix: string): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(value)
  return value
}

/** Write `<dir>/<relPath>` creating parents. */
function put(dir: string, relPath: string, body: string): string {
  const path = join(dir, relPath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
  return path
}

/** A managed skill snapshot the way `~/.agent-workflow/skills/{id}/files/` looks. */
function mkSkillSnapshot(base: string, name: string, extra: Record<string, string> = {}): string {
  const dir = join(base, 'snapshots', name)
  mkdirSync(dir, { recursive: true })
  put(dir, 'SKILL.md', `---\nname: ${name}\ndescription: d\n---\nbody\n`)
  for (const [rel, body] of Object.entries(extra)) put(dir, rel, body)
  return dir
}

function mkExecutable(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, body)
  Bun.spawnSync(['chmod', '755', path])
  return path
}

function mkAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-claude',
    name: 'claude-agent',
    description: 'desc',
    outputs: ['result'],
    syncOutputsOnIterate: true,
    // 授予 Skill 的最小声明——正是本文件所修故障的触发配置。
    permission: { read: 'allow', skill: 'allow' },
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
  const claudeBinary = mkExecutable(join(base, 'bin'), 'claude', '#!/bin/sh\nexit 0\n')
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
    repoWorktreePaths: [f.worktreePath],
    runRoot: f.runRoot,
    configDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
    runtimeBinary: f.claudeBinary,
    wantsInventory: false,
    nodeRunId: 'nr-1',
    appHome: f.appHome,
    taskId: 'task-1',
    nodeId: 'node-1',
    log,
    ...overrides,
  }
}

/** Value that directly follows `flag` in an argv (null when the flag is absent). */
function argAfter(argv: readonly string[], flag: string): string | null {
  const i = argv.indexOf(flag)
  return i === -1 || i + 1 >= argv.length ? null : (argv[i + 1] as string)
}

// ---------------------------------------------------------------------------
// 1. argv：`--setting-sources` 的值必须跟随 Skill 授予
// ---------------------------------------------------------------------------

describe('授予 Skill ⇒ --setting-sources user（否则技能目录根本不被扫描）', () => {
  test('授予 Skill ⇒ user', () => {
    const argv = claudeDeclaredControlArgv({ tools: 'Read,Skill', skillsGranted: true })
    expect(argAfter(argv, '--setting-sources')).toBe('user')
    // 2026-08-04 那条修复必须同时保持：两个开关都放开才谈得上技能可用。
    expect(argv).not.toContain('--disable-slash-commands')
  })

  test('未授予 Skill ⇒ 维持 ""（历史形状字节不变）', () => {
    const argv = claudeDeclaredControlArgv({ tools: 'Read,Grep' })
    expect(argAfter(argv, '--setting-sources')).toBe('')
    expect(argv).toContain('--disable-slash-commands')
  })

  test('放开的只有 user 这一档——project / local 依旧关死', () => {
    const argv = claudeDeclaredControlArgv({ tools: 'Read,Skill', skillsGranted: true })
    const value = argAfter(argv, '--setting-sources')
    expect(value).not.toContain('project')
    expect(value).not.toContain('local')
    // 其余受控 flag 一个都不能少。
    expect(argv.slice(0, 2)).toEqual(['--permission-mode', 'dontAsk'])
    expect(argv).toContain('--strict-mcp-config')
  })
})

describe('buildClaudeSpawn：只有「会用技能」的形态才放开 user', () => {
  test('业务节点声明了 skill:allow ⇒ user，且技能真的落在被扫描的目录里', () => {
    const f = fixture('claude-skills-argv-')
    const snapshot = mkSkillSnapshot(f.base, 'pdf-tools')
    const plan = buildClaudeSpawn({
      claudeCmd: [f.claudeBinary],
      prompt: 'p',
      systemPromptText: 's',
      attemptDir: f.runRoot,
      worktreePath: f.worktreePath,
      surface: 'business',
      businessTools: 'Read,Skill',
      skills: [{ name: 'pdf-tools', sourceKind: 'managed', sourcePath: snapshot }],
      log,
    })
    expect(argAfter(plan.cmd, '--setting-sources')).toBe('user')
    // CLI 扫的是 `$CLAUDE_CONFIG_DIR/skills/<dir>/SKILL.md`，dir 名就是技能的
    // canonical 名（2.1.226 实测：frontmatter 的 name 只落成 displayName）。
    const staged = join(f.runRoot, '.claude', 'skills', 'pdf-tools', 'SKILL.md')
    expect(existsSync(staged)).toBe(true)
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe(join(f.runRoot, '.claude'))
  })

  test('RFC-154 自定义 fork：技能落在 fork 自己的 config dir 下，且该目录经 fork 的 env 键交付', () => {
    // 本次故障就是在一台跑定制 claude 二进制的机器上报出来的。fork 用自己的
    // config-dir 环境变量与叶子名，而 CLI 的技能扫描根是 `Hn()`（= 该环境变量），
    // 所以「stage 到哪」与「用哪个键告诉它」必须是同一个目录，否则技能照样不可见
    // ——那种失配现在由 stagedSkills 的启动清单校验兜住（见下方 runner 用例）。
    const f = fixture('claude-skills-fork-')
    const snapshot = mkSkillSnapshot(f.base, 'pdf-tools')
    const plan = buildClaudeSpawn({
      claudeCmd: [f.claudeBinary],
      prompt: 'p',
      systemPromptText: 's',
      attemptDir: f.runRoot,
      worktreePath: f.worktreePath,
      surface: 'business',
      businessTools: 'Read,Skill',
      configDirEnv: 'CODEAGENT_CONFIG_DIR',
      configDirName: '.codeagent',
      skills: [{ name: 'pdf-tools', sourceKind: 'managed', sourcePath: snapshot }],
      log,
    })
    expect(argAfter(plan.cmd, '--setting-sources')).toBe('user')
    const forkConfigDir = join(f.runRoot, '.codeagent')
    expect(plan.env.CODEAGENT_CONFIG_DIR).toBe(forkConfigDir)
    // 默认键必须被抹掉，否则 fork 可能落回一个陈旧目录（RFC-154 Codex P2）。
    expect(plan.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(existsSync(join(forkConfigDir, 'skills', 'pdf-tools', 'SKILL.md'))).toBe(true)
  })

  test('业务节点未声明权限（unconstrained）⇒ 完全不带该 flag（历史形状）', () => {
    const f = fixture('claude-skills-argv-legacy-')
    const plan = buildClaudeSpawn({
      claudeCmd: [f.claudeBinary],
      prompt: 'p',
      systemPromptText: 's',
      attemptDir: f.runRoot,
      worktreePath: f.worktreePath,
      surface: 'business',
      log,
    })
    expect(plan.cmd).not.toContain('--setting-sources')
    expect(plan.cmd).toContain('bypassPermissions')
  })

  test('intent 只读面 / 系统面 ⇒ 维持 ""（本次修复不碰）', () => {
    const f = fixture('claude-skills-argv-system-')
    const readonlyPlan = buildClaudeSpawn({
      claudeCmd: [f.claudeBinary],
      prompt: 'p',
      systemPromptText: 's',
      attemptDir: join(f.runRoot, 'a'),
      worktreePath: f.worktreePath,
      systemPermissionProfile: 'intent-read-v1',
      log,
    })
    expect(argAfter(readonlyPlan.cmd, '--setting-sources')).toBe('')
    const systemPlan = buildClaudeSpawn({
      claudeCmd: [f.claudeBinary],
      prompt: 'p',
      systemPromptText: 's',
      attemptDir: join(f.runRoot, 'b'),
      worktreePath: f.worktreePath,
      surface: 'system',
      log,
    })
    expect(argAfter(systemPlan.cmd, '--setting-sources')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 2. stage：`.claude-plugin` 不得进入被扫描的技能树
// ---------------------------------------------------------------------------

describe('stageSkills 剔除 .claude-plugin（放开 user 带来的提权面）', () => {
  test('技能树里的 .claude-plugin 整棵不进 staged 树，其余文件原样保留', () => {
    const f = fixture('claude-skills-plugin-')
    const snapshot = mkSkillSnapshot(f.base, 'pdf-tools', {
      '.claude-plugin/plugin.json': '{"name":"pdf-tools","version":"0.0.1"}',
      '.claude-plugin/hooks/hooks.json': '{"PreToolUse":[]}',
      'reference/guide.md': 'keep me',
      '.gitignore': 'keep me too',
      // 前缀相同的普通文件不得被误杀。
      '.claude-plugin.md': 'not a plugin dir',
    })
    const configDir = join(f.base, 'cfg')
    stageSkills(
      configDir,
      [{ name: 'pdf-tools', sourceKind: 'managed', sourcePath: snapshot }],
      log,
    )
    const staged = join(configDir, 'skills', 'pdf-tools')
    expect(existsSync(join(staged, 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(staged, 'reference', 'guide.md'), 'utf8')).toBe('keep me')
    expect(existsSync(join(staged, '.gitignore'))).toBe(true)
    expect(existsSync(join(staged, '.claude-plugin.md'))).toBe(true)
    // 决定性断言：CLI 判定「这是个插件」靠的就是这个目录的存在。
    expect(existsSync(join(staged, '.claude-plugin'))).toBe(false)
  })

  test('嵌套在子目录里的 .claude-plugin 同样剔除', () => {
    const f = fixture('claude-skills-plugin-nested-')
    const snapshot = mkSkillSnapshot(f.base, 'nested', {
      'sub/.claude-plugin/plugin.json': '{"name":"sneaky"}',
      'sub/keep.txt': 'ok',
    })
    const configDir = join(f.base, 'cfg')
    stageSkills(configDir, [{ name: 'nested', sourceKind: 'managed', sourcePath: snapshot }], log)
    const staged = join(configDir, 'skills', 'nested')
    expect(existsSync(join(staged, 'sub', 'keep.txt'))).toBe(true)
    expect(existsSync(join(staged, 'sub', '.claude-plugin'))).toBe(false)
  })

  test('project 技能仍旧跳过、空清单仍旧建目录（既有语义不变）', () => {
    const f = fixture('claude-skills-plugin-semantics-')
    const configDir = join(f.base, 'cfg')
    stageSkills(configDir, [{ name: 'repo-local', sourceKind: 'project' }], log)
    expect(existsSync(join(configDir, 'skills'))).toBe(true)
    expect(existsSync(join(configDir, 'skills', 'repo-local'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. init 清单：授予了技能却没加载上，必须显式失败
// ---------------------------------------------------------------------------

describe('parseSkillInventory 读 claude 的启动技能清单', () => {
  const init = (skills: unknown): string =>
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', skills })

  test('init 的 skills 数组 → 名字清单', () => {
    expect(parseStartupInventory(init(['pdf-tools', 'debug']))?.skills).toEqual([
      'pdf-tools',
      'debug',
    ])
    expect(parseStartupInventory(init([]))?.skills).toEqual([])
  })

  test('非 init / 无 skills 字段 / 非 JSON ⇒ null（继续找下一行）', () => {
    expect(parseStartupInventory('not json')).toBeNull()
    expect(parseStartupInventory(JSON.stringify({ type: 'assistant' }))).toBeNull()
    expect(parseStartupInventory(JSON.stringify({ type: 'system', subtype: 'status' }))).toBeNull()
    expect(parseStartupInventory(init(undefined))).toBeNull()
  })

  test('脏项被过滤，不会把 null 当成技能名', () => {
    expect(parseStartupInventory(init(['ok', null, 42, '']))?.skills).toEqual(['ok'])
  })
})

describe('spawn plan 声明「平台 stage 了哪些技能」', () => {
  test.skipIf(process.platform === 'win32')(
    '授予 Skill + managed 技能 ⇒ stagedSkills 带上它',
    async () => {
      const f = fixture('claude-skills-plan-')
      const snapshot = mkSkillSnapshot(f.base, 'pdf-tools')
      const plan = await claudeCodeDriver.buildBusinessSpawn(
        mkCtx(f, {
          skills: [{ name: 'pdf-tools', sourceKind: 'managed', sourcePath: snapshot }],
        }),
      )
      expect(plan.declaredCapabilities?.skills).toEqual(['pdf-tools'])
    },
  )

  test.skipIf(process.platform === 'win32')(
    '未授予 Skill ⇒ 不声明（该节点本来就用不了技能）',
    async () => {
      const f = fixture('claude-skills-plan-nogrant-')
      const snapshot = mkSkillSnapshot(f.base, 'pdf-tools')
      const plan = await claudeCodeDriver.buildBusinessSpawn(
        mkCtx(f, {
          agent: mkAgent({ permission: { read: 'allow' } }),
          skills: [{ name: 'pdf-tools', sourceKind: 'managed', sourcePath: snapshot }],
        }),
      )
      expect(plan.declaredCapabilities?.skills).toBeUndefined()
    },
  )

  test.skipIf(process.platform === 'win32')(
    'project 技能不进清单——claude 从仓库自发现，平台没 stage 过它',
    async () => {
      const f = fixture('claude-skills-plan-project-')
      const snapshot = mkSkillSnapshot(f.base, 'pdf-tools')
      const skills: ResolvedSkill[] = [
        { name: 'pdf-tools', sourceKind: 'managed', sourcePath: snapshot },
        { name: 'repo-local', sourceKind: 'project' },
      ]
      const plan = await claudeCodeDriver.buildBusinessSpawn(mkCtx(f, { skills }))
      expect(plan.declaredCapabilities?.skills).toEqual(['pdf-tools'])
    },
  )
})

describe.skipIf(process.platform === 'win32')(
  'runner：stage 了技能但启动清单里没有 ⇒ 节点失败，而不是静默丢能力',
  () => {
    async function seedTask(
      f: Fixture,
      nodeRunId: string,
    ): Promise<ReturnType<typeof createInMemoryDb>> {
      const db = createInMemoryDb(MIGRATIONS)
      await db.insert(workflows).values({ id: 'wf-1', name: 'wf-1', definition: '{}' })
      await db.insert(tasks).values({
        id: 'task-1',
        name: 'task-1',
        workflowId: 'wf-1',
        workflowSnapshot: '{}',
        repoPath: f.worktreePath,
        worktreePath: f.worktreePath,
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

    /** Fake runtime emitting ONE init line with the given skill inventory. */
    function fakeRuntime(base: string, skills: string[]): string {
      const init = JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        skills,
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
      return mkExecutable(
        join(base, 'fake-runtime'),
        'runtime',
        `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' ${JSON.stringify(init)}\nprintf '%s\\n' ${JSON.stringify(answer)}\nexit 0\n`,
      )
    }

    async function runWithInventory(
      f: Fixture,
      nodeRunId: string,
      inventory: string[],
    ): Promise<Awaited<ReturnType<typeof runNode>>> {
      const db = await seedTask(f, nodeRunId)
      const original = claudeCodeDriver.buildBusinessSpawn
      claudeCodeDriver.buildBusinessSpawn = async (): Promise<SpawnPlan> => ({
        cmd: [fakeRuntime(f.base, inventory)],
        env: {},
        stdin: { mode: 'pipe', data: 'x' },
        declaredCapabilities: { skills: ['pdf-tools'] },
      })
      try {
        return await runNode({
          taskId: 'task-1',
          nodeRunId,
          nodeId: 'node-1',
          agent: mkAgent(),
          inputs: {},
          worktreePath: f.worktreePath,
          templateMeta: {
            repoPath: f.worktreePath,
            baseBranch: 'main',
            taskId: 'task-1',
            nodeId: 'node-1',
          },
          skills: [],
          appHome: f.appHome,
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

    test('清单里没有该技能 ⇒ 记录告警但不因跨版本枚举差异阻断', async () => {
      // 这正是那台机器上发生的事：技能 stage 了、Skill 工具也授予了，CLI 却因为
      // `--setting-sources ""` 一个都没加载，模型跑完一整轮才报「找不到 skill」。
      const f = fixture('claude-skills-runner-missing-')
      const result = await runWithInventory(f, 'nr-skill-missing', ['debug', 'code-review'])
      expect(result.status).toBe('done')
      expect(result.outputs.result).toBe('ok')
    }, 30_000)

    test('清单里有该技能 ⇒ 正常跑完', async () => {
      const f = fixture('claude-skills-runner-ok-')
      const result = await runWithInventory(f, 'nr-skill-ok', ['pdf-tools', 'debug'])
      expect(result.status).toBe('done')
      expect(result.outputs.result).toBe('ok')
    }, 30_000)
  },
)
