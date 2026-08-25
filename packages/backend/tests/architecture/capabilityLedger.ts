// RFC-319 R3 —— 能力账本的读取与判定（守卫与播种脚本共用）。
//
// 这份账本要解决的问题是**散文会漂移**。`e2e/CAPABILITY_COVERAGE.md` 写得很好，
// 但它的每一句「已覆盖」都需要人回到用例源码才能验证真伪——本 RFC 的审计就推翻了
// 其中若干条。账本把「哪条能力被哪条用例守着」变成机器判据：证据必须**逐字可达**，
// 用例改名或被删就红。
//
// 三种状态，对应三种不同的债：
//
//   `gap`               —— 没有 e2e 防护。**只减不增**（进 ledger-baselines 高水位）。
//   `covered-unverified` —— 审计判定它有 e2e 防护，但证据仍是**散文**（`path:line` +
//                          说明），没有归一成可校验的 {file, test}。这是本 RFC 开工时
//                          141 条既有覆盖的形态。它同样**只减不增**——每归一一条就少
//                          一条。**新增的行不许用这个状态**（见守卫）：它是存量专用的。
//   `covered`           —— 证据是 {file, test}，且守卫每次都验证那个 test 标题今天
//                          确实存在于那个文件里。
//
// 为什么把「散文证据」单独立一档而不是直接信它：直接信等于把 CAPABILITY_COVERAGE.md
// 的问题搬进 JSON——格式变了，判据强度没变。单独立一档才能让「把散文变成判据」这件事
// 本身有一个会下降的数字。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type CapabilityStatus = 'gap' | 'covered-unverified' | 'covered'

/** 可校验证据：某个文件里某个逐字存在的 test 标题。 */
export interface CapabilityEvidence {
  readonly file: string
  readonly test: string
}

export interface CapabilityRow {
  readonly id: string
  readonly domain: string
  readonly title: string
  readonly risk: 'P1' | 'P2' | 'P3'
  /** PR 档进 PR 腿，nightly 档只在 e2e-full-nightly 跑。 */
  readonly tier: 'pr' | 'nightly'
  readonly status: CapabilityStatus
  /** status='covered' 时必填且必须逐字可达；其它状态必须为空。 */
  readonly evidence?: readonly CapabilityEvidence[]
  /** status='covered-unverified' 时保留审计给出的散文证据，供归一时定位。 */
  readonly proseEvidence?: readonly string[]
  /** status='gap' 时点名谁欠着（RFC 号）。不允许匿名欠账。 */
  readonly gapSince?: string
}

export interface CapabilityLedger {
  readonly schemaVersion: number
  readonly note: string
  readonly recordedAtSha: string
  readonly rows: readonly CapabilityRow[]
}

export function readCapabilityLedger(repoRoot: string): CapabilityLedger {
  const path = resolve(repoRoot, 'architecture', 'e2e-capability-ledger.json')
  return JSON.parse(readFileSync(path, 'utf8')) as CapabilityLedger
}

export function countByStatus(ledger: CapabilityLedger, status: CapabilityStatus): number {
  return ledger.rows.filter((row) => row.status === status).length
}

/**
 * 证据不可达的条目：文件读不到，或者那个 test 标题不在文件里。
 *
 * 判据用**逐字包含**而不是解析 AST：test 标题是字符串字面量，改一个字就该红；
 * 而 AST 解析会把 `test.each` / 模板拼接的标题也算进来，反而放松了判据。
 */
export function unreachableEvidence(repoRoot: string, ledger: CapabilityLedger): string[] {
  const cache = new Map<string, string | null>()
  const read = (rel: string): string | null => {
    if (!cache.has(rel)) {
      try {
        cache.set(rel, readFileSync(resolve(repoRoot, rel), 'utf8'))
      } catch {
        cache.set(rel, null)
      }
    }
    return cache.get(rel) ?? null
  }
  const bad: string[] = []
  for (const row of ledger.rows) {
    for (const ev of row.evidence ?? []) {
      const src = read(ev.file)
      if (src === null) {
        bad.push(`${row.id}: 证据文件不存在 — ${ev.file}`)
        continue
      }
      if (!src.includes(ev.test)) {
        bad.push(`${row.id}: ${ev.file} 里找不到 test 标题「${ev.test}」`)
      }
    }
  }
  return bad
}

/**
 * RFC-319 B73 —— `tier` 必须**描述事实**，不是描述建议。
 *
 * 这个字段的语义是「PR 档进 PR 腿，nightly 档只在 e2e-full-nightly 跑」，而 CI 分档
 * 的唯一开关是 Playwright 的 `--grep-invert '@nightly'`（见 rfc319-ci-topology 守卫）
 * ——也就是说，**一条用例跑在哪条腿，完全由它的标题里有没有 `@nightly` 决定**，与账本
 * 里写什么无关。
 *
 * 2026-08-25 实测：243 条证据写着 `tier: nightly`，而它们的用例根本没打标签、每次 PR
 * 都在跑。这个字段自落档起就在无声地说谎——它记的是审计当初的**建议档位**，从来没有
 * 人把它和实际接线对齐过，也没有任何守卫会因此变红。于是「PR 门到底在跑什么」这件事，
 * 账本给不出答案，读的人还以为给得出。
 *
 * 判据因此只对 `covered` 行成立（只有它们有可执行证据可对账）：
 * 全部证据都带 `@nightly` ⇔ `tier: 'nightly'`。`gap` / `covered-unverified` 行没有
 * 用例可查，它们的 tier 保持审计的建议值不动。
 *
 * 注意这里**不判断档位分得对不对**——那是 CI 维护者按实测墙钟做的取舍（他们 2026-08-25
 * 选的是扩分片而不是把用例推去夜跑）。这条守卫只保证账本说的和实际接的是同一件事。
 */
export function tierWiringMismatches(ledger: CapabilityLedger): string[] {
  const NIGHTLY_TAG = '@nightly'
  const bad: string[] = []
  for (const row of ledger.rows) {
    if (row.status !== 'covered') continue
    const evidence = row.evidence ?? []
    if (evidence.length === 0) continue
    const tagged = evidence.filter((ev) => ev.test.includes(NIGHTLY_TAG)).length
    if (tagged !== 0 && tagged !== evidence.length) {
      bad.push(
        `${row.id}: ${evidence.length} 条证据里只有 ${tagged} 条带 ${NIGHTLY_TAG} —— ` +
          '同一条能力被劈在两条腿上，这一行的 tier 无论填什么都是错的',
      )
      continue
    }
    const wired = tagged === evidence.length ? 'nightly' : 'pr'
    if (row.tier !== wired) {
      bad.push(
        `${row.id}: 账本写 tier=${row.tier}，而它的用例实际跑在 ${wired} 腿` +
          `（标题里${wired === 'nightly' ? '带' : '没有'} ${NIGHTLY_TAG}）`,
      )
    }
  }
  return bad
}

/** 状态与证据字段的互斥约束被破坏的条目。 */
export function statusShapeViolations(ledger: CapabilityLedger): string[] {
  const bad: string[] = []
  for (const row of ledger.rows) {
    const hasEvidence = (row.evidence ?? []).length > 0
    const hasProse = (row.proseEvidence ?? []).length > 0
    if (row.status === 'covered' && !hasEvidence) {
      bad.push(`${row.id}: status=covered 但没有可校验证据`)
    }
    if (row.status !== 'covered' && hasEvidence) {
      bad.push(`${row.id}: status=${row.status} 却带着可校验证据——应改成 covered`)
    }
    if (row.status === 'gap' && (row.gapSince ?? '') === '') {
      bad.push(`${row.id}: status=gap 却没写 gapSince（不允许匿名欠账）`)
    }
    if (row.status === 'gap' && hasProse) {
      bad.push(`${row.id}: status=gap 却带着 proseEvidence`)
    }
    if (row.status === 'covered-unverified' && !hasProse) {
      bad.push(`${row.id}: status=covered-unverified 却没有散文证据——那它凭什么算覆盖`)
    }
  }
  return bad
}
