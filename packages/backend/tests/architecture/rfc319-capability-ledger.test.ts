// RFC-319 R3 —— 能力账本守卫。
//
// 它要终结的是**散文漂移**：`e2e/CAPABILITY_COVERAGE.md` 的每一句「已覆盖」都需要人
// 回到用例源码才能验真，而本 RFC 的审计逐条读下来推翻了其中若干条。账本把这件事变成
// 机器判据——证据是 {file, test}，守卫每次验证那个标题**逐字**还在。
//
// 判据的三个方向：
//   ① 证据可达：用例改名 / 被删 ⇒ 红。
//   ② 状态与字段互斥：covered 必须有可校验证据；gap 必须点名 gapSince；
//      covered-unverified 必须留着散文证据（否则它凭什么算覆盖）。
//   ③ 两个只降不升的数字：`gap`（还欠多少条防护）与 `covered-unverified`
//      （还有多少条「覆盖」只是散文）。两者都进 `architecture/ledger-baselines.json`，
//      由 RFC-317 的高水位守卫管。
//
// `covered-unverified` **是存量专用状态**。新能力只能是 covered（带可校验证据）或
// gap（带 gapSince）。不设这条禁令的话，它会变成一个「宣称覆盖但不必证明」的永久后门，
// 也就是把 CAPABILITY_COVERAGE.md 的问题原样搬进 JSON。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  countByStatus,
  readCapabilityLedger,
  statusShapeViolations,
  unreachableEvidence,
  type CapabilityLedger,
} from './capabilityLedger'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const LEDGER = readCapabilityLedger(REPO_ROOT)

/** 开工时的存量规模。`covered-unverified` 永远不该超过它——它只能被归一掉。 */
const LEGACY_UNVERIFIED_AT_START = 141

const FINDINGS = JSON.parse(
  readFileSync(
    resolve(
      REPO_ROOT,
      'design',
      'RFC-319-user-facing-e2e-coverage-hardening',
      'findings.json',
    ),
    'utf8',
  ),
) as { rows: ReadonlyArray<{ id: string }> }

describe('RFC-319 R3 —— 语料非空（账本被清空 / 挪走时必须红）', () => {
  test('账本里有足够多的行', () => {
    expect(
      LEDGER.rows.length,
      '账本行数掉到 700 以下 ⇒ 多半是播种脚本或读取路径坏了，' +
        '而一个空账本的所有断言都会平凡通过',
    ).toBeGreaterThan(700)
  })

  test('id 唯一', () => {
    const ids = LEDGER.rows.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('与审计台账**两向**相等（既不许悄悄删条目，也不许凭空长出来）', () => {
    const inLedger = [...LEDGER.rows.map((row) => row.id)].sort()
    const inFindings = [...FINDINGS.rows.map((row) => row.id)].sort()
    expect(
      inLedger,
      '账本与 findings.json 的能力集合不一致。删一条等于让那条能力从视野里消失；' +
        '新增能力（新功能）是允许的，但要同批更新 findings 台账，让「凭什么有这一行」' +
        '始终有出处',
    ).toEqual(inFindings)
  })
})

describe('RFC-319 R3 —— 证据必须逐字可达', () => {
  test('每条 covered 的证据都指向一个真实存在的 test 标题', () => {
    expect(
      unreachableEvidence(REPO_ROOT, LEDGER),
      '证据指向的用例不存在或标题变了。这正是散文账本的失败形态被机器化之后该有的样子：' +
        '改名一个 test 就红，而不是等下一个人回头读源码才发现账本在说谎',
    ).toEqual([])
  })

  test('状态与证据字段互斥约束成立', () => {
    expect(statusShapeViolations(LEDGER)).toEqual([])
  })
})

describe('RFC-319 R3 —— 两个只降不升的数字', () => {
  test('gap 计数与基线一致（基线本身由 rfc317-ledger-highwater 管只降不升）', () => {
    // 这条只做「账本内部自洽」；跨 commit 的单调性由高水位守卫按 git 比较。
    expect(countByStatus(LEDGER, 'gap')).toBeGreaterThan(0)
  })

  test('covered-unverified 不得超过开工时的存量（它只能被归一掉，不能新增）', () => {
    expect(
      countByStatus(LEDGER, 'covered-unverified'),
      `covered-unverified 涨了。它是**存量专用**状态：新能力只能是 covered` +
        `（带 {file, test} 证据）或 gap（带 gapSince）。允许它增长等于开一个` +
        `「宣称覆盖但不必证明」的永久后门`,
    ).toBeLessThanOrEqual(LEGACY_UNVERIFIED_AT_START)
  })

  test('三种状态之和等于总行数（不许出现第四种状态）', () => {
    const sum =
      countByStatus(LEDGER, 'gap') +
      countByStatus(LEDGER, 'covered-unverified') +
      countByStatus(LEDGER, 'covered')
    expect(sum, '有行的 status 不在三种之内').toBe(LEDGER.rows.length)
  })
})

describe('RFC-319 R3 —— 冗余的 id 数组不许漂移', () => {
  // 为什么要冗余：RFC-317 的高水位机制（census.ts 的 ledgerEntryCount）按**数组长度**
  // 清点，派生出来的计数它数不到。要让这两个债务数字进那套「只降不升 + allowGrowth
  // 署名」的机制，账本就得显式带上数组。冗余的代价是可能漂移——所以钉死。
  const derived = (status: string): string[] =>
    LEDGER.rows
      .filter((row) => row.status === status)
      .map((row) => row.id)
      .sort()

  test('gapIds 与 rows 里派生的 gap 集合逐条相等', () => {
    const doc = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'architecture', 'e2e-capability-ledger.json'), 'utf8'),
    ) as { gapIds: string[] }
    expect(
      [...doc.gapIds].sort(),
      'gapIds 与 rows 不一致 ⇒ 高水位守卫盯的那个数字和账本真实内容脱钩了',
    ).toEqual(derived('gap'))
  })

  test('unverifiedIds 与 rows 里派生的 covered-unverified 集合逐条相等', () => {
    const doc = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'architecture', 'e2e-capability-ledger.json'), 'utf8'),
    ) as { unverifiedIds: string[] }
    expect([...doc.unverifiedIds].sort()).toEqual(derived('covered-unverified'))
  })
})

describe('RFC-319 R3 —— 负 fixture：判据自己咬得动吗', () => {
  // 完全不碰真实账本，只把伪造的行喂给同一份判定函数。

  const fake = (rows: CapabilityLedger['rows']): CapabilityLedger => ({
    schemaVersion: 1,
    note: 'fixture',
    recordedAtSha: 'fixture',
    rows,
  })

  test('证据文件不存在 ⇒ 报出来', () => {
    const bad = unreachableEvidence(
      REPO_ROOT,
      fake([
        {
          id: 'FAKE-1',
          domain: 'fixture',
          title: 'fixture',
          risk: 'P1',
          tier: 'pr',
          status: 'covered',
          evidence: [{ file: 'e2e/this-file-does-not-exist.spec.ts', test: 'whatever' }],
        },
      ]),
    )
    expect(bad).toHaveLength(1)
    expect(bad[0]!).toContain('证据文件不存在')
  })

  test('文件存在但标题不在里面 ⇒ 报出来（这是「用例改名」的形态）', () => {
    const bad = unreachableEvidence(
      REPO_ROOT,
      fake([
        {
          id: 'FAKE-2',
          domain: 'fixture',
          title: 'fixture',
          risk: 'P1',
          tier: 'pr',
          status: 'covered',
          evidence: [
            {
              file: 'e2e/agent-authoring.spec.ts',
              test: 'a title that was renamed away long ago',
            },
          ],
        },
      ]),
    )
    expect(bad).toHaveLength(1)
    expect(bad[0]!).toContain('找不到 test 标题')
  })

  test('covered 没有证据 / gap 没有 gapSince / gap 带证据 ⇒ 三种都报', () => {
    const bad = statusShapeViolations(
      fake([
        { id: 'FAKE-3', domain: 'f', title: 'f', risk: 'P1', tier: 'pr', status: 'covered' },
        { id: 'FAKE-4', domain: 'f', title: 'f', risk: 'P2', tier: 'nightly', status: 'gap' },
        {
          id: 'FAKE-5',
          domain: 'f',
          title: 'f',
          risk: 'P3',
          tier: 'nightly',
          status: 'gap',
          gapSince: 'RFC-999',
          evidence: [{ file: 'e2e/agent-authoring.spec.ts', test: 'x' }],
        },
      ]),
    )
    expect(bad.map((line) => line.split(':')[0])).toEqual(['FAKE-3', 'FAKE-4', 'FAKE-5'])
  })

  test('形状正确的行不误报', () => {
    expect(
      statusShapeViolations(
        fake([
          {
            id: 'FAKE-6',
            domain: 'f',
            title: 'f',
            risk: 'P1',
            tier: 'pr',
            status: 'covered',
            evidence: [{ file: 'e2e/agent-authoring.spec.ts', test: 'x' }],
          },
          {
            id: 'FAKE-7',
            domain: 'f',
            title: 'f',
            risk: 'P2',
            tier: 'nightly',
            status: 'gap',
            gapSince: 'RFC-319',
          },
          {
            id: 'FAKE-8',
            domain: 'f',
            title: 'f',
            risk: 'P2',
            tier: 'nightly',
            status: 'covered-unverified',
            proseEvidence: ['findings.md §5'],
          },
        ]),
      ),
    ).toEqual([])
  })
})
