// RFC-143 — runtime 能力对象收口的 PR-1 验收锁。
//
// 两组锁：
//  (A) 派生单源——RUNTIME_PROTOCOLS / BUILTIN_RUNTIMES / ProtocolSchema 从
//      DRIVERS 派生，且 nodeRunMint / runtimeRegistry 不再硬编码
//      `'opencode' || 'claude-code'` 字面量集合。
//  (B) 能力接口——RuntimeDriver 已长出 PR-1 的必需能力方法（minVersion /
//      defaultBinary / probe / listModels / captureSessions），两个内建 driver
//      都实现了它们。mock driver 骨架证明「注册即扩展」：一个第三 kind 的
//      driver 只要实现接口就能被 getRuntimeDriver 契约消费——buildBusinessSpawn
//      在 PR-4 补齐后此骨架扩为完整的零调用点改动集成证明。

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import {
  getRuntimeDriver,
  isKnownRuntimeKind,
  RUNTIME_KINDS,
  type RuntimeDriver,
} from '@/services/runtime'
import { BUILTIN_RUNTIMES, RUNTIME_PROTOCOLS } from '@/services/runtimeRegistry'

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
  it('两内建 driver 都实现了 PR-1 必需能力方法 + minVersion', () => {
    for (const kind of RUNTIME_KINDS) {
      const d = getRuntimeDriver(kind)
      expect(typeof d.minVersion).toBe('string')
      expect(typeof d.defaultBinary).toBe('function')
      expect(typeof d.probe).toBe('function')
      expect(typeof d.listModels).toBe('function')
      expect(typeof d.captureSessions).toBe('function')
    }
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
      minVersion: '0.0.0',
      parseEvent: () => null,
      buildSpawn: () => ({ cmd: ['mock'], env: {} }),
      buildBusinessSpawn: async (ctx) => {
        spawnCalls.push(ctx.agent.name)
        return {
          cmd: ['mock', 'run', ctx.prompt],
          env: { MOCK_RUN_ROOT: ctx.runRoot },
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
    const plan = await driver.buildBusinessSpawn({
      agent: { name: 'mock-agent' } as never,
      prompt: 'P',
      injectedMemoryBlock: null,
      dependents: [],
      mcps: [],
      plugins: [],
      resolvedParamsByAgent: new Map(),
      skills: [],
      worktreePath: '/wt',
      runRoot: '/runs/t/n',
      wantsInventory: false,
      nodeRunId: 'nr1',
      log: { warn: () => {}, info: () => {} } as never,
    })
    expect(plan.cmd).toEqual(['mock', 'run', 'P'])
    expect(plan.env.MOCK_RUN_ROOT).toBe('/runs/t/n')
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

describe('RFC-143 (D) PR-4 业务/smoke spawn 收口 + 旁路清零终锁', () => {
  const SRC_ROOT = resolve(import.meta.dir, '..', 'src')

  it('旁路清零：src 全树（排除 runtime/ driver 实现）无 runtime/protocol kind 判别、无 isClaude', () => {
    // proposal 验收标准 1 的源码文本锁。driver 实现内部（services/runtime/）
    // 允许 kind 分支——那是能力本体；其余任何地方出现 kind 字面量判别都意味着
    // 「注册即扩展」被打破（第 23 处旁路诞生）。
    const offenders: string[] = []
    const kindDiscrimination =
      /(?:runtime|protocol)\s*===\s*['"](?:opencode|claude-code)['"]|\bisClaude\b/
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) {
          if (relative(SRC_ROOT, p) === join('services', 'runtime')) continue
          walk(p)
          continue
        }
        if (!name.endsWith('.ts')) continue
        const src = readFileSync(p, 'utf8')
        if (kindDiscrimination.test(src)) offenders.push(relative(SRC_ROOT, p))
      }
    }
    walk(SRC_ROOT)
    expect(offenders).toEqual([])
  })

  it('runner 业务 spawn 走 driver.buildBusinessSpawn（不再直调两个 spawn 自由函数）', () => {
    const src = SRC('services/runner.ts')
    expect(src).toContain('driver.buildBusinessSpawn(')
    expect(src).not.toContain('buildOpencodeSpawn(')
    expect(src).not.toContain('buildClaudeSpawn(')
    expect(src).not.toContain('toClaudeMcpConfig')
    // 诊断日志读 plan.diagnostics（inline config 构建已在 driver 内部）。
    expect(src).toContain('plan.diagnostics')
    // inventory 注入随 buildBusinessSpawn 搬进 opencode driver。
    expect(src).not.toContain('materializeInventoryPlugin')
  })

  it('smoke 复用 driver.buildSpawn（buildSmokePlan 无 protocol 分支、无手搭 spawn）', () => {
    const src = SRC('services/runtimeSmoke.ts')
    expect(src).toContain('.buildSpawn(')
    expect(src).not.toContain('buildOpencodeSpawn')
    expect(src).not.toContain('buildClaudeSpawn')
  })

  it('memoryDistiller 无 protocol 判别（env 覆盖内化进 opencode driver、凭据桥无条件传递）', () => {
    const src = SRC('services/memoryDistiller.ts')
    expect(src).toContain('bridgeCredentials: true')
    // 锁读取形态（注释可提及）：env 覆盖不再在 distiller 侧读取，回退逻辑在
    // opencode driver 的 buildSpawn 里。
    expect(src).not.toContain('process.env.AGENT_WORKFLOW_OPENCODE_BIN')
    const driverSrc = SRC('services/runtime/opencode/driver.ts')
    expect(driverSrc).toContain('process.env.AGENT_WORKFLOW_OPENCODE_BIN')
  })

  it('claude 凭据桥决策内化在 driver（test 头存在 ⇒ 桥关闭，CI 不碰 keychain）', () => {
    const src = SRC('services/runtime/claudeCode/driver.ts')
    expect(src).toContain('bridgeCredentials: ctx.runtimeCmd === undefined')
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

    it('无显式 binary 时回退 env 覆盖；显式 runtimeBinary 优先', () => {
      process.env.AGENT_WORKFLOW_OPENCODE_BIN = '/opt/env-oc'
      const oc = getRuntimeDriver('opencode')
      expect(oc.buildSpawn({ ...CTX }).cmd[0]).toBe('/opt/env-oc')
      expect(oc.buildSpawn({ ...CTX, runtimeBinary: '/opt/fork-oc' }).cmd[0]).toBe('/opt/fork-oc')
    })

    it('env 未设时保持内建名 opencode（历史行为）', () => {
      delete process.env.AGENT_WORKFLOW_OPENCODE_BIN
      expect(getRuntimeDriver('opencode').buildSpawn({ ...CTX }).cmd[0]).toBe('opencode')
    })
  })
})

describe('RFC-143 (E) PR-5 dedup 收尾（resolveOpencodeCmd 单份 + semver 单份）', () => {
  it('resolveOpencodeCmd 单份：5 个 route 文件不再各自定义（dedup-audit 逐字 5 拷贝）', () => {
    for (const f of ['tasks', 'clarify', 'taskQuestions', 'reviews', 'fusions']) {
      const src = SRC(`routes/${f}.ts`)
      expect(src).not.toContain('function resolveOpencodeCmd')
      expect(src).toContain("resolveOpencodeCmd } from '@/util/opencode'")
    }
    expect(SRC('util/opencode.ts')).toContain('export function resolveOpencodeCmd')
  })

  it('resolveOpencodeCmd 行为：configPath 空/不可读 → undefined；opencodePath 设值 → [path]', async () => {
    const { resolveOpencodeCmd } = await import('../src/util/opencode')
    expect(resolveOpencodeCmd('')).toBeUndefined()
    expect(resolveOpencodeCmd('/definitely/not/a/config.json')).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc143-cfg-'))
    try {
      const p = join(dir, 'config.json')
      writeFileSync(p, JSON.stringify({ opencodePath: '/opt/custom-oc' }))
      expect(resolveOpencodeCmd(p)).toEqual(['/opt/custom-oc'])
      writeFileSync(p, JSON.stringify({}))
      expect(resolveOpencodeCmd(p)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('semver 单份：extractVersion/compareSemver 只定义在 util/semver.ts（claude probe 曾有逐字拷贝）', () => {
    const semverSrc = SRC('util/semver.ts')
    expect(semverSrc).toContain('export function extractVersion')
    expect(semverSrc).toContain('export function compareSemver')
    // 两个 probe 模块不再各自定义（import 使用不受限）。
    for (const f of ['util/opencode.ts', 'services/runtime/claudeCode/probe.ts']) {
      const src = SRC(f)
      expect(src).not.toContain('export function extractVersion')
      expect(src).not.toContain('export function compareSemver(')
    }
    // util/opencode 对既有 import 面保持 re-export（opencode-version.test.ts 锚定行为）。
    expect(SRC('util/opencode.ts')).toContain("compareSemver, extractVersion } from './semver'")
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
