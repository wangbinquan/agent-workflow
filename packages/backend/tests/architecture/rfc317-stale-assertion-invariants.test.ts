// RFC-317 T66（AC-13）—— 让「过期断言」这一类 bug 不能再靠人肉普查发现。
//
// 本 RFC 的 findings 里有 19 条 `stale-assertion`：注释 / 文档 / 账本说的事情
// 在源码里已经不成立。它们逐条被改对了，但**改对本身留不下任何防线**——同一句
// 话明天再腐化一次，仍然没有一格会红。这个文件把其中**可以从源码派生**的那几类
// 立成不变量：判据的一端永远是活的源码（枚举长度 / 真实 import / 真实 schema 列），
// 另一端是散文，两端不一致就红。
//
// 为什么不做成「禁用词表」：过期断言的本质不是用了某个词，而是**散文与源码脱钩**。
// 词表只能挡住已经出现过的那几句，而这正是 RFC-286 F1 的教训（点名三个 class、
// 同类 bug 在别处继续存在）。
//
// ⚠️ 本文件自身的一条纪律：**引用历史措辞必须放进引号**（「…」或 "…"）。
// 下面所有扫描都会先剥掉引号内的文本，否则「订正说明里复述旧句子」会踩到自己的
// 规则——写 RFC-317 B1-a 的 T6 时已经被同类问题咬过一次（正向锁被一句注释满足）。
//
// 变异实证（见 plan.md B11 实施记录）：每条规则都把派生的那一端改一下，
// 对应用例当场变红；字节级还原后复绿。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { ACL_RESOURCE_TYPES } from '@agent-workflow/shared'
import { packageSrcUnits, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')

const CORPUS: SourceUnit[] = [
  ...packageSrcUnits(REPO_ROOT, 'backend'),
  ...packageSrcUnits(REPO_ROOT, 'shared'),
]

/** 规则③（施工期注释）与包无关，前端同样会留下分期说明，语料取全仓生产源码。 */
const CORPUS_ALL: SourceUnit[] = [...CORPUS, ...packageSrcUnits(REPO_ROOT, 'frontend')]

/**
 * 一个文件里的全部注释文本（**已剥掉引号内的历史措辞**）。
 *
 * 用 TS scanner 而不是正则：`docs/dev-gotchas.md` 记着 RFC-317 B1-a 的实撞——
 * 非贪婪块注释正则会从字符串字面量里的 `/*` 一路吃到下一个 `*` + `/`，
 * 吞掉几百行真代码。scanner 认的是词法，对字符串天然免疫。
 */
function commentText(unit: SourceUnit): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard)
  scanner.setText(unit.text)
  const parts: string[] = []
  let token = scanner.scan()
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      parts.push(scanner.getTokenText())
    }
    token = scanner.scan()
  }
  return stripQuoted(parts.join('\n'))
}

/**
 * 一个文件里的注释**按块**切分（连续的注释 token 之间只隔空白 ⇒ 同一块），
 * 每块已剥引号。
 *
 * 为什么要按块：判「这句将来时属于哪个 RFC」时，整文件粒度会把文件里提到的
 * **任何**一个已 Done 的 RFC 都算进来——实测 `outputKinds/path.ts` 因此被
 * 一句与它无关的 RFC 号带红，而把该 RFC 的状态改成 In Progress 也不能让它变绿，
 * 也就是说派生端根本没起作用（变异自证当场暴露了这一点）。归属必须是局部的。
 */
function commentBlocks(unit: SourceUnit): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard)
  scanner.setText(unit.text)
  const blocks: string[] = []
  let current: string[] = []
  let previousEnd = -1
  let token = scanner.scan()
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    const isComment =
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    if (isComment) {
      const start = scanner.getTokenStart()
      // 与上一条注释之间只有空白 ⇒ 同一块；中间夹了真代码就断块。
      const gap = previousEnd < 0 ? '' : unit.text.slice(previousEnd, start)
      if (current.length > 0 && gap.trim() !== '') {
        blocks.push(current.join('\n'))
        current = []
      }
      current.push(scanner.getTokenText())
      previousEnd = scanner.getTokenEnd()
    } else if (token !== ts.SyntaxKind.NewLineTrivia && token !== ts.SyntaxKind.WhitespaceTrivia) {
      if (current.length > 0) {
        blocks.push(current.join('\n'))
        current = []
      }
      previousEnd = scanner.getTokenEnd()
    }
    token = scanner.scan()
  }
  if (current.length > 0) blocks.push(current.join('\n'))
  return blocks.map(stripQuoted)
}

/** 剥掉 「…」 / “…” / "…" 内的文本——那是**引用**，不是断言。 */
function stripQuoted(text: string): string {
  return text
    .replaceAll(/「[^」]*」/gu, '「」')
    .replaceAll(/“[^”]*”/gu, '“”')
    .replaceAll(/"[^"\n]*"/gu, '""')
}

const EN_NUMBERS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
}

const ZH_NUMBERS: Readonly<Record<string, number>> = {
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
  十三: 13,
  十四: 14,
}

interface CountClaim {
  readonly path: string
  readonly claimed: number
  readonly phrase: string
}

function countClaims(unit: SourceUnit, patterns: readonly RegExp[]): CountClaim[] {
  const text = commentText(unit)
  const out: CountClaim[] = []
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      const word = (m[1] ?? '').toLowerCase()
      const claimed = EN_NUMBERS[word] ?? ZH_NUMBERS[m[1] ?? '']
      if (claimed === undefined) continue
      out.push({ path: unit.path, claimed, phrase: m[0].replaceAll(/\s+/g, ' ').trim() })
    }
  }
  return out
}

describe('RFC-317 T66 —— 过期断言不变量（散文与源码脱钩即红）', () => {
  test('⓪ 语料下限——扫描器还活着', () => {
    // 全部规则都是「扫一遍源码、断言没有 X」的形态，语料一旦为空就会全绿。
    // 实测 929 个文件；钉一个明显低于它、但足以证明枚举没断的下限。
    expect(CORPUS.length, 'backend + shared 的生产源文件枚举断了，下面的缺席断言全部失去意义').toBeGreaterThan(700)
  })

  test('① 注释里**列出成员**的 ACL 花名册必须与 ACL_RESOURCE_TYPES 逐项相等', () => {
    // 派生端：唯一的资源类型花名册。RFC-099 起它涨过两次（RFC-304/309 的能力模板、
    // RFC-310 的五类配置资源 + employee_definition），而三处 header 还停在
    // `Six resource types (agent / skill / mcp / plugin / workflow / workgroup)`
    // ——那正是 findings ACL-14。手抄花名册是最典型的「第二份账本」。
    //
    // 判据刻意只认**写出成员**的形态（`N resource types (a / b / c)`），不认光秃秃的
    // 「六类资源」：初版扫后者，一上来 37 处命中，绝大多数是**别的**花名册
    // （bundle 的六类可打包资源、RFC-310 的五类配置资源）或根本不是花名册
    // （「新增一类 ACL 资源时」）。一条需要三十几条豁免才能变绿的规则，
    // 豁免本身就会变成新的空白许可证——这是本 RFC 反复踩到的同一个坑。
    // 收窄之后它仍然精确覆盖真实事故形态：手抄一份名单并写错长度。
    const roster = new Set<string>(ACL_RESOURCE_TYPES)
    const pattern =
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\s+resource\s+types?\s*\(([^)]{0,400})\)/gi

    const offenders: string[] = []
    for (const unit of CORPUS) {
      for (const m of commentText(unit).matchAll(pattern)) {
        const claimed = EN_NUMBERS[(m[1] ?? '').toLowerCase()]
        const listed = (m[2] ?? '')
          .split('/')
          .map((n) => n.trim())
          .filter((n) => n.length > 0)
        // 只有当列出的成员**确实是 ACL 类型**时才把它当成 ACL 花名册；
        // 别的域也有「N resource types (…)」的写法，本规则不该管它们。
        const aclNames = listed.filter((n) => roster.has(n))
        if (aclNames.length < 3) continue
        const missing = [...roster].filter((n) => !listed.includes(n))
        if (claimed !== ACL_RESOURCE_TYPES.length || missing.length > 0) {
          offenders.push(
            `${unit.path}: 声称 ${String(claimed)} 类、列出 [${listed.join(', ')}]；` +
              `真实花名册 ${ACL_RESOURCE_TYPES.length} 类，缺 [${missing.join(', ')}]`,
          )
        }
      }
    }
    expect(
      offenders,
      '注释里手抄了一份 ACL 资源花名册，与 ACL_RESOURCE_TYPES 不符。' +
        '花名册只能有一份；散文要么别列成员，要么指向那一份。' +
        '（复述历史措辞请放进「」或 "" ——本规则会剥掉引号内的文本。）',
    ).toEqual([])
  })

  test('② 注释里写出的「N 张表有 builtin 列」必须等于 schema 里的真实列数', () => {
    // 派生端：db/schema.ts 里 `builtin` 列的实际张数。RFC-304/309 给
    // capability_templates 加了第三列之后，五处手抄仍说两张（findings ACL-05）。
    const schema = readFileSync(
      resolve(REPO_ROOT, 'packages/backend/src/db/schema.ts'),
      'utf8',
    )
    const actual = [...schema.matchAll(/builtin:\s*integer\('builtin'/g)].length
    expect(actual, 'db/schema.ts 里应当能数到 builtin 列；数不到说明本规则的派生端断了').toBeGreaterThan(0)

    const patterns = [
      /([一两二三四五六七八九十]{1,2})\s*张表[^。\n]{0,40}?builtin/gu,
      /builtin[^。\n]{0,40}?([一两二三四五六七八九十]{1,2})\s*张表/gu,
    ]
    const wrong = CORPUS.flatMap((unit) => countClaims(unit, patterns)).filter(
      (claim) => claim.claimed !== actual,
    )
    expect(
      wrong,
      `注释声称带 builtin 列的表数与 db/schema.ts 实测 ${actual} 不符。` +
        '「哪些表有这一列」与「哪些表真的 seed 了 built-in」是两件事，' +
        '判据是前者——后者要写就写清楚是 seed。',
    ).toEqual([])
  })

  test('③ 施工期注释不得留在已完工（索引里 Done）的 RFC 的代码里', () => {
    // findings NK-14 点名了四个文件，写着「PR-A scope / not yet wired / PR-D wires
    // it」——而 scheduler 与 envelope 早就在调它们了。分期说明的失效期，就是它描述
    // 的那个 PR 合并的那一刻；没有人会在合并时回头删注释。
    //
    // 判据刻意**不是**「这四个文件不许出现这几个词」——那正是 RFC-286 F1 的错误
    // （点名三个具体名字，同类 bug 在别处继续存在而守卫看不见）。派生端换成
    // `design/plan.md` 的 RFC 索引：**注释里提到的 RFC 已经 Done，就不该再有将来时**。
    // 换成这个判据后当场多捞出四处 NK-14 没点到的同类（RFC-049/057/083/101），
    // 全部经源码核实属实并已改对。
    const plan = readFileSync(resolve(REPO_ROOT, 'design/plan.md'), 'utf8')
    const rfcStatus = new Map<string, string>()
    for (const line of plan.split('\n')) {
      const id = /^\|\s*\[?(RFC-\d{3})\]?/.exec(line)
      if (id === null) continue
      const cells = line
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0)
      rfcStatus.set(id[1]!, cells[cells.length - 1] ?? '')
    }
    expect(
      rfcStatus.size,
      'design/plan.md 的 RFC 索引一行都没解析出来，本规则的派生端断了',
    ).toBeGreaterThan(100)

    // 将来时短语。只收「这段代码还没接上 / 以后某个 PR 会接上」这一类，
    // 不收单纯的历史陈述（「原本是…」「RFC-XXX 之前…」）。
    const FUTURE_TENSE = [
      /not\s+yet\s+wired/i,
      /not\s+yet\s+called\s+by\s+runtime/i,
      /PR-[A-Z0-9]+\s+(?:wires|removes|fills|narrows)/i,
      /PR-[A-Z]\s+scope/i,
      /不接现有\s*runtime/u,
      /尚未接入/u,
      /待\s*PR-/u,
    ]

    const offenders: string[] = []
    for (const unit of CORPUS_ALL) {
      const blocks = commentBlocks(unit)
      const headerRfcs = [...(blocks[0] ?? '').matchAll(/RFC-(\d{3})/g)].map(
        (match) => `RFC-${match[1]!}`,
      )
      for (const block of blocks) {
        for (const phrase of FUTURE_TENSE) {
          const hit = phrase.exec(block)
          if (hit === null) continue
          // 归属**只看这一块**；块内没写 RFC 号才回落到文件头那块
          // （头注释通常是「RFC-060 PR-A —— …」，而将来时那句不重复 RFC 号）。
          const inBlock = [...new Set([...block.matchAll(/RFC-(\d{3})/g)].map((m) => `RFC-${m[1]!}`))]
          const scope = inBlock.length > 0 ? inBlock : headerRfcs
          const done = scope.filter((rfc) => /^\**Done/.test(rfcStatus.get(rfc) ?? ''))
          if (done.length === 0) continue
          offenders.push(
            `${unit.path}: ${done.join(',')} 已 Done，注释里仍是将来时 ${String(phrase)} —— ` +
              `「${hit[0]}」`,
          )
        }
      }
    }
    expect(
      offenders,
      '已完工 RFC 的施工期注释还留在代码里。读者据此会以为这套机制是死的、' +
        '或以为这张表还是半成品，从而在别处另起一套——比少写一句注释坏得多。' +
        '（复述历史措辞请放进「」或 "" ——本规则会剥掉引号内的文本。）',
    ).toEqual([])
  })

  test('④ 「async helper 进不了同步事务」这个理由不得与同步内核入口共存', () => {
    // 派生端：SQLite lifecycle persistence 是否导出同步事务版内核入口。
    // findings LC-12：三处直写拿这句话当理由，而它写下三天后就有了 setNodeRunStatusTx。
    const lifecycle = CORPUS.find(
      (u) => u.path === 'packages/backend/src/platform/persistence/sqlite/taskLifecycle.ts',
    )
    expect(lifecycle, '派生端文件不存在：SQLite taskLifecycle persistence').toBeDefined()
    const hasSyncEntry = /export function setNodeRunStatusTx/.test(lifecycle!.text)
    if (!hasSyncEntry) return

    const offenders = CORPUS.filter((unit) =>
      /cannot\s+join\s+a\s+sync\s+transaction/i.test(commentText(unit)),
    ).map((unit) => unit.path)
    expect(
      offenders,
      '这些文件仍用「异步生命周期 helper 无法加入同步事务」为直写辩护，' +
        '而同步事务版内核入口 setNodeRunStatusTx 就在 SQLite taskLifecycle persistence 里。' +
        '一个已经失效的技术理由比一条记在账上的债更坏：它让下一个 reviewer 得到「不能」这个答案。',
    ).toEqual([])
  })

  test('⑤ 被安装了 upgradeGate 的 WS 通道，不得同时被描述成「完全没有门」', () => {
    // 派生端：ws/registry.ts 里该通道是否真的挂了 upgradeGate。
    // findings TP-09：同一个文件 174 行说门已关、311 行说没有任何门。
    const registry = CORPUS.find((u) => u.path === 'packages/backend/src/ws/registry.ts')
    expect(registry, '派生端文件不存在：ws/registry.ts').toBeDefined()
    const gated = /'repo-import'[\s\S]{0,4000}?upgradeGate/.test(registry!.text)
    if (!gated) return

    const offenders = CORPUS.filter(
      (unit) =>
        unit.path.startsWith('packages/backend/src/ws/') &&
        /no\s+gate\s+of\s+any\s+kind/i.test(commentText(unit)),
    ).map((unit) => unit.path)
    expect(
      offenders,
      'ws/ 下仍有注释声称 repo-import「没有任何门」，而 ws/registry.ts 明明给它挂了 upgradeGate。' +
        '安全面的过期注释双向有害：要么让人去重复修一个不存在的洞，' +
        '要么在真出事时被当成「已知缺陷」而不再追。',
    ).toEqual([])
  })

  test('⑥ 自称「唯一注册表」的表，必须真的没有表外同类实现', () => {
    // 派生端：backend src 里 `setInterval(` 的站点数 vs 消费 DAEMON_CADENCE 的文件数。
    // findings TP-12：表头自称唯一，实际至少六个循环各带自己的周期字面量。
    const cadence = CORPUS.find(
      (u) => u.path === 'packages/backend/src/services/daemonCadence.ts',
    )
    expect(cadence, '派生端文件不存在：services/daemonCadence.ts').toBeDefined()

    const intervalSites = CORPUS.filter(
      (u) => u.path.startsWith('packages/backend/src/') && u.text.includes('setInterval('),
    )
    const consumers = intervalSites.filter((u) => u.text.includes('DAEMON_CADENCE'))
    const outsiders = intervalSites.filter((u) => !u.text.includes('DAEMON_CADENCE'))

    const claimsSole = /唯一注册表/u.test(commentText(cadence!))
    expect(
      claimsSole && outsiders.length > 0,
      `daemonCadence.ts 自称「唯一注册表」，但有 ${outsiders.length} 个文件在表外自带 setInterval 周期` +
        `（表内消费者 ${consumers.length} 个）。这句话的危害不是数错，` +
        '而是它让读者读完本表就停止去别处找。',
    ).toBe(false)
  })
})
