// RFC-103 T2 (调研报告 01-LIFE-06 / 02-SCHED) — 启动运行期配置透传回归锁。
//
// 为什么这条测试存在：maxConcurrentNodes 从未从任何 HTTP 入口接线（生产恒走
// scheduler 默认 4，无视 settings）；commitPush 只在 JSON start 传，
// resume/repair/retry/multipart-start 均不传，retryNode 内部 runTask 也丢了
// commitPush。本测试锁定：① runtimeConfigOpts 把 StartTaskDeps 的 commitPush +
// maxConcurrentNodes 正确摊进 RunTaskOptions（单一事实源，三处 kick 共用）；
// ② 5 个 route 入口都经 resolveLaunchRuntimeConfig 解析（源码层文本断言防再漂）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runtimeConfigOpts } from '../src/services/task'

describe('RFC-103 T2 runtimeConfigOpts — 单一事实源摊配置', () => {
  test('commitPush 全字段 + maxConcurrentNodes 摊成 flat RunTaskOptions 键', () => {
    expect(
      runtimeConfigOpts({
        // RFC-157: `lang` joins the funnel — this stays a true "all fields" lock.
        commitPush: { model: 'gpt', maxRepairRetries: 2, diffMaxBytes: 9, lang: 'zh-CN' },
        maxConcurrentNodes: 7,
      }),
    ).toEqual({
      commitPushModel: 'gpt',
      commitPushMaxRepairRetries: 2,
      commitPushDiffMaxBytes: 9,
      commitPushLang: 'zh-CN',
      maxConcurrentNodes: 7,
    })
  })

  // RFC-157: commit-message output language threads through the same funnel;
  // absent lang must NOT synthesize a commitPushLang key (undefined ≡ en-US
  // downstream, so the on-the-wire RunTaskOptions stays minimal).
  test('RFC-157: commitPush.lang 摊成 commitPushLang；缺省不合成键', () => {
    expect(runtimeConfigOpts({ commitPush: { lang: 'en-US' } })).toEqual({
      commitPushLang: 'en-US',
    })
    expect(runtimeConfigOpts({ commitPush: { model: 'm' } })).not.toHaveProperty('commitPushLang')
  })

  test('空 deps → 空对象（不污染 RunTaskOptions）', () => {
    expect(runtimeConfigOpts({})).toEqual({})
  })

  test('只有 maxConcurrentNodes', () => {
    expect(runtimeConfigOpts({ maxConcurrentNodes: 3 })).toEqual({ maxConcurrentNodes: 3 })
  })

  test('commitPush 部分字段只摊存在的', () => {
    expect(runtimeConfigOpts({ commitPush: { model: 'm' } })).toEqual({ commitPushModel: 'm' })
  })

  // RFC-117: the commit agent's runtime profile threads through the same funnel.
  test('RFC-117: commitPush.runtime 摊成 commitPushRuntime（model 可共存于过渡期）', () => {
    expect(runtimeConfigOpts({ commitPush: { runtime: 'oc-haiku' } })).toEqual({
      commitPushRuntime: 'oc-haiku',
    })
    expect(runtimeConfigOpts({ commitPush: { model: 'm', runtime: 'oc-haiku' } })).toEqual({
      commitPushModel: 'm',
      commitPushRuntime: 'oc-haiku',
    })
  })

  // RFC-115: timeout (was hand-spread at each runTask site) + the new retry
  // budget + defaultRuntime (Codex F3: never threaded before) all flow through
  // this single funnel now.
  test('RFC-115: defaultPerNodeTimeoutMs / defaultNodeRetries / defaultRuntime 经同一漏斗摊出', () => {
    expect(
      runtimeConfigOpts({
        defaultPerNodeTimeoutMs: 1000,
        defaultNodeRetries: 5,
        defaultRuntime: 'claude-code',
      }),
    ).toEqual({
      defaultPerNodeTimeoutMs: 1000,
      defaultNodeRetries: 5,
      defaultRuntime: 'claude-code',
    })
  })

  test('RFC-115 (Codex F3): defaultRuntime 单独也摊出 — 修复它从未接进 startTask 的 gap', () => {
    expect(runtimeConfigOpts({ defaultRuntime: 'opencode-opus' })).toEqual({
      defaultRuntime: 'opencode-opus',
    })
  })

  test('RFC-115: defaultNodeRetries 0 也摊出（nonnegative，不被当 falsy 跳过）', () => {
    expect(runtimeConfigOpts({ defaultNodeRetries: 0 })).toEqual({ defaultNodeRetries: 0 })
  })

  // RFC-266: 同一个漏斗第三次漏接线。`multiProcessSubprocessConcurrency` 被
  // settings 持久化、被 scheduler 消费，却从来没有人把它从 config 搬进 opts，
  // 于是所有部署上扇出并发恒为硬编码的 4；`maxConcurrentScriptNodes` 是新加的
  // 脚本独立池，必须一开始就走同一条漏斗，不能重蹈覆辙。
  test('RFC-266: 扇出子池 + 脚本池经同一漏斗摊出', () => {
    expect(
      runtimeConfigOpts({
        multiProcessSubprocessConcurrency: 8,
        maxConcurrentScriptNodes: 6,
      }),
    ).toEqual({
      multiProcessSubprocessConcurrency: 8,
      maxConcurrentScriptNodes: 6,
    })
  })

  test('RFC-266: 两个新键单独也摊出；缺省不合成键', () => {
    expect(runtimeConfigOpts({ multiProcessSubprocessConcurrency: 2 })).toEqual({
      multiProcessSubprocessConcurrency: 2,
    })
    expect(runtimeConfigOpts({ maxConcurrentScriptNodes: 2 })).toEqual({
      maxConcurrentScriptNodes: 2,
    })
    expect(runtimeConfigOpts({ maxConcurrentNodes: 1 })).not.toHaveProperty(
      'maxConcurrentScriptNodes',
    )
    expect(runtimeConfigOpts({ maxConcurrentNodes: 1 })).not.toHaveProperty(
      'multiProcessSubprocessConcurrency',
    )
  })

  // RFC-284 T30 修配（RFC-253 覆盖生产死配，漏斗第四次漏接线）：launch 臂一直经
  // `...launchRuntime` 在运行时携带这两键，但 StartTaskDeps 类型缺席 + 本漏斗
  // 未拾取 ⇒ 根任务与子任务双双静默丢弃（spread 绕过 TS 溢出属性检查——与
  // RFC-266 同型事故）。锁死：两键经同一漏斗摊出，缺省不合成键。
  test('RFC-284 T30: scriptInterpreters / scriptDepsInstallTimeoutMs 经同一漏斗摊出；缺省不合成键', () => {
    expect(
      runtimeConfigOpts({
        scriptInterpreters: { python: '/opt/py' },
        scriptDepsInstallTimeoutMs: 120_000,
      }),
    ).toEqual({
      scriptInterpreters: { python: '/opt/py' },
      scriptDepsInstallTimeoutMs: 120_000,
    })
    expect(runtimeConfigOpts({})).not.toHaveProperty('scriptInterpreters')
    expect(runtimeConfigOpts({})).not.toHaveProperty('scriptDepsInstallTimeoutMs')
  })
})

describe('RFC-103 T2 源码层接线断言（防再漂）', () => {
  const routesSrc = readFileSync(join(import.meta.dir, '../src/routes/tasks.ts'), 'utf8')
  const taskSrc = readFileSync(join(import.meta.dir, '../src/services/task.ts'), 'utf8')

  test('routes/tasks.ts + startTaskDeps 的 8 个逻辑入口都线程 resolveLaunchRuntimeConfig', () => {
    const calls = routesSrc.match(/resolveLaunchRuntimeConfig\(deps\.configPath\)/g) ?? []
    // RFC-159 T2: JSON 启动改走 buildStartTaskDeps（工厂内 thread resolveLaunchRuntimeConfig），
    // 第 8 个逻辑入口（JSON）经工厂覆盖。RFC-284 T25：multipart 臂整体迁
    // services/multipartTaskStart.ts（在任何副作用前解析一次、fail/success 两
    // 分支复用同一 launchRuntime——原三 spread 一解析的约束随体走，下方双断言）。
    // tasks.ts 剩 5 个解析点：resume / retry / repair-options / repair /
    // sync-workflow。
    expect(calls.length).toBe(5)
    const orch = readFileSync(
      join(import.meta.dir, '../src/services/multipartTaskStart.ts'),
      'utf8',
    )
    expect((orch.match(/resolveLaunchRuntimeConfig\(deps\.configPath\)/g) ?? []).length).toBe(1)
    expect((orch.match(/\.\.\.launchRuntime/g) ?? []).length).toBe(3)
    // T25 后路由侧不再持有 launchRuntime spread（三处全随编排体走）。
    expect(routesSrc.includes('...launchRuntime')).toBe(false)
    // JSON 入口的运行时配置由 buildStartTaskDeps 携带（数据路径不变）。
    const depsSrc = readFileSync(join(import.meta.dir, '../src/services/startTaskDeps.ts'), 'utf8')
    expect(depsSrc).toContain('resolveLaunchRuntimeConfig(configPath)')
    expect(routesSrc).toMatch(/buildStartTaskDeps\(\s*deps\.db,\s*deps\.configPath,/)
  })

  test('routes 不再保留旧的「只 start 传 commitPush」单点写法', () => {
    expect(routesSrc).not.toContain('...(commitPush !== undefined ? { commitPush } : {})')
  })

  test('start/resume/retry 三处 kick 都经 runtimeConfigOpts 透传', () => {
    const spreads = taskSrc.match(/\.\.\.runtimeConfigOpts\(/g) ?? []
    // startTask + resumeTask（同块 replace_all）+ retryNode = 3
    expect(spreads.length).toBe(3)
  })

  // RFC-266: RFC-243 子任务的 deps 装配（buildChildDeps）必须原样带上三个并发键。
  // 尤其是脚本池 —— 它是 daemon 级单例且 resize-on-read，漏传会让**每一次子任务
  // 启动都把管理员配置的脚本上限静默改回默认 4**（影响整个 daemon，不只是子任务）。
  test('RFC-266: buildChildDeps 透传三个并发键（漏传脚本池 = 全 daemon 被改回默认）', () => {
    const schedulerSrc = readFileSync(join(import.meta.dir, '../src/services/scheduler.ts'), 'utf8')
    const start = schedulerSrc.indexOf('function buildChildDeps(')
    expect(start).toBeGreaterThan(-1)
    const body = schedulerSrc.slice(start, schedulerSrc.indexOf('\n}\n', start))
    // RFC-284 T20 改锚：透传经 INHERITABLE_RUN_CONFIG_KEYS 注册表整体进行——
    // 锁面从「三段手写展开在场」升级为「整体透传在场 + 三键在登记单源里」。
    expect(body).toContain('...pickInheritableRunConfig(opts)')
    for (const key of [
      'maxConcurrentNodes',
      'maxConcurrentScriptNodes',
      'multiProcessSubprocessConcurrency',
    ]) {
      expect(schedulerSrc).toContain(`'${key}',`)
    }
  })

  // Codex impl-gate P1-1（RFC-282 收尾门，漏斗第三段第 N 次实锤）：configPath 是
  // C1 之后 config 头进入 mint 冻结的唯一通道。buildChildDeps 漏传它时,
  // call-workflow / call-workgroup 子任务里 binaryPath=NULL 的 runtime 冻不进
  // config.opencodePath / claudeCodePath —— 子调度器 spawn 裸协议命令。
  test('RFC-282: buildChildDeps 透传 configPath（漏传 = 子任务丢 config 二进制头）', () => {
    const schedulerSrc = readFileSync(join(import.meta.dir, '../src/services/scheduler.ts'), 'utf8')
    const start = schedulerSrc.indexOf('function buildChildDeps(')
    expect(start).toBeGreaterThan(-1)
    const body = schedulerSrc.slice(start, schedulerSrc.indexOf('\n}\n', start))
    // RFC-284 T20 改锚：同上——configPath 经注册表整体透传。
    expect(body).toContain('...pickInheritableRunConfig(opts)')
    expect(schedulerSrc).toContain("'configPath',")
  })

  // RFC-266: 防第四次漏接线 —— 三个并发键都必须出现在 config→deps 的那一级里。
  test('RFC-266: 三个并发键都被 resolveLaunchRuntimeConfig 从 config 读出', () => {
    const launchSrc = readFileSync(
      join(import.meta.dir, '../src/services/launchRuntimeConfig.ts'),
      'utf8',
    )
    for (const key of [
      'maxConcurrentNodes',
      'maxConcurrentScriptNodes',
      'multiProcessSubprocessConcurrency',
    ]) {
      expect(launchSrc).toContain(`cfg.${key} !== undefined`)
      expect(launchSrc).toContain(`out.${key} = cfg.${key}`)
    }
  })

  // RFC-284 T30: RFC-253 两键的全链在场锁 —— config 读出（launchRuntimeConfig）
  // → StartTaskDeps 携带（task.ts）→ 漏斗摊出（上面的纯函数用例）→ 子任务继承
  //（rfc284-t20 登记表）。任何一环回退即红。
  test('RFC-284 T30: scriptInterpreters / scriptDepsInstallTimeoutMs 从 config 读出且 deps 类型在场', () => {
    const launchSrc = readFileSync(
      join(import.meta.dir, '../src/services/launchRuntimeConfig.ts'),
      'utf8',
    )
    for (const key of ['scriptInterpreters', 'scriptDepsInstallTimeoutMs']) {
      expect(launchSrc).toContain(`out.${key} = cfg.${key}`)
      expect(taskSrc).toContain(`${key}?:`) // StartTaskDeps 字段声明在场
      expect(taskSrc).toContain(`deps.${key} !== undefined`) // 漏斗拾取在场
    }
  })

  test('RFC-115: 三处 runTask 调用点不再手动 spread per-node timeout（收进漏斗）', () => {
    // Before RFC-115 each runTask({...}) hand-spread defaultPerNodeTimeoutMs;
    // now runtimeConfigOpts injects it, so the only remaining textual occurrence
    // of the deps spread is INSIDE runtimeConfigOpts itself, and the retryNode
    // `opts.deps.*` variant is gone entirely (Codex F3 single funnel).
    expect(taskSrc).not.toContain('defaultPerNodeTimeoutMs: opts.deps.defaultPerNodeTimeoutMs')
    const depSpreads =
      taskSrc.match(/defaultPerNodeTimeoutMs: deps\.defaultPerNodeTimeoutMs/g) ?? []
    expect(depSpreads.length).toBe(1) // only the funnel
  })
})
