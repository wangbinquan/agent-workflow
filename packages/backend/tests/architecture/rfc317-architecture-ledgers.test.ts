// RFC-317 B0 — 三份机器账本的闭合守卫。
//
// 这一批只落账本与闭合断言，**不落 R1/R2 的边相等断言**（那是 B3，连同它的
// 正反 fixture 一起落）。即便如此，本文件已经关掉一个真实的洞：
// `architecture/guard-manifest.json` 与磁盘上的守卫文件**两向钉死**——今天删掉
// 或改名任何一个架构守卫，`git rm` 是一个比它所防的违规更小、更绿的 diff，
// 没有任何测试会红（findings.md CC-07）。加上这条之后，删守卫必须显式改账本。
//
// 三条自检纪律（`docs/dev-gotchas.md`）：
//   ① 枚举用 readdirSync 递归/直读，不用 `git ls-files`——后者看不见未跟踪的
//      新文件，会让本批新增文件整批假绿（RFC-311 T19 事故）；
//   ② 每个扫描都断言语料非空，扫到 0 个必须红，而不是安静通过；
//   ③ 断言用精确相等（toEqual / toBe），不用 `>=` / `<=`——`<=` 型棘轮会留下
//      可复用的松弛槽位（findings.md G-04 实测今天就有 3 个免费槽位）。

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { guardTestFiles } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

interface CommonsKernel {
  readonly id: string
  readonly title: string
  readonly owner: string
  readonly layer: string
  readonly core: boolean
  readonly files: readonly string[]
  readonly singleSourceOf: string
  readonly claimAudit: string
  readonly auditedBy: string
  readonly guards: readonly string[]
}

interface DebtEntry {
  readonly rule: string
  readonly from: string
  readonly to: string
  readonly specifier: string
  readonly edgeKind: 'type' | 'value'
  readonly syntax: string
  readonly owner: string
  readonly why: string
  readonly removeAfterWave: string
  readonly findingId: string
}

interface RegisteredFinding {
  readonly findingId: string
  readonly title: string
  readonly why: string
  readonly removeWhen: string
}

interface GuardEntry {
  readonly id: string
  readonly file: string
  readonly runner: 'bun' | 'vitest'
  readonly mechanism: 'ast' | 'behaviour' | 'source-text'
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), 'utf8')) as T
}

const commons = readJson<{ kernels: CommonsKernel[] }>('architecture/commons-manifest.json')
const debt = readJson<{
  baseline: { inboundEdges: number; outboundEdges: number; registeredFindings: number }
  entries: DebtEntry[]
  registeredFindings: RegisteredFinding[]
}>('architecture/commons-debt.json')
const guardManifest = readJson<{ guards: GuardEntry[] }>('architecture/guard-manifest.json')

const FINDINGS_PATH = 'design/RFC-317-commons-boundary-hardening/findings.md'

describe('RFC-317 — 公共内核清单（architecture/commons-manifest.json）', () => {
  test('语料非空：清单本身不能扫成空', () => {
    expect(commons.kernels.length).toBeGreaterThan(50)
  })

  test('每个内核声明的文件都真实存在（清单↔源码闭合的一半）', () => {
    const missing = commons.kernels
      .flatMap((kernel) => kernel.files.map((file) => ({ id: kernel.id, file })))
      .filter(({ file }) => !existsSync(resolve(REPO_ROOT, file)))
      .map(({ id, file }) => `${id}: ${file}`)
    expect(missing, '清单指向了不存在的文件——要么文件被删/改名，要么清单没跟上').toEqual([])
  })

  test('id 唯一，owner / layer / singleSourceOf 均非空', () => {
    const ids = commons.kernels.map((kernel) => kernel.id)
    expect([...new Set(ids)].sort()).toEqual([...ids].sort())
    const incomplete = commons.kernels
      .filter(
        (kernel) =>
          kernel.owner.trim() === '' ||
          kernel.layer.trim() === '' ||
          kernel.owner === 'unassigned' ||
          kernel.singleSourceOf.trim() === '',
      )
      .map((kernel) => kernel.id)
    expect(incomplete, '公共内核不允许存在「owner 待定」桶（RFC-294 AC-2）').toEqual([])
  })

  test('core 内核非空——D4 的字面量预算归零面必须真实存在', () => {
    expect(commons.kernels.filter((kernel) => kernel.core).length).toBeGreaterThan(20)
  })
})

describe('RFC-317 — 精确债务账本（architecture/commons-debt.json）', () => {
  test('baseline 计数与数组长度一致（账本自身不能撒谎）', () => {
    const inbound = debt.entries.filter((entry) => entry.rule === 'R1-inbound-module-internals')
    const outbound = debt.entries.filter((entry) => entry.rule === 'R2-outbound-module-to-legacy')
    expect(inbound.length).toBe(debt.baseline.inboundEdges)
    expect(outbound.length).toBe(debt.baseline.outboundEdges)
    expect(debt.registeredFindings.length).toBe(debt.baseline.registeredFindings)
    expect(inbound.length + outbound.length).toBe(debt.entries.length)
  })

  test('每条债务的起点文件存在，且 why / removeAfterWave 非空且点名具体波次', () => {
    const bad = debt.entries
      .filter(
        (entry) =>
          !existsSync(resolve(REPO_ROOT, entry.from)) ||
          entry.why.trim() === '' ||
          entry.removeAfterWave.trim() === '' ||
          !/RFC-\d{3}|W\d/.test(entry.removeAfterWave),
      )
      .map((entry) => `${entry.rule} ${entry.from} -> ${entry.to}`)
    expect(bad, 'removeAfterWave 必须点名具体波次 / RFC 号，不接受「以后再说」').toEqual([])
  })

  // 债务身份 = rule + from + specifier + edgeKind + syntax（RFC-294 W0-R 的 exact
  // exception schema 把 edgeKind 算进身份）。同一文件对同一目标既有 value 边又有
  // type 边是**两条**债：前者是运行时依赖，后者只泄漏形状，清偿波次可以不同。
  test('债务条目不重复', () => {
    const keys = debt.entries.map(
      (entry) => `${entry.rule}|${entry.from}|${entry.specifier}|${entry.edgeKind}|${entry.syntax}`,
    )
    expect(keys.length - new Set(keys).size).toBe(0)
  })

  test('P3 登记面与 findings.md 的 gid 两向钉死', () => {
    const findings = readFileSync(resolve(REPO_ROOT, FINDINGS_PATH), 'utf8')
    const p3InDoc = [...findings.matchAll(/^### ([A-Z]+-\d+) · P3 ·/gm)].map((match) => match[1]!)
    expect(
      p3InDoc.length,
      '扫到 0 条 P3 说明 findings.md 的标题格式变了，本断言已失效',
    ).toBeGreaterThan(0)
    const p3InLedger = debt.registeredFindings.map((finding) => finding.findingId)
    expect(p3InLedger.sort(), '账本里的 P3 与 findings.md 不一致：漏登记或已修未销账').toEqual(
      p3InDoc.sort(),
    )
  })

  test('每条 P3 登记都带 why 与 removeWhen', () => {
    const bad = debt.registeredFindings
      .filter((finding) => finding.why.trim() === '' || finding.removeWhen.trim() === '')
      .map((finding) => finding.findingId)
    expect(bad).toEqual([])
  })
})

describe('RFC-317 — 守卫清单（architecture/guard-manifest.json）两向钉死', () => {
  const onDisk = guardTestFiles(REPO_ROOT)

  test('语料非空：磁盘上确实扫得到守卫文件', () => {
    expect(onDisk.length).toBeGreaterThan(80)
  })

  test('清单与磁盘逐条相等——删守卫 / 改守卫名 / 加守卫不登记，三种都红', () => {
    const listed = guardManifest.guards.map((guard) => guard.file).sort()
    expect(
      listed,
      '守卫被删或改名时这里会红：请显式改 architecture/guard-manifest.json 并写清处置（改指向更强断言 / 整删 / 登记豁免，见 docs/dev-gotchas.md）',
    ).toEqual(onDisk)
  })

  test('清单里的守卫文件都存在，id 唯一', () => {
    const missing = guardManifest.guards
      .map((guard) => guard.file)
      .filter((file) => !existsSync(resolve(REPO_ROOT, file)))
    expect(missing).toEqual([])
    const ids = guardManifest.guards.map((guard) => guard.id)
    expect([...new Set(ids)].sort()).toEqual([...ids].sort())
  })
})
