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
