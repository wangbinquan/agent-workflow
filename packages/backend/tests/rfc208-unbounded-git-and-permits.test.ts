// RFC-208 PR-1 —— daemon 级 `globalSem` permit 永久泄漏 + 无界 git 清理。
//
// 源自用户 2026-07-20「整个系统都卡死了，只能重启解决」的后续审计。两处缺陷都不是
// 原语有 bug，而是**调用点用错**（同一文件里另有三处写法正确）：
//
//   1. scheduler.ts 的 workgroup host-node finally 把 `releaseGlobal()` 排在
//      `await discardNodeIso(...)` **之后**。`discardNodeIso` → `removeWorktree`
//      → `runGit` 全程无 timeout / 不 kill 子进程，`git worktree remove` 撞上残留
//      `index.lock` 就永久挂起 → permit 永不归还。`globalSem` 是 daemon 级共享
//      （processNodeConcurrency.ts，WeakMap keyed by DbClient），泄漏满容量后
//      全 daemon 所有任务停在 `Semaphore.acquire()`，且 stuckTaskDetector 只写
//      告警不修、autoRepair 默认关闭 —— 无自愈，只能重启 daemon。
//      对照正确写法：同文件另外三处都是先 `releaseGlobal()` 再 await 清理。
//
//   2. `await persistIsoBase(...)` 裸露在 `globalSem.acquire()` 与保护它的
//      try/finally 之间。`persistIsoBase` → `transitionMergeState` 抛异常是有
//      文档、且被 rfc144-merge-state-cas.test.ts 锁定的行为 —— 一抛就漏 permit。
//
// Codex 设计门二轮额外指出：只调换释放顺序**不够** —— permit 是救回来了，但
// `runHostNode` 进而 `runTask` 仍永不 resolve，任务永远留在 activeTasks 里，
// cancel / resume 依旧无效。所以清理路径本身必须有界（限时 + 杀掉 git 子进程）。
//
// 测试分两层（沿用本仓对巨型 scheduler 的既有做法，见 process-node-concurrency.test.ts）：
//   · 行为层 —— 对可独立驱动的原语 `runGit` 断言「限时 + 真的杀掉进程树」；
//   · 结构层 —— 对 scheduler.ts 的调用点断言排序不变式，防止顺序被改回去。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runGit } from '../src/util/git'

const schedulerSource = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
  'utf8',
)
const nodeMechanicsSource = readFileSync(
  resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'nodeMechanics.ts',
  ),
  'utf8',
)
const assemblySource = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'schedulerAssembly.ts'),
  'utf8',
)
const executionSource = `${schedulerSource}\n${nodeMechanicsSource}`

/** A git invocation that hangs deterministically, locally, with no network:
 *  a `!`-prefixed alias runs through the shell, so the child spawns a
 *  grandchild `sleep` that outlives a naive `proc.kill()` of the direct child. */
function hangingGitArgs(seconds: number): string[] {
  return ['-c', `alias.awhang=!sleep ${seconds}`, 'awhang']
}

describe('RFC-208 · runGit must be boundable', () => {
  test('timeoutMs returns well before a hanging git would finish', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc208-git-'))
    try {
      await runGit(dir, ['init', '-q', '.'])
      const started = Date.now()
      const r = await runGit(dir, hangingGitArgs(30), { timeoutMs: 750 })
      const elapsed = Date.now() - started

      // Bounded: nowhere near the 30s the alias would otherwise sleep.
      expect(elapsed).toBeLessThan(10_000)
      // A timed-out run must not masquerade as success.
      expect(r.exitCode).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  // RFC-254: this proves the process-GROUP kill via a POSIX `sleep` grandchild
  // and `pgrep -f` survivor scan — neither exists on Windows (`pgrep` → ENOENT).
  // The Windows descendant-lifetime guarantee is the Job Object, covered by
  // rfc254-process-tree-ownership's win32 branch, so no platform loses the
  // "runaway grandchild is reaped" coverage.
  test.skipIf(process.platform === 'win32')(
    'the timeout kills the whole process tree, not just the direct child',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rfc208-git-'))
      const marker = `rfc208-marker-${process.pid}-${dir.slice(-8)}`
      try {
        await runGit(dir, ['init', '-q', '.'])
        // The grandchild carries a unique marker in its argv so we can look for
        // survivors. `util/opencode.ts` learned this the hard way (Codex impl
        // gate): killing only the direct child leaves a hung wrapper's grandchild
        // alive and leaking once per call.
        const started = Date.now()
        await runGit(dir, ['-c', `alias.awhang=!sleep 30 ${marker}`, 'awhang'], { timeoutMs: 750 })
        // Guard against a vacuous pass: without a real timeout this call would
        // simply block the full 30s and the grandchild would be gone by the time
        // we look for it.
        expect(Date.now() - started).toBeLessThan(10_000)

        const survivors = Bun.spawnSync({ cmd: ['pgrep', '-f', marker] })
        const out = new TextDecoder().decode(survivors.stdout).trim()
        expect(out).toBe('')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  test('omitting timeoutMs keeps the historical unbounded behavior byte-for-byte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc208-git-'))
    try {
      await runGit(dir, ['init', '-q', '.'])
      const r = await runGit(dir, ['rev-parse', '--git-dir'])
      expect(r.exitCode).toBe(0)
      expect(r.stdout.trim().length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

// RFC-266 显式改判（不变量不变，覆盖面变宽）：daemon 级的 `globalSem` 已拆成
// `agentSem`（agent 节点 / 工作组主持 / 扇出分片与聚合）与 `scriptSem`（脚本节点）
// 两个独立池。两条 oracle 原本只认 `globalSem.acquire()` / `releaseGlobal()`：
// 前者改名后会**空扫**（`acquires.length > 0` 直接红，本轮就是这么暴露的），后者
// 会**静默漏掉脚本路径**（它释放的是 `releaseScript()`）。permit 泄漏的后果没变
// ——任何一个池的名额漏还都会卡死整个 daemon 上所有任务，所以两条都按池集合展开。
const POOL_RELEASE_NAMES = ['releaseGlobal', 'releaseScript'] as const
const POOL_ACQUIRE_RE = /(?:agentSem|scriptSem)\.acquire\(\)/g

describe('RFC-208 · node-pool permits must survive a wedged or throwing cleanup', () => {
  // Structural oracle #1 — ordering inside every finally that does BOTH.
  //
  // Deliberately table-driven over ALL matching blocks rather than pinned to one
  // line number: the bug was one call site drifting out of line with three
  // correct siblings, so the guard has to cover every site, present and future.
  test('every finally releases the permit BEFORE awaiting iso cleanup', () => {
    // RFC-287 T7 起五条装配线全部迁入骨架，`scheduler.ts` 里已**没有**同时做两件事
    // 的 finally；不变量本身没变，扫描面随代码搬到 `schedulerAssembly.ts`（那里是
    // 全部装配线唯一的取/放点）。两个文件一起扫，对「代码搬到哪」免疫。
    const scanned = `${executionSource}\n${assemblySource}`
    const finallyBlocks = [...scanned.matchAll(/\bfinally\s*\{/g)].map((m) => {
      // Take a generous window; these blocks are short and we only compare the
      // relative order of two markers inside the same block.
      const start = m.index ?? 0
      return scanned.slice(start, start + 900)
    })

    const offenders: string[] = []
    let checkedBlocks = 0
    for (const block of finallyBlocks) {
      for (const name of [...POOL_RELEASE_NAMES, 'release']) {
        const release = block.indexOf(`${name}()`)
        const discard = [block.indexOf('await discardNodeIso('), block.indexOf('spec.discardIso(')]
          .filter((i) => i !== -1)
          .sort((a, b) => a - b)[0]
        if (discard === undefined) continue
        if (release === -1) continue
        checkedBlocks++
        if (release > discard) offenders.push(block.slice(0, 240))
      }
    }

    expect(offenders).toEqual([])
    // 防空扫：release 标识符再被改名时这里先红，而不是悄悄退化成零断言。
    expect(checkedBlocks).toBeGreaterThan(0)
  })

  // Structural oracle #2 — nothing REJECTABLE sits unguarded between acquire
  // and its try.
  //
  // `persistIsoBase` is the concrete instance that bit us, but the invariant is
  // general: once the permit is held, an await that can reject must be inside
  // the try whose finally releases it.
  //
  // `*.acquire()` is deliberately exempt: `Semaphore.acquire` (util/semaphore.ts)
  // builds its promise with a resolve-only executor, so it can never reject and
  // therefore cannot leak the outer permit by throwing. Nesting one budget
  // inside another is an existing sanctioned shape (fanout shard / aggregator);
  // flagging it here would be a false positive, not a finding.
  test('no rejectable await sits between a pool acquire() and its guarding try', () => {
    const acquires = [...executionSource.matchAll(POOL_ACQUIRE_RE)]
    // RFC-266: 两个池都必须被本条守卫覆盖，否则改名/拆池会让它退化成零覆盖。
    // RFC-287 起覆盖有两种合法形态，缺一即为漏网：
    //   ① 直线取许可（`= await xxxSem.acquire()`）——由本扫描器守；
    //   ② 交给装配骨架（`pools: [xxxSem]`）——由下面那条骨架断言守（骨架里取/放
    //      同处、finally 无条件释放，比逐线扫描更强）。
    // 迁移中的中间态（两条线一种形态、一条线另一种）因此仍是全覆盖；等 agent 线
    // 也迁完，形态①会自然清零而覆盖不减。
    for (const pool of ['agentSem', 'scriptSem']) {
      const straightLine = new RegExp(`=\\s*await\\s+(?:state\\.)?${pool}\\.acquire\\(\\)`).test(
        executionSource,
      )
      const viaSkeleton = new RegExp(`pools:\\s*\\[(?:state\\.)?${pool}[,\\]]`).test(
        executionSource,
      )
      expect(
        straightLine || viaSkeleton,
        `${pool} 既不走直线取许可也未声明为骨架 pool——本守卫已对它零覆盖`,
      ).toBe(true)
    }

    const offenders: string[] = []
    for (const m of acquires) {
      const from = (m.index ?? 0) + m[0].length
      const region = executionSource.slice(from, from + 6000)

      // Walk forward tracking try-block nesting. An await that can reject is
      // safe once it is inside ANY try (its finally/catch owns the release);
      // the leak shape is an await sitting at try-depth 0 while the permit is
      // already held. Scanning for "the first `try {`" is NOT enough — the
      // guarding try can be the second one, which is exactly how the
      // persistIsoBase call slipped through review.
      let depth = 0 // brace depth relative to region start
      const tryDepths: number[] = [] // brace depths at which a guarded block opened
      // `finally`/`catch` count as guarded too: by the time control is there the
      // permit is either already released (oracle #1 enforces that ordering) or
      // the block itself owns the release. Only awaits on the straight-line path
      // between acquire and the guard can strand it.
      const opensGuard = (before: string): boolean =>
        /\b(?:try|finally)\s*$/.test(before) || /\bcatch\s*(?:\([^)]*\))?\s*$/.test(before)
      for (let i = 0; i < region.length; i++) {
        const ch = region[i]
        if (ch === '{') {
          if (opensGuard(region.slice(Math.max(0, i - 24), i))) tryDepths.push(depth)
          depth++
          continue
        }
        if (ch === '}') {
          depth--
          while (tryDepths.length > 0 && (tryDepths.at(-1) as number) >= depth) tryDepths.pop()
          // Left the function that held the permit — stop scanning.
          if (depth < 0) break
          continue
        }
        if (ch !== 'a') continue
        const awaitMatch = /^await\s+([\w.]+)\s*\(/.exec(region.slice(i, i + 80))
        if (awaitMatch === null) continue
        const callee = awaitMatch[1] ?? ''
        if (/\.acquire$/.test(callee)) continue // resolve-only, cannot reject
        if (tryDepths.length === 0) {
          offenders.push(`${callee} (unguarded after ${m[0]})`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // RFC-287 起：许可的取/放已收进装配骨架，上面那个扫描器在 scheduler.ts 里
  // **结构性失效**（它从「抢到许可」处起扫、遇到函数边界即停，而各线现在只是
  // 声明 spec、不再自己抢许可）。本条把同一个不变量钉在骨架上——那里是全部五条
  // 装配线唯一的取/放点，比原来逐线扫描更强：
  //   ① 取许可到 try 之间不得有任何 await（原不变量：可拒绝的 await 会漏 permit）；
  //   ② finally 无条件释放全部已取许可，且释放先于 iso 清理（RFC-208 + rfc287 T1⑧）。
  // ---------------------------------------------------------------------------
  test('assembly skeleton: no await between pool acquire and the guarding try', () => {
    const asm = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'schedulerAssembly.ts'),
      'utf8',
    )
    const acquireAt = asm.indexOf('for (const pool of spec.pools)')
    expect(acquireAt, '骨架应有唯一的取许可循环').toBeGreaterThan(-1)
    const tryAt = asm.indexOf('try {', acquireAt)
    expect(tryAt).toBeGreaterThan(acquireAt)
    // 取许可循环与 try 之间只允许空白/注释——出现任何 await 即为 RFC-208 那类漏 permit。
    const between = asm.slice(asm.indexOf('\n', acquireAt), tryAt)
    expect(between).not.toMatch(/\bawait\b/)

    // finally 里无条件释放（不带任何条件判断），且释放排在 iso 清理之前。
    const finallyAt = asm.lastIndexOf('} finally {')
    expect(finallyAt).toBeGreaterThan(tryAt)
    const fin = asm.slice(finallyAt)
    const releaseAt = fin.indexOf('release()')
    const discardAt = fin.indexOf('spec.discardIso')
    expect(releaseAt).toBeGreaterThan(-1)
    expect(discardAt).toBeGreaterThan(releaseAt)
  })
})
