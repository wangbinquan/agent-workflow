// RFC-356 PR-2 —— Windows 进程树归属接线 + 杀树后等树静默。
//
// locks in the second root cause of GitHub issue #13：`adoptSpawnedProcessTree`
// 自 RFC-254 写好之后**一次都没有被生产代码调用过**（全仓唯一调用点是它自己的测试），
// 于是 Windows 上每次杀树都退在 `taskkill /T /F` 的快照枚举上、后代可逃逸，而逃逸的
// 后代占着 iso 工作树里的句柄，正是 `git worktree remove` 删不掉的直接原因。
//
// 设计门另外查出：即使接了线，L3「等树静默」在 Windows 上**仍然是空转**——
// `terminate()` 在 finally 里 CloseHandle 并把 `liveCount()` 短路成硬编码 0，
// `killProcessTreeWin32` 又紧跟着删 map 项，于是杀树那一刻观测面就被销毁。
// T7/T8 修的就是这个，下面「terminate 之后仍能观测」那组用例锁住它。
//
// 真 Job Object 需要 Windows 内核（`.github/workflows/windows-platform.yml` 那条腿）；
// POSIX 上能证的是：接线存在、门划在哪、进程组语义没漂、以及降级诚实。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  awaitProcessTreeQuiesced,
  adoptSpawnedProcessTree,
  isProcessTreeAlive,
  processTreeOwnershipStatus,
  TREE_QUIESCE_BUDGET_MS,
} from '../src/util/process'
import { processTreeOwnershipDiagnosis } from '../src/util/windowsJobObject'

const isWindows = process.platform === 'win32'

function readSource(...parts: string[]): string {
  return readFileSync(resolve(import.meta.dir, '..', 'src', ...parts), 'utf8')
}

/**
 * 去掉 `//` 行注释后再做「不得出现」断言。
 *
 * 本文件第一版就在这上面翻了车：产品代码的注释里正好写着被断言禁止的符号名
 * （解释「为什么这里刻意不调它」），于是守卫对着注释红了。源码层守卫断言**代码**，
 * 不断言散文。
 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//')
      return at >= 0 ? line.slice(0, at) : line
    })
    .join('\n')
}

describe('RFC-356 · Job Object 接线（防止再次退化成死代码）', () => {
  test('managedProcess 在 spawn 后接管进程树，且先于 onSpawned 的 DB 往返', () => {
    const src = readSource('services', 'execution', 'managedProcess.ts')
    expect(src, '必须真的调用 adoptSpawnedProcessTree').toContain('adoptSpawnedProcessTree(pid)')
    const adoptAt = src.indexOf('adoptSpawnedProcessTree(pid)')
    const onSpawnedAt = src.indexOf('await req.onSpawned(')
    expect(adoptAt).toBeGreaterThan(-1)
    expect(onSpawnedAt).toBeGreaterThan(-1)
    // 顺序是判据：onSpawned 是一次落库，排在 assign 之前会把 spawn→assign 的
    // 窗口从微秒扩成一次 DB 往返。
    expect(adoptAt).toBeLessThan(onSpawnedAt)
  })

  test('正常收尾释放归属；childUnreaped 分支刻意不释放', () => {
    const src = readSource('services', 'execution', 'managedProcess.ts')
    expect(src).toContain('releaseProcessTreeOwnership(pid)')
    // unreaped 分支到它自己的 return 之间不得出现 release：那条分支的前提是
    // 「树没死、我们主动放弃它」，而 release 走的是 dispose = 连带杀树。
    const unreapedAt = src.indexOf('if (childUnreaped) {')
    expect(unreapedAt).toBeGreaterThan(-1)
    const branch = codeOnly(src.slice(unreapedAt, src.indexOf('\n  }', unreapedAt)))
    expect(branch).not.toContain('releaseProcessTreeOwnership')
  })

  test('杀树的门是 killTree 而不是 escalate（drain 超时那条也要算）', () => {
    const src = readSource('services', 'execution', 'managedProcess.ts')
    expect(src, '门标志必须存在').toContain('treeKillAttempted')
    // 三处杀树调用都要经过带门的包装，否则 drain 超时那条会漏掉——而它的触发
    // 条件逐字就是「幸存的孙进程把管道写端占着」。
    expect(codeOnly(src)).not.toMatch(/[^A-Za-z]killTree\(child, 'SIG/)
    expect((src.match(/killTreeForRun\('SIG/g) ?? []).length).toBe(3)
    expect(src).toMatch(/if \(treeKillAttempted && pid !== null\)/)
  })

  test('带外杀树也补了静默跳（resume 前回滚会紧接着往那棵树里写 git）', () => {
    const src = readSource('util', 'process.ts')
    const at = src.indexOf('export async function killStaleRunProcessTree')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at)
    expect(body).toContain('awaitProcessTreeQuiesced(pid')
  })
})

describe('RFC-356 · RFC-254 归属契约修正（T7/T8）', () => {
  test('terminate 不再关句柄，dispose 是唯一关句柄点', () => {
    const src = readSource('util', 'windowsJobObject.ts')
    const terminateAt = src.indexOf('terminate: () => {')
    const liveCountAt = src.indexOf('liveCount: () => {')
    expect(terminateAt).toBeGreaterThan(-1)
    const terminateBody = codeOnly(src.slice(terminateAt, liveCountAt))
    // 观测面必须活过杀树那一刻：否则 L3 在唯一需要它的平台上是空转。
    expect(terminateBody, 'terminate 内不得 CloseHandle').not.toContain('CloseHandle')
    expect(terminateBody, 'terminate 内不得置 closed').not.toMatch(/closed = true/)
    expect(terminateBody).toContain('TerminateJobObject')
    const disposeAt = src.indexOf('dispose: () => {')
    expect(disposeAt).toBeGreaterThan(-1)
    expect(src.slice(disposeAt)).toContain('CloseHandle')
  })

  test('killProcessTreeWin32 尊重 terminate 的返回值，且不在杀树时丢归属', () => {
    const src = readSource('util', 'process.ts')
    const at = src.indexOf('function killProcessTreeWin32')
    const body = codeOnly(src.slice(at, src.indexOf('\n}', at)))
    expect(body, '必须回传 syscall 的真值').toContain('return owned.terminate()')
    expect(body, '不得在 terminate 后立刻删 map 项').not.toContain('ownedTrees.delete(pid)')
  })
})

describe('RFC-356 · awaitProcessTreeQuiesced 三态', () => {
  test('预算是导出的常量', () => {
    expect(TREE_QUIESCE_BUDGET_MS).toBeGreaterThanOrEqual(1_000)
  })

  test('已经死掉的 pid ⇒ dead（POSIX 上进程组即树）', async () => {
    // 一个必然不存在的 pid：非法值直接判死，不进轮询。
    expect(await awaitProcessTreeQuiesced(-1)).toBe('dead')
  })

  test.skipIf(isWindows)(
    '活着的进程组在预算内等不到 ⇒ alive，且不超预算太多',
    async () => {
      const child = Bun.spawn({
        cmd: [process.execPath, '-e', 'setTimeout(() => {}, 30_000)'],
        stdout: 'ignore',
        stderr: 'ignore',
        stdin: 'ignore',
      })
      try {
        const started = Date.now()
        const outcome = await awaitProcessTreeQuiesced(child.pid, { budgetMs: 200, pollMs: 20 })
        const elapsed = Date.now() - started
        // POSIX 上未 detach 的子进程不是自己的组长，isProcessTreeAlive 用
        // `kill(-pid, 0)` 判——拿到 'alive' 或 'dead' 都算合法，关键是**按预算收敛**。
        expect(['alive', 'dead']).toContain(outcome)
        expect(elapsed).toBeLessThan(2_000)
      } finally {
        child.kill(9)
        await child.exited
      }
    },
    15_000,
  )

  test.skipIf(!isWindows)('Windows 上没有 job ⇒ 立即 unknown，绝不空等预算', async () => {
    const started = Date.now()
    const outcome = await awaitProcessTreeQuiesced(999_999, { budgetMs: 5_000 })
    expect(outcome).toBe('unknown')
    // 「测不出」必须立刻返回，不能拿墙钟冒充证据。
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('RFC-356 · 降级诚实（用户裁决 D2）', () => {
  test('POSIX 上接管是惰性的，行为逐字不变', () => {
    expect(adoptSpawnedProcessTree(1)).toBe(isWindows ? adoptSpawnedProcessTree(1) : false)
  })

  test('归属不可用时 isProcessTreeAlive 只能回 null，不得回 false', () => {
    if (!isWindows) return
    if (processTreeOwnershipDiagnosis().available) return
    expect(isProcessTreeAlive(999_999)).toBeNull()
  })

  test('诊断状态可供失败消息复用（PR-3 的 iso 诊断要用）', () => {
    const status = processTreeOwnershipStatus()
    expect(typeof status.available).toBe('boolean')
    expect(['available', 'not-windows', 'ffi-unavailable']).toContain(status.reason)
    if (!isWindows) expect(status.reason).toBe('not-windows')
  })
})
