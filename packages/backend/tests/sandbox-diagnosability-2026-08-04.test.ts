// 2026-08-04 沙箱审计「根因 3/4」批的回归锁：沙箱自己出的错不许记到别人头上，
// 降级必须看得见、看得懂、能自救。
//
// 各条锁的真实故障：
//   1. `containedSpawn` 记录**包装后**的 argv[0]。macOS 上那是
//      `/usr/bin/sandbox-exec`，而它 exec-in-place、`ps` 里根本不出现 ⇒
//      `pidCommandContainsBinary` 恒 false ⇒ `killStaleRunProcessTree` 判
//      `command-mismatch`、一个信号都不发；boot reaper 照样把行翻 interrupted
//      并放行启动，resume/retry 的「先杀活写者再回滚」前置被静默绕过。
//      **沙箱越健全越杀不掉**。
//   2. `spawnError` 全仓零读取方，而 spawn 失败时 stderr 尾巴恒为空 ⇒
//      「脚本进程无法启动」+ 空详情。
//   3. `containedSpawn` 没接 `explainSpawnEnoent` ⇒ cwd 消失会被冠名到 bwrap
//      头上（与 2026-08-04 生产事故同型，那次只接了另外三个 spawn 现场）。
//   4. `sandbox-degraded` 这条 rule 从未进 canonical 枚举 ⇒ 诊断面板渲染裸键
//      路径，`REPAIR_OPTIONS[rule]` 取到 undefined 后 `for...of` 抛 TypeError
//      (HTTP 500)——而面板对每条 open 告警**无条件**渲染修复按钮。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isLifecycleAlertRule,
  REPAIR_OPTION_IDS,
  SCRIPT_FAILURE_CODES,
  SCRIPT_PERMANENT_FAILURE_CODES,
} from '@agent-workflow/shared'
import { runContainedProcess } from '../src/services/execution/containedSpawn'
import { REPAIR_OPTIONS } from '../src/services/lifecycleRepair'
import { buildRunSandboxCtx, type SandboxProvider } from '../src/services/sandbox'

describe('containedSpawn — 记录未包装的 argv[0]，否则收割器永远杀不掉', () => {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-sbx-diag-'))
  const seatbelt: SandboxProvider = {
    mode: 'warn',
    status: { mechanism: 'seatbelt', available: true, detail: null },
    appHome,
  }

  test('沙箱生效时 spawnBinaryPath 仍是真实解释器，不是 sandbox-exec', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'aw-sbx-cwd-'))
    try {
      const ctx = buildRunSandboxCtx(seatbelt, 'T1', cwd, join(appHome, 'runs', 'T1', 'R1'))
      const result = await runContainedProcess({
        argv: ['/bin/echo', 'hi'],
        cwd,
        env: {},
        timeoutMs: 10_000,
        ...(ctx === undefined ? {} : { sandbox: ctx }),
      })
      expect(result.spawnBinaryPath).toBe('/bin/echo')
      expect(result.spawnBinaryPath).not.toContain('sandbox-exec')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(appHome, { recursive: true, force: true })
    }
  })
})

describe('containedSpawn — spawn 失败必须带可读原因', () => {
  test('cwd 不存在 ⇒ spawnError 指出缺的是工作目录，而不是可执行文件', async () => {
    const missing = join(tmpdir(), `aw-missing-${Date.now()}-${process.pid}`)
    const result = await runContainedProcess({
      argv: ['/bin/echo', 'hi'],
      cwd: missing,
      env: {},
      timeoutMs: 10_000,
    })
    expect(result.outcome).toBe('spawn-failed')
    expect(result.spawnError ?? '').not.toBe('')
    // `explainSpawnEnoent` 的职责：把 Bun 冠名 argv[0] 的 ENOENT 翻译回真正缺失
    // 的那一个。断言它提到了 cwd 路径，而不是只复读 /bin/echo。
    expect(result.spawnError ?? '').toContain(missing)
  })
})

describe('sandbox-degraded 是一条一等公民 rule', () => {
  test('进了 canonical 枚举（否则前端渲染裸键路径）', () => {
    expect(isLifecycleAlertRule('sandbox-degraded')).toBe(true)
  })

  test('有可用的修复选项（否则诊断面板的按钮直接 500）', () => {
    const defs = REPAIR_OPTIONS['sandbox-degraded']
    expect(defs.length).toBeGreaterThan(0)
    expect(defs[0]?.id).toBe('sandbox-degraded.acknowledge')
    // 选项 id 必须与 shared 的静态目录一致——两侧漂移正是本条最初的成因。
    expect([...REPAIR_OPTION_IDS['sandbox-degraded']]).toEqual(defs.map((d) => d.id))
  })

  test('每条 canonical rule 都能取到非空选项（穷尽，不留第二个 undefined 坑）', () => {
    for (const rule of Object.keys(REPAIR_OPTION_IDS) as Array<keyof typeof REPAIR_OPTION_IDS>) {
      expect(REPAIR_OPTIONS[rule]?.length ?? 0).toBeGreaterThan(0)
    }
  })
})

describe('脚本节点准入失败：按 profile 分化失败码', () => {
  test('三档各有自己的码，且都是永久失败（不烧重试）', () => {
    for (const code of [
      'script-network-fence-unavailable',
      'script-readonly-fence-unavailable',
      'script-containment-unavailable',
    ] as const) {
      expect(SCRIPT_FAILURE_CODES).toContain(code)
      expect(SCRIPT_PERMANENT_FAILURE_CODES).toContain(code)
    }
  })
})
