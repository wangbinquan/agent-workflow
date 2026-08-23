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
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { GUARD_FILE_NAME_PATTERN, guardTestFiles } from './census'

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

const commons = readJson<{ kernels: CommonsKernel[]; recordedAtSha?: string }>(
  'architecture/commons-manifest.json',
)
const debt = readJson<{
  baseline: {
    inboundEdges: number
    outboundEdges: number
    registeredFindings: number
    recordedAtSha?: string
  }
  entries: DebtEntry[]
  registeredFindings: RegisteredFinding[]
}>('architecture/commons-debt.json')
const guardManifest = readJson<{ guards: GuardEntry[]; recordedAtSha?: string }>(
  'architecture/guard-manifest.json',
)

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

/**
 * 账本自称的采数 SHA 必须是**这条历史上真实存在**的提交。
 *
 * 起因（2026-08-23 实撞）：三份账本最初记的是 `efc1bdb01`——rebase **前**的本地
 * 提交。它经 rebase 以 `b04cf0eb0` 发布到 origin，`efc1bdb01` 本身从未进远端，于是
 * 账本指着一个**任何人都 checkout 不出来**的 SHA：想复算的人第一步就卡住，而所有
 * 测试全绿。这正是本 RFC 要消灭的「陈述与历史不符」。
 *
 * 浅克隆里做不了对象判定，此时**显式报告跳过原因**而不是静默通过——「skip 即绿」
 * 是守卫失效的另一种形态。
 */
describe('RFC-317 — 账本的采数 SHA 必须可复算', () => {
  const git = (...args: string[]): { ok: boolean; out: string } => {
    const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
    return { ok: result.status === 0, out: (result.stdout ?? '').trim() }
  }
  const shallow = git('rev-parse', '--is-shallow-repository').out === 'true'
  const shas = [
    commons.recordedAtSha,
    guardManifest.recordedAtSha,
    debt.baseline.recordedAtSha,
  ].filter((sha): sha is string => typeof sha === 'string' && sha.length > 0)

  test('三份账本都记了采数 SHA', () => {
    expect(shas.length).toBe(3)
  })

  test('每个采数 SHA 都在当前历史上可达（不是「本地对象还在」而已）', () => {
    if (shallow) {
      expect(shallow, '浅克隆下判不了祖先关系——本条此刻已跳过，不是通过').toBe(true)
      return
    }
    // 判**祖先**而不是 `cat-file -e`：rebase 前的本地提交在自己机器上仍是可达对象，
    // `cat-file -e` 照样成功，于是「记了个远端没有的 SHA」这条恰好逃掉（写这条守卫
    // 时用它做变异，0 红，当场打脸）。要证的是「别人 checkout 本仓到 HEAD 之后，
    // 能不能走到那个提交」——那才是「可复算」的实际含义。
    const unreachable = shas.filter((sha) => !git('merge-base', '--is-ancestor', sha, 'HEAD').ok)
    expect(
      unreachable,
      '账本记了当前历史走不到的 SHA（典型成因：记了 rebase 前的本地提交），想复算的人第一步就卡住',
    ).toEqual([])
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

// RFC-317 T14 —— 负 fixture：把伪造的文件名喂给**枚举守卫用的同一份判据**。
//
// 上面所有「清单与磁盘两向相等」的断言，都建立在 `GUARD_FILE_NAME_PATTERN` 认得出
// 「哪些测试文件是守卫」之上。这个正则一旦被收窄，守卫会安静地从枚举里掉出去：
// 磁盘侧与清单侧**同时**少一条，两向相等依然成立——这正是 CC-07「守卫可被静默
// 删除」的升级版，连删都不用删，改个名或收一下正则就够了。
describe('RFC-317 T14 —— matcher 自证：守卫文件名判据的边界', () => {
  test('六类命名都被认作守卫（少认一类 = 那一类守卫可以静默脱管）', () => {
    for (const name of [
      'rfc294-architecture-preflight.test.ts',
      'rfc281-boundary.integration.test.ts',
      'rfc284-spawn-site-ratchet.test.ts',
      'rfc305-architecture-lock.test.ts',
      'lifecycle-grep-guard.test.ts',
      'scheduler-invariants.test.ts',
    ]) {
      expect(GUARD_FILE_NAME_PATTERN.test(name), `没认出守卫：${name}`).toBe(true)
    }
  })

  test('普通行为测试不被误认（否则清单会被灌进几百个无关文件而失去意义）', () => {
    for (const name of [
      'rfc310-digital-employee-authoring.test.ts',
      'task-archive.test.ts',
      'clarify-dispatch.test.ts',
    ]) {
      expect(GUARD_FILE_NAME_PATTERN.test(name), `误认成守卫：${name}`).toBe(false)
    }
  })
})
