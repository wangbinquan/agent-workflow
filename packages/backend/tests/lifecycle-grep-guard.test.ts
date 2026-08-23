// RFC-053 PR-B P-1 — source-grep guard against direct node_runs.status writes.
//
// Forbids any future code from doing `db.update(nodeRuns).set({ status: ... })`
// outside the single allowlisted writer (`services/lifecycle.ts` itself).
// Forces consumers through `transitionNodeRunStatus()` or `setNodeRunStatus()`,
// which enforce the state machine and CAS predicate.
//
// Tests:
//   - production source files (packages/backend/src) must contain ZERO direct
//     writes (except inside the helper)
//   - the helper itself MUST contain exactly the documented direct writes
//     (regression guard for refactor of the helper)

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')

/**
 * Match anything that looks like `.update(nodeRuns)` followed (eventually)
 * by `.set({ ... status: ... })`. The regex is intentionally permissive on
 * whitespace and chained-call line breaks; refinements only need to catch
 * the COMMON shape — false positives are surfaced as comments / are easy
 * to whitelist with `// rfc053-allow-direct-status-write`
 * style markers (the test scans for an inline allow marker on the line
 * above the match).
 */
const PATTERN_HAS_UPDATE_NODE_RUNS = /\.update\s*\(\s*nodeRuns\s*\)/
const PATTERN_HAS_SET_STATUS = /\.set\s*\(\s*\{[^}]*\bstatus\s*:/

/** Skip lines that look like comments (// or * leading). False positives in
 *  doc comments mentioning `db.update(nodeRuns).set({ status: ... })` are
 *  expected — the helper file's header documents exactly this string. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*')
}

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) {
      out.push(...listTsFiles(p))
    } else if (s.isFile() && /\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(p)
    }
  }
  return out
}

interface Match {
  /**
   * RFC-317 T48（findings LC-02）—— 这条**只是记录**，不再决定放行。
   * 改造前：只要在前 5 行写下 `rfc053-allow-direct-status-write`，任意文件、任意状态、
   * 任意次数的直写都会从扫描结果里消失——这是三台状态机里最弱的一道防线
   * （tasks.status 与 merge_state 都是逐文件精确计数的硬 allowlist）。
   */
  marked: boolean
  file: string
  line: number
  preview: string
}

function findDirectStatusWrites(): Match[] {
  const matches: Match[] = []
  for (const file of listTsFiles(BACKEND_SRC)) {
    const src = readFileSync(file, 'utf8')
    // Cheap pre-filter: only scan files that mention nodeRuns at all.
    if (!src.includes('nodeRuns')) continue
    const lines = src.split('\n')
    // Stateful scan: when we see `.update(nodeRuns)` we set a "look for
    // .set({...status...}) within the next N lines" window. This catches
    // multi-line chains where the .set lives on a separate line.
    let lookahead = 0
    let upstreamLine = -1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (PATTERN_HAS_UPDATE_NODE_RUNS.test(line) && !isCommentLine(line)) {
        lookahead = 6 // 6 lines should cover any reasonable drizzle chain
        upstreamLine = i
        continue
      }
      if (lookahead > 0) {
        if (PATTERN_HAS_SET_STATUS.test(line)) {
          // Skip if opt-out marker present in the 5 preceding source lines
          // (covers multi-line drizzle chains where the marker sits above
          // the await/const but the actual .update(nodeRuns) is a few lines
          // further down).
          const lookbackStart = Math.max(0, upstreamLine - 5)
          const preceding = lines.slice(lookbackStart, i + 1).join('\n')
          matches.push({
            marked: /rfc053-allow-direct-status-write/.test(preceding),
            file: file.replace(`${BACKEND_SRC}/`, ''),
            line: i + 1,
            preview: lines
              .slice(Math.max(0, upstreamLine), Math.min(lines.length, i + 2))
              .map((l, idx) => `  ${upstreamLine + idx + 1}: ${l}`)
              .join('\n'),
          })
          lookahead = 0
        } else {
          lookahead -= 1
        }
      }
    }
    // Also catch single-line forms like
    // `db.update(nodeRuns).set({ status: 'foo' }).where(...)`.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (
        PATTERN_HAS_UPDATE_NODE_RUNS.test(line) &&
        PATTERN_HAS_SET_STATUS.test(line) &&
        !isCommentLine(line)
      ) {
        const lookbackStart = Math.max(0, i - 5)
        const preceding = lines.slice(lookbackStart, i + 1).join('\n')
        const marked = /rfc053-allow-direct-status-write/.test(preceding)
        // Avoid duplicate of multi-line catch above — only add if not already
        // captured at this line.
        if (
          !matches.some(
            (m) => m.file.endsWith(file.replace(`${BACKEND_SRC}/`, '')) && m.line === i + 1,
          )
        ) {
          matches.push({
            marked,
            file: file.replace(`${BACKEND_SRC}/`, ''),
            line: i + 1,
            preview: `  ${i + 1}: ${line}`,
          })
        }
      }
    }
  }
  return matches
}

/**
 * 内核自己的直写条数：`transitionNodeRunStatus` / `setNodeRunStatus` 各一处，
 * 外加 CAS 争用时的重试写。单独提出来是因为下面两条断言都要用到同一个数字——
 * 写死两遍的话，改内核时只改一处会得到一个说谎的绿。
 */
const KERNEL_DIRECT_WRITES = 3

/**
 * RFC-317 T48（findings LC-02）—— **逐文件精确计数**的硬 allowlist。
 *
 * 改造前这条守卫的形态是：扫到直写 → 检查前 5 行有没有
 * `rfc053-allow-direct-status-write` → 有就当作没看见。任意文件、任意状态、任意次数。
 * 而它的两个兄弟棘轮（`tasks.status` 的 s14、`merge_state` 的 rfc144）**都是**逐文件
 * 精确计数的硬 allowlist（`{ 'services/lifecycle.ts': 1 }` / `{ …: 2 }`，并各自单独断言
 * 那个数字，防止空绿）。三台状态机里，调度器实际驱动的那一台防线最弱。
 *
 * 每一条被标记逃逸的直写同时绕过 `assertNodeRunSourceTerminationAdmission`
 * （RFC-303 的 MR/PR 围栏）与终态覆写闸。今天这几处写的都是未设防的状态
 * （'canceled' / 'done'），所以没坏事——但**同一条逃生口对写 'running' 或
 * 'awaiting_review' 一视同仁**，而那正是 RFC-303 存在的理由。
 *
 * 现在：标记留作**文档**（非内核直写必须写，说明它是有意为之），但**授权改由这份
 * 计数表给**。新增文件或增加次数 ⇒ 红；修掉一处却不销账 ⇒ 也红。
 */
const DIRECT_STATUS_WRITE_ALLOWLIST: Readonly<Record<string, number>> = {
  // 内核：`transitionNodeRunStatus` 与 `setNodeRunStatus` 各一处，外加 CAS 的重试写。
  'services/lifecycle.ts': KERNEL_DIRECT_WRITES,
  // RFC-303 之前就存在的三处终态清扫：把超时/孤儿 run 收成 'canceled'。
  'services/terminalSweep.ts': 3,
  // clarify 封存：把已回答的澄清 run 收成 'done'。
  'services/clarify/seal.ts': 1,
}

describe('RFC-053 PR-B / RFC-317 T48 —— node_runs.status 直写的逐文件精确账本', () => {
  const matches = findDirectStatusWrites()

  test('语料非空：确实扫到了直写站点（扫空即假绿）', () => {
    // 两个兄弟棘轮都单独断言过内核那个数字，理由相同：一个「零违规」的绿，
    // 与一个「扫描根失效、什么都没扫到」的绿，在断言层面完全同形。
    expect(matches.length).toBeGreaterThan(0)
  })

  test('逐文件计数与 allowlist **逐条相等**（加一处或加一个文件都红）', () => {
    const counts: Record<string, number> = {}
    for (const match of matches) counts[match.file] = (counts[match.file] ?? 0) + 1
    expect(
      Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
      '新增了 node_runs.status 直写站点——改用 transitionNodeRunStatus() / setNodeRunStatus()；' +
        '确有必要则在 allowlist 里显式加一条并说清它写的是哪个状态。' +
        '反过来，修掉一处却没把数字改小也会红：差额会变成下一个人的免费槽位。',
    ).toEqual(
      Object.fromEntries(
        Object.entries(DIRECT_STATUS_WRITE_ALLOWLIST).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
  })

  test('标记降级为**文档**：非内核的每一处直写仍必须带标记，但标记不再放行', () => {
    // 标记还有价值——它让读代码的人知道「这是有意的，不是漏改」。
    // 它失去的只是「让扫描器闭眼」这项权力。
    const unmarked = matches
      .filter((match) => match.file !== 'services/lifecycle.ts' && !match.marked)
      .map((match) => `${match.file}:${match.line}`)
    expect(unmarked, '非内核直写没有写明意图标记').toEqual([])
  })

  test('内核自己的直写都带标记（回归守卫）', () => {
    const kernel = matches.filter((match) => match.file === 'services/lifecycle.ts')
    expect(kernel.length).toBe(KERNEL_DIRECT_WRITES)
    expect(kernel.every((match) => match.marked)).toBe(true)
  })
})

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(listTsFiles(BACKEND_SRC).length).toBeGreaterThanOrEqual(300)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的违规喂给**本文件自己的 matcher**。
//
// 语料下限（上一条）挡的是「扫了个寂寞」；这一条挡的是另一半：语料还在，但正则
// 已经不咬了。生产代码换个写法（`.set({\n status:` 换行、`update( nodeRuns )` 多个
// 空格）、或有人「整理」正则时手滑，违规集合同样回到空——与「合规」同形。
// 散文里写「写的时候变异验证过」不是证据，能复跑的 fixture 才是。
describe('RFC-317 T14 —— matcher 自证：伪造的违规必须被抓到', () => {
  test('直写 nodeRuns.status 的三种常见写法都命中', () => {
    for (const fabricated of [
      'await db.update(nodeRuns).set({ status: "done" }).where(eq(nodeRuns.id, id))',
      'await db.update( nodeRuns ).set({\n  status: nextStatus,\n})',
      'tx.update(nodeRuns).set({ startedAt: now, status: "running" })',
    ]) {
      expect(
        PATTERN_HAS_UPDATE_NODE_RUNS.test(fabricated) && PATTERN_HAS_SET_STATUS.test(fabricated),
        `这段伪造的直写没被抓到：${fabricated}`,
      ).toBe(true)
    }
  })

  test('不碰 status 的 nodeRuns 更新不算违规（规则不能宽到把合法写法也报了）', () => {
    const legitimate = 'await db.update(nodeRuns).set({ finishedAt: now }).where(cond)'
    expect(PATTERN_HAS_UPDATE_NODE_RUNS.test(legitimate)).toBe(true)
    expect(PATTERN_HAS_SET_STATUS.test(legitimate)).toBe(false)
  })

  test('注释掉的直写不算违规（否则规则没法在它适用的地方被解释）', () => {
    expect(isCommentLine('  // await db.update(nodeRuns).set({ status: "done" })')).toBe(true)
    expect(isCommentLine('  * 历史写法：db.update(nodeRuns).set({ status })')).toBe(true)
    expect(isCommentLine('  await db.update(nodeRuns).set({ status: "done" })')).toBe(false)
  })
})
