// RFC-143 — runtime 能力对象收口的 PR-1 验收锁。
//
// 两组锁：
//  (A) 派生单源——RUNTIME_PROTOCOLS / BUILTIN_RUNTIMES / ProtocolSchema 从
//      DRIVERS 派生，且 nodeRunMint / runtimeRegistry 不再硬编码
//      `'opencode' || 'claude-code'` 字面量集合。
//  (B) 能力接口——RuntimeDriver 已长出 PR-1 的必需能力方法（可空 minVersion /
//      defaultBinary / probe / listModels / captureSessions），两个内建 driver
//      都实现了它们。mock driver 骨架证明「注册即扩展」：一个第三 kind 的
//      driver 只要实现接口就能被 getRuntimeDriver 契约消费——buildBusinessSpawn
//      在 PR-4 补齐后此骨架扩为完整的零调用点改动集成证明。

import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  getRuntimeDriver,
  isKnownRuntimeKind,
  RUNTIME_KINDS,
  type RuntimeDriver,
} from '@/services/runtime'
import { BUILTIN_RUNTIMES, RUNTIME_PROTOCOLS } from '@/services/runtimeRegistry'

/** 驱动实现目录（从 runtime 注册表派生，见 rfc282-single-implementation-lock 同名常量）。 */
const RUNTIME_DRIVER_DIRS = RUNTIME_KINDS.map(
  (kind) => `services/runtime/${kind === 'claude-code' ? 'claudeCode' : kind}/`,
)
import { emptyDeclaredManifest } from '@/services/execution/agentInjection'
import { assembleOpencodePersonaSpawn } from '../src/services/runtime/opencode/driver'
import type { AgentSpawnContext } from '../src/services/runtime/types'

const SRC = (rel: string) => readFileSync(resolve(import.meta.dir, '..', 'src', rel), 'utf8')

describe('RFC-143 (A) 派生单源', () => {
  it('RUNTIME_KINDS = DRIVERS 的 keys（当前两内建）', () => {
    expect([...RUNTIME_KINDS].sort()).toEqual(['claude-code', 'opencode'])
  })

  it('RUNTIME_PROTOCOLS 就是 RUNTIME_KINDS（registry 派生自 DRIVERS）', () => {
    expect([...RUNTIME_PROTOCOLS]).toEqual([...RUNTIME_KINDS])
  })

  it('BUILTIN_RUNTIMES 每个 kind 一行、name===protocol===kind', () => {
    expect(BUILTIN_RUNTIMES.map((b) => b.name).sort()).toEqual([...RUNTIME_KINDS].sort())
    for (const b of BUILTIN_RUNTIMES) expect(b.name).toBe(b.protocol)
  })

  it('isKnownRuntimeKind 只认注册的 kind', () => {
    expect(isKnownRuntimeKind('opencode')).toBe(true)
    expect(isKnownRuntimeKind('claude-code')).toBe(true)
    expect(isKnownRuntimeKind('bogus')).toBe(false)
    expect(isKnownRuntimeKind(null)).toBe(false)
    expect(isKnownRuntimeKind(undefined)).toBe(false)
  })

  it('nodeRunMint 不再硬编码 kind 字面量集合（改走 isKnownRuntimeKind）', () => {
    const src = SRC('services/nodeRunMint.ts')
    expect(src).not.toMatch(/=== 'opencode' \|\| .*=== 'claude-code'/)
    expect(src).toContain('isKnownRuntimeKind(')
  })

  it('runtimeRegistry 内建名 fallback 用 BUILTIN_NAMES（不再硬编码字面量）', () => {
    const src = SRC('services/runtimeRegistry.ts')
    expect(src).not.toMatch(/n === 'opencode' \|\| n === 'claude-code'/)
    expect(src).toContain('BUILTIN_NAMES.has(n)')
  })

  it('resolveRuntime 半死代码已删除（flag-audit 旁路：硬编码三元 coerce 第三 runtime）', () => {
    const src = SRC('services/runtime/index.ts')
    expect(src).not.toContain('export function resolveRuntime')
  })
})

describe('RFC-143 (B) 能力接口', () => {
  it('两内建 driver 都实现 PR-1 能力；minVersion 仅为可空 advisory 元数据', () => {
    for (const kind of RUNTIME_KINDS) {
      const d = getRuntimeDriver(kind)
      expect(d.minVersion === null || typeof d.minVersion === 'string').toBe(true)
      expect(typeof d.defaultBinary).toBe('function')
      expect(typeof d.probe).toBe('function')
      expect(typeof d.listModels).toBe('function')
      expect(typeof d.captureSessions).toBe('function')
    }
    expect(getRuntimeDriver('opencode').minVersion).toBeNull()
    // Claude keeps the official-distribution recommendation for diagnostics;
    // probe availability is version-neutral for compatible forks.
    expect(typeof getRuntimeDriver('claude-code').minVersion).toBe('string')
  })

  it('defaultBinary：config path 优先，否则内建名', () => {
    const oc = getRuntimeDriver('opencode')
    expect(oc.defaultBinary({ opencodePath: '/x/oc' } as never)).toEqual(['/x/oc'])
    expect(oc.defaultBinary({} as never)).toEqual(['opencode'])
    const cc = getRuntimeDriver('claude-code')
    expect(cc.defaultBinary({ claudeCodePath: '/x/cl' } as never)).toEqual(['/x/cl'])
    expect(cc.defaultBinary({} as never)).toEqual(['claude'])
  })

  it('claude listModels 是静态表、恒 cached、忽略 binary', async () => {
    const cc = getRuntimeDriver('claude-code')
    const r = await cc.listModels('ignored')
    expect(r.cached).toBe(true)
    expect(r.binary).toBe('ignored')
    expect(r.models.length).toBeGreaterThan(0)
  })

  it('mock driver 集成证明：第三 kind 实现全部能力接口即可被契约消费（「注册即扩展」，PR-4 终锁）', async () => {
    // proposal 验收标准 4：一个新 driver 只要实现 RuntimeDriver（satisfies 在
    // 编译期证明接口完备），业务 spawn / probe / listModels / capture 全链路
    // 都通过 RuntimeDriver 类型的引用跑通——调用点（runner/routes/cli）对 kind
    // 零感知（下方 (D) 组源码锁证明调用点已无 kind 判别，注册即是全部接线）。
    const spawnCalls: string[] = []
    const mockDriver = {
      kind: 'opencode', // 借用已有 kind 满足 RuntimeKind union（真第三 kind 需 widen union）
      // RFC-282 A3 — capabilities 是必填契约：第三 runtime 必须显式表态每个
      // 声明面（缺一个编译不过），启动自检（selfCheck.ts）再在运行时校验一遍。
      capabilities: {
        startupObservation: 'none',
        observationRequiresFreshRun: false,
        declarationFaces: {
          mcpServers: 'unobservable',
          skills: 'unobservable',
          subagents: 'unobservable',
          plugins: 'unobservable',
          tools: 'unobservable',
          droppedParams: 'unsupported',
          skippedDisabledMcps: 'supported',
          unsupported: 'supported',
          unobservable: 'supported',
        },
        // RFC-297 T5 — 同一条棘轮延伸到清单面：第三 runtime 必须逐面逐字段
        // 表态才编译得过。这个 mock 声明「什么都观测不到」，正是一个不产清单
        // 的 runtime 的合法姿态（startupObservation: 'none' 与之自洽）。
        inventory: {
          agents: {
            support: 'unsupported',
            fields: { mode: 'unsupported', model: 'unsupported', source: 'unsupported' },
          },
          skills: {
            support: 'unsupported',
            fields: { source: 'unsupported', path: 'unsupported', description: 'unsupported' },
          },
          mcps: {
            support: 'unsupported',
            fields: { status: 'unsupported', type: 'unsupported', hint: 'unsupported' },
          },
          plugins: { support: 'unsupported', fields: { source: 'unsupported' } },
          tools: { support: 'unsupported', fields: {} },
        },
      },
      minVersion: '0.0.0',
      parseEvent: () => null,
      // RFC-282 B1b：唯一装配方法（golden 归属表「接口面 → 锁单一装配方法」）。
      // 第三 runtime 实现者只需实现 buildSpawn(AgentSpawnContext)，declared 是
      // 返回值的必填字段——「声明=装配副产品」在契约上强制。
      buildSpawn: async (ctx: AgentSpawnContext) => {
        spawnCalls.push(ctx.agentName)
        return {
          cmd: ['mock', 'run', ctx.prompt],
          env: { MOCK_RUN_ROOT: ctx.runRoot },
          stdin: { mode: 'ignore' as const },
          declared: emptyDeclaredManifest(),
          diagnostics: { inlineModel: null },
        }
      },
      defaultBinary: () => ['mock'],
      probe: async (binary: string) => ({ binary, version: '9.9.9', compatible: true }),
      listModels: async (binary: string) => ({ binary, models: [], cached: true }),
      captureSessions: async () => {},
    } satisfies RuntimeDriver
    // 经 RuntimeDriver 契约面消费（与 runner/routes 的调用形态同形）。
    const driver: RuntimeDriver = mockDriver
    const plan = await driver.buildSpawn({
      injection: { mcps: [] },
      agentName: 'mock-agent',
      systemPrompt: '## mock persona',
      prompt: 'P',
      resolvedParamsByAgent: new Map(),
      cwd: '/wt',
      taskMounts: ['/wt'],
      runRoot: '/runs/t/n',
      configDir: { env: 'MOCK_CONFIG_DIR', name: '.mock' }, // RFC-154
      freshAgentRun: false,
      nodeRunId: 'nr1',
      log: { warn: () => {}, info: () => {} } as never,
    })
    expect(plan.cmd).toEqual(['mock', 'run', 'P'])
    expect(plan.env.MOCK_RUN_ROOT).toBe('/runs/t/n')
    expect(plan.declared).toEqual(emptyDeclaredManifest()) // 声明=装配副产品
    expect(spawnCalls).toEqual(['mock-agent'])
    expect((await driver.probe('mock-bin')).compatible).toBe(true)
    expect((await driver.listModels('mock-bin')).cached).toBe(true)
    await driver.captureSessions({} as never)
    // optional 能力缺省 → 调用点 null-object 兜底（与 runner 的 ?? NOOP 同形）。
    expect(driver.startLiveCapture).toBeUndefined()
    expect(driver.readInventory).toBeUndefined()
  })
})

describe('RFC-143 (C) PR-3 optional 能力 + live poller 空转 bug 修复', () => {
  it('claude driver 省略 startLiveCapture（空转 bug：live poll 是 opencode 专属）', () => {
    // 修复前：runner 无条件 startLiveSubagentCapture → claude run 每 1.5s 空开
    // opencode SQLite、恒 0 命中。修复后：claude driver 无此方法 → runner 落
    // NOOP_HANDLE，poller 根本不启动。
    expect(getRuntimeDriver('claude-code').startLiveCapture).toBeUndefined()
    expect(typeof getRuntimeDriver('opencode').startLiveCapture).toBe('function')
  })

  it('claude driver 省略 readInventory（inventory 插件是 opencode 专属）', () => {
    expect(getRuntimeDriver('claude-code').readInventory).toBeUndefined()
    expect(typeof getRuntimeDriver('opencode').readInventory).toBe('function')
  })

  it('runner live poller 走 driver.startLiveCapture? + NOOP fallback（不再无条件启动）', () => {
    const src = SRC('services/runner.ts')
    expect(src).toContain('driver.startLiveCapture?.(')
    expect(src).toContain('?? NOOP_HANDLE')
    // 无条件启动的旧形态不得复活。
    expect(src).not.toMatch(/const livePoller = startLiveSubagentCapture\(/)
  })

  it('runner 会话捕获 / inventory 回读走 driver（消 capture 的 runtime 分支）', () => {
    const src = SRC('services/runner.ts')
    expect(src).toContain('driver.captureSessions(')
    expect(src).toContain('driver.readInventory?.(')
    // capture 不再按 runtime 二选一 captureClaudeSessions/captureChildSessions。
    expect(src).not.toContain('captureClaudeSessions(')
    expect(src).not.toContain('captureChildSessions(')
  })
})

// RFC-317 T19 —— 判据提到模块顶层：全树扫描与「正则自检」原本**各写了一遍**同一条
// 正则。各留一份拷贝时，自检证明的只是拷贝还咬得动，真扫描那份被改弱不会有人发现。
const KIND_DISCRIMINATION =
  /\b(?:runtime|protocol|kind|defaultRuntime)\s*[!=]==\s*['"](?:opencode|claude-code)['"]|\bisClaude\b/

describe('RFC-143 (D) PR-4 业务/smoke spawn 收口 + 旁路清零终锁', () => {
  const SRC_ROOT = resolve(import.meta.dir, '..', 'src')

  it('旁路清零：src 全树（排除 runtime/ driver 实现）无 runtime/protocol kind 判别、无 isClaude', () => {
    // proposal 验收标准 1 的源码文本锁。driver 实现内部（services/runtime/）
    // 允许 kind 分支——那是能力本体；其余任何地方出现 kind 字面量判别都意味着
    // 「注册即扩展」被打破（第 23 处旁路诞生）。
    // RFC-237 ratchet：旧正则只盖小写 `runtime|protocol` + `===`，四处旁路借
    // `!==` / `kind` / `defaultRuntime` 形态逃逸（config/turnEngine/
    // systemAgentRun 已在 RFC-237 能力化消除；start.ts / routes/runtime.ts 入
    // 白名单）。新正则把三种逃逸拼写全部纳入。
    const offenders: string[] = []
    /** RFC-317 T33 —— 正向控制：证明公共层**真的**进了扫描面（见下方断言）。 */
    const scannedRuntimeCommons: string[] = []
    // RFC-317 T19 / findings RT-02 —— 原表三条，实测其中**两条已死**：
    // routes/runtimes.ts 与 services/runner.ts 早已不含任何 kind 判别，豁免却还挂着。
    // 死豁免不是「多余的一行」，是一张**空白许可证**：那两个文件里以后新长出来的
    // kind 判别会被直接跳过、永远不报。下面的 stale 检测保证这种情况不再出现。
    const kindDiscriminationAllowlist = new Set([
      // RFC-237: boot-time probe prewarm keyed off config.defaultRuntime — a
      // startup probability optimization, not spawn assembly; removing it
      // needs a driver boot-probe declaration, out of proportion (design §5).
      'cli/start.ts',
      // RFC-317 T33（RT-03）—— `RuntimeBinaryConfig` 的 `opencodePath` /
      // `claudeCodePath` 两个键**镜像的是用户可见的 config schema 字段名**，不是这里
      // 自己发明的 kind 判别。把它收成 `Record<RuntimeKind, string | null>` 要连
      // config schema 一起改（用户面 + 迁移），与本条「把整目录豁免收窄成驱动目录」
      // 不成比例。收窄扫描面后它第一次可见，先如实入账。
      // removeWhen: 配置项改为按 runtime kind 索引的那次 RFC。
      'services/runtime/types.ts',
    ])
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        // RFC-254: normalize to '/' so the forward-slash allowlist entries and the
        // 'services/runtime' skip match on Windows (relative() yields '\' there,
        // so `.has()` missed every allowlisted file and flagged it as an offender).
        const rp = relative(SRC_ROOT, p).replace(/\\/g, '/')
        if (statSync(p).isDirectory()) {
          // RFC-317 T33（RT-03）—— 只跳过**驱动实现**目录，不跳过整个 services/runtime。
          //
          // 原来是 `if (rp === 'services/runtime') continue`，整棵子树都不走。但那个目录
          // 是混合区：两个驱动子目录，外加每个驱动都会调用的中立公共层。于是 runtime
          // kind 判别破坏力最大的那一块——共享内核——恰恰没有任何守卫看过。
          if (RUNTIME_DRIVER_DIRS.includes(`${rp}/`)) continue
          walk(p)
          continue
        }
        if (!name.endsWith('.ts')) continue
        if (rp.startsWith('services/runtime/')) scannedRuntimeCommons.push(rp)
        if (kindDiscriminationAllowlist.has(rp)) continue
        const src = readFileSync(p, 'utf8')
        if (KIND_DISCRIMINATION.test(src)) offenders.push(rp)
      }
    }
    walk(SRC_ROOT)
    // RFC-317 T33 —— 没有这一条，把豁免放宽回 `rp === 'services/runtime'` 之后一切照绿：
    // 违规集为空与「整块没扫」在断言层面完全同形。实测过——收窄之前它就是这样绿着的。
    expect(
      scannedRuntimeCommons.length,
      'services/runtime 下的**中立公共层**一个都没进扫描面。豁免只该覆盖驱动实现目录；' +
        '整目录跳过会让两个驱动共用的那块内核成为唯一没有守卫看过的地方',
    ).toBeGreaterThanOrEqual(5)
    expect(offenders).toEqual([])
  })

  it('RFC-237 ratchet 自检：三种历史逃逸拼写都被新正则命中', () => {
    // 防未来把正则改弱：曾真实逃逸过的三种拼写（`!==` / `kind ===` /
    // `defaultRuntime ===`）必须持续命中；合法非判别代码不误伤。
    for (const escaped of [
      `if (runtime.protocol !== 'opencode') throw x`,
      `driver.kind === 'opencode'`,
      `config.defaultRuntime === 'claude-code'`,
      `a.runtime === "claude-code"`,
    ]) {
      expect(KIND_DISCRIMINATION.test(escaped)).toBe(true)
    }
    for (const legit of [
      `getRuntimeDriver(runtime.protocol).buildSpawn(ctx)`,
      `protocol: 'opencode',`,
      `const kind = resolved.protocol`,
    ]) {
      expect(KIND_DISCRIMINATION.test(legit)).toBe(false)
    }
  })

  it('runner 业务 spawn 走 driver.buildSpawn（RFC-282 B1b 统一装配；不再直调两个 spawn 自由函数）', () => {
    const src = SRC('services/runner.ts')
    expect(src).toContain('driver.buildSpawn(')
    expect(src).toContain('cwd: opts.worktreePath')
    expect(src).toContain('runRoot,')
    expect(src).not.toContain('buildOpencodeSpawn(')
    expect(src).not.toContain('buildClaudeSpawn(')
    expect(src).not.toContain('toClaudeMcpConfig')
    // 诊断日志读 plan.diagnostics（inline config 构建已在 driver 内部）。
    expect(src).toContain('plan.diagnostics')
    // inventory 注入随 buildBusinessSpawn 搬进 opencode driver。
    expect(src).not.toContain('materializeInventoryPlugin')
  })

  it('smoke 复用 driver.buildSpawn（RFC-282 B1b；buildSmokePlan 无 protocol 分支、无手搭 spawn）', () => {
    const src = SRC('services/runtimeSmoke.ts')
    expect(src).toContain('.buildSpawn(')
    expect(src).not.toContain('buildOpencodeSpawn')
    expect(src).not.toContain('buildClaudeSpawn')
  })

  it('memoryDistiller 无 protocol 判别（spawn 与 transcript capture 均走 driver capability）', () => {
    const src = SRC('modules/memory/application/distill/memoryDistiller.ts')
    expect(src).not.toContain('captureDistillSession')
    const memoryCapture = SRC('modules/memory/infrastructure/memoryDistillSessionCapture.ts')
    expect(memoryCapture).toContain('getRuntimeDriver(input.protocol).captureDistillSession?.(')
    expect(src).not.toContain('bridgeCredentials')
    // 锁读取形态（注释可提及）：env 覆盖不再在 distiller 侧读取，回退逻辑在
    // opencode driver 的 buildSpawn 里。
    expect(src).not.toContain('process.env.AGENT_WORKFLOW_OPENCODE_BIN')
    const driverSrc = SRC('services/runtime/opencode/driver.ts')
    expect(driverSrc).toContain('process.env.AGENT_WORKFLOW_OPENCODE_BIN')
  })

  it('claude driver 继承自然认证环境，不再装配凭据桥', () => {
    const src = SRC('services/runtime/claudeCode/driver.ts')
    expect(src).not.toContain('bridgeCredentials:')
  })

  describe('opencode buildSpawn 的 AGENT_WORKFLOW_OPENCODE_BIN 回退（原 distiller 专属分支）', () => {
    const ORIG = process.env.AGENT_WORKFLOW_OPENCODE_BIN
    afterEach(() => {
      if (ORIG === undefined) delete process.env.AGENT_WORKFLOW_OPENCODE_BIN
      else process.env.AGENT_WORKFLOW_OPENCODE_BIN = ORIG
    })

    const CTX = {
      agentName: 'aw-x',
      systemPrompt: 'S',
      prompt: 'P',
      worktreePath: '/wt',
      runDir: '/rd',
    }

    it('无显式 binary 时回退 env 覆盖；显式 runtimeBinary 优先', async () => {
      process.env.AGENT_WORKFLOW_OPENCODE_BIN = '/opt/env-oc'
      expect((await assembleOpencodePersonaSpawn({ ...CTX })).cmd[0]).toBe('/opt/env-oc')
      expect(
        (await assembleOpencodePersonaSpawn({ ...CTX, runtimeBinary: '/opt/fork-oc' })).cmd[0],
      ).toBe('/opt/fork-oc')
    })

    it('env 未设时保持内建名 opencode（历史行为）', async () => {
      delete process.env.AGENT_WORKFLOW_OPENCODE_BIN
      expect((await assembleOpencodePersonaSpawn({ ...CTX })).cmd[0]).toBe('opencode')
    })
  })
})

describe('RFC-143 (E) PR-5 dedup 收尾（resolveOpencodeCmd 零份 + semver 单份）', () => {
  it('resolveOpencodeCmd 零份 → RFC-284 T19 终态：全 src 零引用，config 头在 mint 冻结单点读', () => {
    // RFC-282 C1-2 已把 15 个入口的 per-entry 解析收拢进 mint 冻结链
    // （execution/runtimeConfigFreeze.freezeBinaryConfig 是 canonical definition）；生产消费方归零后
    // RFC-284 T19 删除了 resolveOpencodeCmd 本体与 re-export。本锁射程如实
    // （T29 路 1 校准）：五个历史路由文件 + util.ts 导出面 + index.ts 再导出
    // ——新址重实现同名函数不在射程内，兜底只剩「对已删导出的 import 必炸
    // typecheck」；真回潮场景（恢复导出/路由再引用）仍即红。
    const tasksRoute = SRC('routes/tasks.ts')
    const fusionsRoute = SRC('routes/fusions.ts')
    expect(tasksRoute).not.toContain('resolveOpencodeCmd')
    expect(tasksRoute).toContain('resolveStructuralDeepConfig(configPath: string)')
    expect(fusionsRoute).not.toContain('resolveOpencodeCmd')
    expect(fusionsRoute).toContain('configPath: deps.configPath')
    for (const f of ['clarify', 'taskQuestions', 'reviews']) {
      const src = SRC(`routes/${f}.ts`)
      expect(src).not.toContain('resolveOpencodeCmd')
      expect(src).not.toContain('configPath: deps.configPath')
    }
    expect(SRC('cli/start.ts')).toContain('configPath: Paths.config')
    expect(SRC('cli/start.ts')).toContain(
      'drive: composeHumanGateContinuationDriver(gateContinuationDeps)',
    )
    expect(SRC('services/runtime/opencode/util.ts')).not.toContain(
      'export function resolveOpencodeCmd',
    )
    expect(SRC('services/runtime/index.ts')).not.toContain('resolveOpencodeCmd,')
    expect(SRC('services/execution/runtimeConfigFreeze.ts')).toContain(
      'export function freezeBinaryConfig',
    )
    expect(SRC('modules/task-execution/composition/nodeMechanics.ts')).toContain(
      "from '@/services/execution/runtimeConfigFreeze'",
    )
    expect(SRC('modules/task-execution/composition/wrapperMechanics.ts')).toContain(
      "from '@/services/execution/runtimeConfigFreeze'",
    )
    expect(SRC('services/scheduler.ts')).not.toContain('function freezeBinaryConfig')
    expect(SRC('services/nodeRunMint.ts')).toContain('configBackedBinary')
    // T19 同批：registry 对二进制缓存驱逐保持 kind-blind（走 driver 可选能力面，
    // 不具名依赖 opencode 缓存实现）。
    expect(SRC('services/runtimeRegistry.ts')).not.toContain('evictOpencodeModelsCache')
    expect(SRC('services/runtimeRegistry.ts')).toContain('evictBinaryCaches?.(')
  })

  it('semver 单份：extractVersion/compareSemver 只定义在 util/semver.ts（claude probe 曾有逐字拷贝）', () => {
    const semverSrc = SRC('util/semver.ts')
    expect(semverSrc).toContain('export function extractVersion')
    expect(semverSrc).toContain('export function compareSemver')
    // 两个 probe 模块不再各自定义（import 使用不受限）。
    for (const f of ['services/runtime/opencode/util.ts', 'services/runtime/claudeCode/probe.ts']) {
      const src = SRC(f)
      expect(src).not.toContain('export function extractVersion')
      expect(src).not.toContain('export function compareSemver(')
    }
    // 搬迁后（RFC-282 C3）对既有 import 面保持 re-export（opencode-version.test.ts 锚定行为）。
    expect(SRC('services/runtime/opencode/util.ts')).toContain(
      "compareSemver, extractVersion } from '@/util/semver'",
    )
  })

  it('resolveInternalAgentRuntime legacyModel 是显式 opencode-only 活转移段（PR-5 审计结论文档锁）', () => {
    // design §5 预案二选一：无活数据删 / 有活数据显式标注。审计结论 = 有活数据
    // （commitPushModel / mergeAgentModel / memoryDistillModel 三字段仍在
    // ConfigSchema 并线上传入），故分支保留 + 注释固化删除条件。
    const src = SRC('services/runtimeRegistry.ts')
    expect(src).toContain('RFC-143 PR-5 audit')
    expect(src).toContain('explicitly opencode-only')
  })
})

// RFC-317 T19 / findings RT-02 —— 豁免表不许有死条目。
//
// 事故形态
// --------
// 「零违规」型扫描的豁免表是按**文件**记的：`allowlist.has(rel) ⇒ continue`。一旦某个
// 文件里的违规被清掉、豁免却留着，那一行就从「记录一处已知例外」变成**空白许可证**——
// 该文件里以后新长出来的同类违规会被直接跳过，扫描永远报零。
//
// 实测（2026-08-23）：三条豁免里有**两条**已经这样了——`routes/runtimes.ts` 与
// `services/runner.ts` 早已不含任何 kind 判别。它们不会让任何测试转红，因此谁都不知道。
//
// 这条检测把「豁免必须仍然对应一处真实违规」变成断言：清掉违规就必须同批删掉豁免。
describe('RFC-317 T19 —— kind 判别豁免表无死条目', () => {
  const SRC_ROOT = resolve(import.meta.dir, '..', 'src')
  // 与上面扫描用的是同一个集合语义；这里重新声明是因为原表声明在 it() 体内。
  // 两处一旦不一致，下面第一条断言会红。
  const ALLOWLIST = ['cli/start.ts', 'services/runtime/types.ts'] as const

  it('豁免表与扫描里用的那份一致（防两份各改各的）', () => {
    const source = readFileSync(
      resolve(import.meta.dir, 'rfc143-runtime-driver-capability.test.ts'),
      'utf8',
    )
    const declared = [...source.matchAll(/^\s{6}'([^']+\.ts)',$/gm)].map((m) => m[1]!)
    expect(declared, '扫描体里的豁免条目与本 describe 的 ALLOWLIST 不一致').toEqual([...ALLOWLIST])
  })

  it('每条豁免都仍然对应一处真实的 kind 判别（否则它是一张空白许可证）', () => {
    const dead: string[] = []
    for (const rel of ALLOWLIST) {
      const p = resolve(SRC_ROOT, rel)
      if (!existsSync(p)) {
        dead.push(`${rel}（文件已不存在）`)
        continue
      }
      if (!KIND_DISCRIMINATION.test(readFileSync(p, 'utf8'))) {
        dead.push(`${rel}（已无 kind 判别）`)
      }
    }
    expect(
      dead,
      '这些豁免已经不对应任何真实违规。**删掉它们**——留着等于给该文件里未来的 kind 判别发空白许可证',
    ).toEqual([])
  })

  it('自证：豁免机制确实会跳过文件（否则上一条断言可能只是恰好为空）', () => {
    const allowlisted = new Set<string>(ALLOWLIST)
    expect(allowlisted.has('cli/start.ts')).toBe(true)
    expect(allowlisted.has('services/scheduler.ts')).toBe(false)
    expect(KIND_DISCRIMINATION.test("if (config.defaultRuntime === 'claude-code') prewarm()")).toBe(
      true,
    )
  })
})
