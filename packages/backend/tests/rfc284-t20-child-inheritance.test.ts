// RFC-284 T20（§4）—— buildChildDeps 子任务继承面的双向锁。
//
// 方向一（防漏配）：INHERITABLE_RUN_CONFIG_KEYS 是唯一登记，buildChildDeps 整体
// 透传；picker 语义与旧逐字段 `!== undefined` 展开逐字节同构（undefined 不落键、
// appHome 必填恒在）。
// 方向二（防顺手多配）：处置表以 `satisfies Record<keyof RunTaskOptions, …>`
// 编译期穷尽——RunTaskOptions 新增任何字段，此文件不表态就不编译；把 dropped
// 改标 inherit 还要同时动 registry 与本文件两处快照，评审必然可见。
// dropped 侧 10 键的逐字段处置（design §4 路 2 P2 要求的登记表；T30 修配后
// script 两键已离开本组，处置理由保留如下供追溯）：
//   - scriptInterpreters / scriptDepsInstallTimeoutMs：已随 RFC-284 T30 修配
//     **转 inherit**（用户拍板）——追查发现根任务同样断线（launch 臂 runtime
//     携带、StartTaskDeps 缺席、runtimeConfigOpts 丢弃），根侧修通 + 子任务
//     下传一并落地（proposal C9）。
//   - codeHostConnections / codeHostFetch：**刻意不下传（T30 更正原「疑似漏配」
//     判读）**——scheduler 在消费点自带 keyfile 自解析兜底
//     （`opts.codeHostConnections ?? resolveCodeHostConnectionsFromKeyFile`，
//     scheduler.ts）；opts 注入是纯测试缝，子任务与根任务同样走自解析，无断线。
//   - fanoutMaxShardTotal：事实等效——默认常量同值（256），子任务回落默认与
//     显式下传同判；显式贯穿留给配置线统一（RFC-287 装配线收敛的自然席位）。
//   - commitPushModel / commitPushRuntime / commitPushMaxRepairRetries /
//     commitPushDiffMaxBytes / commitPushLang / mergeAgentModel /
//     mergeAgentRuntime：刻意不继承（现状如实）——内建 commit/merge agent 的
//     运行时配置由各任务 launch 时从设置重解析，子任务 launch 路径亦然；
//     经 buildChildDeps 下传反而会让「设置改了但在跑链未变」的窗口拉长。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  INHERITABLE_RUN_CONFIG_KEYS,
  pickInheritableRunConfig,
  type RunTaskOptions,
} from '../src/services/scheduler'

type Disposition = 'per-task' | 'inherit' | 'dropped-registered'

const DISPOSITION = {
  taskId: 'per-task',
  db: 'per-task',
  log: 'per-task',
  signal: 'per-task',
  appHome: 'inherit',
  binaryOverride: 'inherit',
  configPath: 'inherit',
  defaultPerNodeTimeoutMs: 'inherit',
  defaultNodeRetries: 'inherit',
  defaultRuntime: 'inherit',
  maxConcurrentNodes: 'inherit',
  maxConcurrentScriptNodes: 'inherit',
  maxConcurrentCodeHostCalls: 'inherit',
  codeHostRequestTimeoutMs: 'inherit',
  codeHostResponseMaxBytes: 'inherit',
  multiProcessSubprocessConcurrency: 'inherit',
  maxActiveChildTasks: 'inherit',
  maxInvocationDepth: 'inherit',
  subagentLiveCapture: 'inherit',
  scriptInterpreters: 'inherit',
  scriptDepsInstallTimeoutMs: 'inherit',
  fanoutMaxShardTotal: 'dropped-registered',
  codeHostConnections: 'dropped-registered',
  // RFC-304: a service instance, like codeHostConnections. A child task started
  // by a call node builds its own — inheriting a runner bound to the parent's
  // db handle and program-stage registry would give the child the parent's
  // execution surface.
  codeCapabilityRunner: 'dropped-registered',
  codeHostFetch: 'dropped-registered',
  // RFC-304: the daemon generation fencing MR leases. INHERITED, unlike the
  // service instances above — it identifies the process, and a child task runs
  // in the same one. Giving a child a different generation would make it treat
  // its own parent's live leases as void and take an MR out from under it.
  daemonGeneration: 'inherit',
  commitPushModel: 'dropped-registered',
  commitPushRuntime: 'dropped-registered',
  commitPushMaxRepairRetries: 'dropped-registered',
  commitPushDiffMaxBytes: 'dropped-registered',
  commitPushLang: 'dropped-registered',
  mergeAgentModel: 'dropped-registered',
  mergeAgentRuntime: 'dropped-registered',
} as const satisfies Record<keyof RunTaskOptions, Disposition>

const keysWith = (d: Disposition): string[] =>
  Object.entries(DISPOSITION)
    .filter(([, v]) => v === d)
    .map(([k]) => k)
    .sort()

describe('RFC-284 T20 — 子任务继承面双向锁', () => {
  test('inherit 标签集 ≡ INHERITABLE_RUN_CONFIG_KEYS（登记单源，双向集合相等）', () => {
    expect(keysWith('inherit')).toEqual([...INHERITABLE_RUN_CONFIG_KEYS].sort())
  })

  test('dropped 集合不变快照（改标签必须动这里，评审可见）', () => {
    expect(keysWith('dropped-registered')).toEqual(
      [
        'fanoutMaxShardTotal',
        'codeHostConnections',
        'codeHostFetch',
        // RFC-304: the code-capability runner. Dropped for the same reason as
        // codeHostConnections — a child builds its own rather than inheriting
        // a service bound to the parent's db handle and stage registry.
        'codeCapabilityRunner',
        'commitPushModel',
        'commitPushRuntime',
        'commitPushMaxRepairRetries',
        'commitPushDiffMaxBytes',
        'commitPushLang',
        'mergeAgentModel',
        'mergeAgentRuntime',
      ].sort(),
    )
  })

  test('picker 与登记面同构：全值透传 18 键（T30 修配 +2、RFC-304 +1）、undefined 不落键、appHome 恒在', () => {
    const full: RunTaskOptions = {
      daemonGeneration: 'gen-1',
      taskId: 't1',
      db: {} as RunTaskOptions['db'],
      appHome: '/home',
      binaryOverride: ['bin'],
      configPath: '/cfg.json',
      defaultPerNodeTimeoutMs: 1,
      defaultNodeRetries: 2,
      defaultRuntime: 'opencode',
      maxConcurrentNodes: 3,
      maxConcurrentScriptNodes: 4,
      maxConcurrentCodeHostCalls: 5,
      codeHostRequestTimeoutMs: 6,
      codeHostResponseMaxBytes: 7,
      multiProcessSubprocessConcurrency: 8,
      maxActiveChildTasks: 9,
      maxInvocationDepth: 10,
      subagentLiveCapture: { pollMs: 11, consecutiveFailureLimit: 12 },
      // T30 修配转正两键（RFC-253）：现在必须出现在 picker 输出里
      scriptInterpreters: { python: '/py' },
      scriptDepsInstallTimeoutMs: 13,
      // dropped 侧给值：绝不能出现在 picker 输出里
      fanoutMaxShardTotal: 99,
      commitPushModel: 'm',
    }
    const picked = pickInheritableRunConfig(full)
    expect(Object.keys(picked).sort()).toEqual([...INHERITABLE_RUN_CONFIG_KEYS].sort())
    expect(picked.appHome).toBe('/home')
    expect(picked.subagentLiveCapture).toEqual({ pollMs: 11, consecutiveFailureLimit: 12 })
    expect(picked.scriptInterpreters).toEqual({ python: '/py' })
    expect(picked.scriptDepsInstallTimeoutMs).toBe(13)
    expect('fanoutMaxShardTotal' in picked).toBe(false)
    expect('commitPushModel' in picked).toBe(false)

    const sparse = pickInheritableRunConfig({
      taskId: 't2',
      db: {} as RunTaskOptions['db'],
      appHome: '/h2',
    })
    expect(Object.keys(sparse)).toEqual(['appHome']) // undefined 不落键（exactOptional 同构）
  })

  test('源码锁：buildChildDeps 整体透传且旧逐字段展开归零', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    const start = src.indexOf('function buildChildDeps')
    expect(start).toBeGreaterThan(-1)
    const section = src.slice(start, src.indexOf('async function launchCallChild', start))
    expect(section).toContain('...pickInheritableRunConfig(opts)')
    for (const key of INHERITABLE_RUN_CONFIG_KEYS) {
      expect(section.includes(`opts.${key}`)).toBe(false)
    }
  })
})
