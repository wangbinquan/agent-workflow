// RFC-317 T16 / T17 —— 债务账本只许缩，不许长。
//
// 事故形态
// --------
// 本仓的「已知违规 / 豁免」账本散在十二处。每一处都已有精确相等或 stale 检测，挡得住
// 「悄悄加一条**违规**」——但挡不住「加一条**豁免**」：同一个 PR 里加违规 + 加豁免，
// 两边一起改，所有断言照绿。findings CC-06 / CC-03 记的就是这条通路。
//
// 更根本的是：**账本整体在长**这件事此前没有任何地方看得见。加一条豁免只是 diff 里
// 多两行，没有一个数字会变，review 时也就没有一个「涨了」的信号。债务账本天然会向
// 「加一条比修一处便宜」的方向滑，缺一个把方向钉住的机器。
//
// 规则（两层）
// -----------
// ① **与源码逐字相等**：账本条目数变了（增或减）就必须同批改 `ledger-baselines.json`。
//    用相等而不是 `<=`——`<=` 会把「收敛出来的差额」变成下一个人的免费槽位，
//    RFC-317 T18 刚在 rfc217 G5 上实测漏过 3 个。
// ② **相对上一个 commit 只降不升**：拿 `git show HEAD~1:` 的基线比。要升就得在那条
//    账本上显式写 `allowGrowth` 并点名 RFC——涨这件事必须留下一次有署名的记录。
//    `allowGrowth` 会在下一个不涨的 commit 上被判为过期，强制清理，不会长期挂着。
//
// 清点走 `census.ts` 的 `ledgerEntryCount`（AST，按符号名），与生成基线用的是同一份
// 实现；否则又是「账本一套判据、守卫另一套判据」。

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import ts from 'typescript'

import { ledgerEntryCount, portable } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

interface LedgerBaseline {
  readonly id: string
  readonly file: string
  readonly symbol: string
  readonly baseline: number
  readonly why: string
  readonly allowGrowth?: { readonly why: string }
}

const BASELINES = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'architecture', 'ledger-baselines.json'), 'utf8'),
) as { readonly ledgers: readonly LedgerBaseline[] }

function git(...args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  return { ok: result.status === 0, stdout: result.stdout ?? '' }
}

/** HEAD~1 是否可读——shallow clone / 首个 commit 时不可读，此时显式跳过而不是假绿。 */
const PARENT_AVAILABLE = git('rev-parse', '--verify', 'HEAD~1').ok

describe('RFC-317 T16 —— 账本条目数与源码逐字相等', () => {
  test('语料非空：基线文件本身不能是空表', () => {
    expect(BASELINES.ledgers.length).toBeGreaterThanOrEqual(10)
  })

  test('每份账本都数得出来（符号被改名 / 删除 ⇒ 红，而不是被当成「清空了」）', () => {
    const unreadable = BASELINES.ledgers
      .filter(
        (ledger) =>
          ledgerEntryCount(readFileSync(resolve(REPO_ROOT, ledger.file), 'utf8'), ledger.symbol) ===
          null,
      )
      .map((ledger) => `${ledger.id}（${ledger.symbol} @ ${ledger.file}）`)
    expect(
      unreadable,
      '这些账本按名字数不出条目数。符号被改名或删除时**绝不能**当成 0——' +
        '0 会被读成「账本清空了，真棒」，实际是清点失效，又一次「零与合规同形」',
    ).toEqual([])
  })

  test('条目数与基线逐字相等（增了要解释，减了要把基线一起改小）', () => {
    const drift: string[] = []
    for (const ledger of BASELINES.ledgers) {
      const actual = ledgerEntryCount(
        readFileSync(resolve(REPO_ROOT, ledger.file), 'utf8'),
        ledger.symbol,
      )
      if (actual === null) continue // 上一条已经报过
      if (actual !== ledger.baseline) {
        drift.push(`${ledger.id}: 源码 ${actual} vs 基线 ${ledger.baseline}`)
      }
    }
    expect(
      drift,
      '债务账本的条目数变了。**增**了要在 review 里说清为什么加豁免比修问题更值得；' +
        '**减**了说明债还掉了——把基线一起改小，否则差额会变成下一个人的免费槽位',
    ).toEqual([])
  })

  test('每份账本都写清了 why（账本条目没有理由就是「以后再说」）', () => {
    const bad = BASELINES.ledgers
      .filter((ledger) => ledger.why.trim().length < 15)
      .map((ledger) => ledger.id)
    expect(bad, 'why 必须说明这份账本记的是什么债、为什么还没还').toEqual([])
  })

  test('id 唯一，且 file+symbol 组合不重复', () => {
    const ids = BASELINES.ledgers.map((ledger) => ledger.id)
    expect(new Set(ids).size, 'id 重复').toBe(ids.length)
    const keys = BASELINES.ledgers.map((ledger) => `${ledger.file}#${ledger.symbol}`)
    expect(new Set(keys).size, 'file+symbol 重复').toBe(keys.length)
  })
})

/**
 * 相对上一版基线，哪些账本涨了却没声明 `allowGrowth`。**纯函数**——git 接线与
 * RFC-317 T21 的自变异共用它。
 *
 * 抽成纯函数是被自己坑出来的：初版把比对逻辑直接写在 test 里，且「读不到上一版」
 * 时 `return` 掉。写这条守卫的当下 `ledger-baselines.json` 还没进过任何 commit，
 * 于是 `git show HEAD~1:` 读不到、整条检查**静默跳过**——实测「同一个 PR 里加豁免 +
 * 把基线一起改大」（正是 CC-06 那条通路）**照绿**。守卫自己犯了它要防的那个错。
 */
export function growthViolations(
  current: readonly LedgerBaseline[],
  previous: ReadonlyMap<string, number>,
): string[] {
  const grown: string[] = []
  for (const ledger of current) {
    const was = previous.get(ledger.id)
    if (was === undefined) continue // 新账本，另有一条管
    if (ledger.baseline > was && ledger.allowGrowth === undefined) {
      grown.push(`${ledger.id}: ${was} → ${ledger.baseline}`)
    }
  }
  return grown
}

/** `allowGrowth` 在本次没有实际上涨时即为过期。 */
export function staleGrowthPermits(
  current: readonly LedgerBaseline[],
  previous: ReadonlyMap<string, number>,
): string[] {
  const stale: string[] = []
  for (const ledger of current) {
    if (ledger.allowGrowth === undefined) continue
    const was = previous.get(ledger.id)
    if (was === undefined || ledger.baseline <= was) {
      stale.push(`${ledger.id}（本 commit 未涨，allowGrowth 应删除）`)
    }
  }
  return stale
}

type PreviousBaselines =
  | { readonly kind: 'ok'; readonly baselines: ReadonlyMap<string, number> }
  | { readonly kind: 'no-parent' }
  | { readonly kind: 'absent-in-parent' }
  | { readonly kind: 'unparsable' }

/**
 * 「上一版」是哪一版，取决于**本次评估的对象是谁**。
 *
 * - 基线文件有未提交改动 ⇒ 评估对象是**工作树**，上一版就是 `HEAD`。
 * - 基线文件干净（CI 的情形：工作树逐字等于 HEAD）⇒ 评估对象是 `HEAD` 这一笔，
 *   上一版是 `HEAD~1`。
 *
 * 初版一律比 `HEAD~1`，是用起来才暴露的缺陷：本地带着未提交改动时它**跳过了 HEAD**，
 * 于是上一笔已经提交过的涨账会被重复算成「本次增长」，一次性的 allowGrowth 也就永远
 * 判不了过期。两种情形共用一个引用，必然错一头。
 */
function baselineComparisonRef(): string | null {
  const dirty = git('status', '--porcelain', '--', 'architecture/ledger-baselines.json')
  if (dirty.ok && dirty.stdout.trim().length > 0) return 'HEAD'
  return PARENT_AVAILABLE ? 'HEAD~1' : null
}

function readPreviousBaselines(): PreviousBaselines {
  const ref = baselineComparisonRef()
  if (ref === null) return { kind: 'no-parent' }
  const shown = git('show', `${ref}:architecture/ledger-baselines.json`)
  if (!shown.ok) return { kind: 'absent-in-parent' }
  try {
    const parsed = JSON.parse(shown.stdout) as { ledgers?: readonly LedgerBaseline[] }
    return {
      kind: 'ok',
      baselines: new Map((parsed.ledgers ?? []).map((ledger) => [ledger.id, ledger.baseline])),
    }
  } catch {
    return { kind: 'unparsable' }
  }
}

const PREVIOUS = readPreviousBaselines()

/**
 * RFC-317 T72 —— R10 少了最外面那一圈：**新出现的账本必须进 `ledger-baselines.json`**。
 *
 * T16/T17 管的是「已登记的账本不许悄悄变大」。但**谁来保证一份新账本会被登记**？
 * 此前没有任何东西——于是「加一份新的豁免表」这个动作完全不留痕迹，而它恰恰是
 * 绕过整套高水位机制最省事的办法。收口时实测：仓内 27 处账本形状的豁免表，
 * `ledger-baselines.json` 只覆盖 **8** 处，其中包括能力影响 C9 逐字点名的
 * `DIRECT_STATUS_WRITE_ALLOWLIST`（node_run 盲写）与 `STATUS_WRITE_ALLOWLIST`
 * （tasks.status 直写）。AC-6 写的是「R10 覆盖仓内每一个 allowlist」。
 *
 * 判据形状：扫 tests / scripts 下的**顶层集合常量**，名字命中账本词汇
 * （ALLOWLIST / EXEMPT / KNOWN_VIOLATIONS / DEBT / _HASHES / ALLOWED_ / PENDING_），
 * 初始化式是数组 / 对象 / new Set / new Map。每一处要么在基线文件里有条目，
 * 要么进下面这张**具名豁免表**并写清为什么它不是账本。
 */
const NOT_A_LEDGER: Readonly<Record<string, string>> = {
  // 这张表自己：它是「哪些集合不算账本」的声明，不是债务。
  'packages/backend/tests/architecture/rfc317-ledger-highwater.test.ts|NOT_A_LEDGER':
    '本规则的豁免表本身；它的条目数由下面那条精确相等断言钉住',
}

describe('RFC-317 T72 —— 新账本必须入网（R10 的覆盖面）', () => {
  test('tests / scripts 下的账本形状常量，要么入基线、要么在具名豁免表里', () => {
    const roots = [
      'packages/backend/tests',
      'packages/frontend/tests',
      'packages/shared/tests',
      'scripts',
    ]
    const registered = new Set(BASELINES.ledgers.map((l) => `${l.file}|${l.symbol}`))
    const corpus = roots.flatMap((root) => listSourceFiles(resolve(REPO_ROOT, root)))
    // 语料下限（T13）：本条是扫语料型判据，扫描根一旦失效它会永久静默地绿。
    // 实测 500+ 个文件；下限取一个明显更低、但足以证明枚举没断的数。
    expect(corpus.length, 'tests / scripts 的文件枚举断了，下面的缺席断言全部失去意义').toBeGreaterThan(
      300,
    )
    const found: string[] = []
    const unregistered: string[] = []
    {
      for (const file of corpus) {
        const rel = portable(relative(REPO_ROOT, file))
        for (const symbol of ledgerShapedSymbols(readFileSync(file, 'utf8'))) {
          const key = `${rel}|${symbol}`
          found.push(key)
          if (registered.has(key)) continue
          if (Object.prototype.hasOwnProperty.call(NOT_A_LEDGER, key)) continue
          unregistered.push(key)
        }
      }
    }
    expect(found.length, '一处账本形状常量都没扫到——判据的被测面没了').toBeGreaterThan(20)
    expect(
      unregistered,
      '这些豁免表没有进 architecture/ledger-baselines.json。' +
        '「加一份新账本」是绕过整套高水位机制最省事的办法，必须留痕：' +
        '要么给它钉一个只降不升的条目数，要么在 NOT_A_LEDGER 里写清它为什么不是账本。',
    ).toEqual([])
  })

  test('豁免表逐条相等（删一条消红也会红）', () => {
    expect(Object.keys(NOT_A_LEDGER).sort()).toEqual([
      'packages/backend/tests/architecture/rfc317-ledger-highwater.test.ts|NOT_A_LEDGER',
    ])
  })

  test('matcher 自证：账本形状的常量必须被认出来，非账本形状必须放过', () => {
    const ledgerLike = [
      "const SOMETHING_ALLOWLIST = new Set<string>(['a'])",
      'const KNOWN_VIOLATIONS = [{ rule: 1 }]',
      "const PENDING_ENROLMENT: readonly string[] = ['x']",
    ].join('\n')
    expect(ledgerShapedSymbols(ledgerLike).sort()).toEqual([
      'KNOWN_VIOLATIONS',
      'PENDING_ENROLMENT',
      'SOMETHING_ALLOWLIST',
    ])
    const notLedgerLike = [
      // 名字命中但不是集合
      'const ALLOWLIST_PATH = resolve(dir, "x")',
      // 集合但名字不是账本词汇
      "const ROOTS = ['a', 'b']",
      // 非顶层（函数体内的局部量不是账本）
      'function f() { const LOCAL_ALLOWLIST = new Set<string>() ; return LOCAL_ALLOWLIST }',
    ].join('\n')
    expect(
      ledgerShapedSymbols(notLedgerLike),
      '判据把非账本也算进来了——那会逼着后来的人给普通常量改名',
    ).toEqual([])
  })
})

const LEDGER_NAME = /ALLOWLIST|ALLOWED_|EXEMPT|KNOWN_VIOLATIONS|_HASHES|DEBT|PENDING_/

/** 顶层的、名字命中账本词汇的、集合形状的常量名。纯函数——扫描与自证共用。 */
function ledgerShapedSymbols(text: string): string[] {
  const source = ts.createSourceFile('ledger.ts', text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      if (!LEDGER_NAME.test(declaration.name.text)) continue
      const initializer = declaration.initializer
      if (initializer === undefined) continue
      if (!isCollectionInitializer(initializer)) continue
      out.push(declaration.name.text)
    }
  }
  return out
}

function isCollectionInitializer(node: ts.Expression): boolean {
  if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) return true
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return isCollectionInitializer(node.expression)
  }
  if (ts.isParenthesizedExpression(node)) return isCollectionInitializer(node.expression)
  if (ts.isNewExpression(node)) return /\b(Set|Map)$/.test(node.expression.getText())
  return false
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.tsx?$/.test(entry.name)) out.push(path)
    }
  }
  visit(dir)
  return out
}

describe('RFC-317 T17 —— 基线相对上一个 commit 只降不升', () => {
  test('历史比对确实跑了；跑不了时必须是两个**已知**原因之一，并把原因打出来', () => {
    if (PREVIOUS.kind !== 'ok') {
      console.warn(
        `[RFC-317 T17] 未做历史比对，原因：${PREVIOUS.kind}。` +
          '本轮只校验了「与源码逐字相等」。',
      )
    }
    // 'unparsable' 不在可接受之列——上一版是坏 JSON 说明有人把账本改烂了，那是红。
    // 'absent-in-parent' 只在引入本文件的那个 commit 上成立；此后再出现说明文件被删。
    expect(
      PREVIOUS.kind,
      '历史比对没跑成，而原因不是「shallow clone / 首个 commit」也不是「本文件刚引入」。' +
        '静默跳过就是假绿——本守卫初版正是栽在这里',
    ).not.toBe('unparsable')
  })

  test('没有一份账本的基线比上一个 commit 高（要升必须显式声明 allowGrowth）', () => {
    if (PREVIOUS.kind !== 'ok') return
    expect(
      growthViolations(BASELINES.ledgers, PREVIOUS.baselines),
      '债务账本涨了。**加一条豁免比修一处问题便宜**，这正是账本会失控的方向——' +
        '确实要涨就在该条目上写 allowGrowth 并点名 RFC，让涨这件事留下有署名的记录',
    ).toEqual([])
  })

  test('新加的账本必须带 why（新账本天然是「新增的债务面」，不能悄悄出现）', () => {
    if (PREVIOUS.kind !== 'ok') return
    const added = BASELINES.ledgers.filter((ledger) => !PREVIOUS.baselines.has(ledger.id))
    const bad = added.filter((ledger) => ledger.why.trim().length < 15).map((ledger) => ledger.id)
    expect(bad, '新账本的 why 必须说明它记的是什么债').toEqual([])
  })

  test('allowGrowth 无过期条目（这个 commit 没涨就必须删掉它）', () => {
    if (PREVIOUS.kind !== 'ok') return
    expect(
      staleGrowthPermits(BASELINES.ledgers, PREVIOUS.baselines),
      'allowGrowth 是**一次性**的：它授权的那次上涨完成后必须立刻删掉。' +
        '留着等于给这份账本发了长期上涨许可',
    ).toEqual([])
  })

  test('每条 allowGrowth 都点名了 RFC（不接受「暂时加一条」）', () => {
    const bad = BASELINES.ledgers
      .filter(
        (ledger) =>
          ledger.allowGrowth !== undefined &&
          (ledger.allowGrowth.why.trim().length < 20 ||
            !/RFC-\d{3}/.test(ledger.allowGrowth.why)),
      )
      .map((ledger) => ledger.id)
    expect(bad, 'allowGrowth.why 必须点名具体 RFC 并说明为什么加豁免比修问题更值得').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// R11 自变异：清点判据必须有牙齿（T21）
// ---------------------------------------------------------------------------

interface Fixture {
  readonly name: string
  readonly source: string
  readonly symbol: string
  readonly count: number | null
}

const FIXTURES: readonly Fixture[] = [
  {
    name: '数组字面量',
    source: "const L: readonly string[] = ['a', 'b', 'c']\n",
    symbol: 'L',
    count: 3,
  },
  {
    name: '对象字面量（Record 形态的账本）',
    source: "const L: Record<string, number> = { a: 1, b: 2 }\n",
    symbol: 'L',
    count: 2,
  },
  {
    name: 'new Set([...])',
    source: "const L = new Set(['a', 'b'])\n",
    symbol: 'L',
    count: 2,
  },
  {
    name: 'new Map([...])',
    source: "const L = new Map([['a', 1], ['b', 2], ['c', 3]])\n",
    symbol: 'L',
    count: 3,
  },
  {
    name: 'as const 断言包裹',
    source: "const L = ['a', 'b', 'c', 'd'] as const\n",
    symbol: 'L',
    count: 4,
  },
  {
    name: '空账本是 0，不是 null（目标态账本必须数得出 0）',
    source: 'const L: Record<string, string> = {}\n',
    symbol: 'L',
    count: 0,
  },
  {
    name: '符号不存在 ⇒ null（**不能**退化成 0，否则改名会被读成「清空了」）',
    source: "const OTHER = ['a']\n",
    symbol: 'L',
    count: null,
  },
  {
    name: '同名字符串出现在注释里不算声明',
    source: "// const L = ['a', 'b']\nconst OTHER = ['x']\n",
    symbol: 'L',
    count: null,
  },
  {
    name: '数不了的初始化形态 ⇒ null（宁可红，不要报一个编出来的数）',
    source: 'const L = buildLedger()\n',
    symbol: 'L',
    count: null,
  },
]

describe('RFC-317 T21 —— 只降不升判据自变异（含守卫初版的静默跳过）', () => {
  const ledger = (id: string, baseline: number, allowGrowth?: { why: string }): LedgerBaseline => ({
    id,
    file: 'x.ts',
    symbol: 'L',
    baseline,
    why: '够长的理由文本占位说明',
    ...(allowGrowth === undefined ? {} : { allowGrowth }),
  })

  test('涨了且没声明 ⇒ 报（这正是 CC-06「同一个 PR 加违规 + 加豁免」那条通路）', () => {
    expect(growthViolations([ledger('a', 14)], new Map([['a', 13]]))).toEqual(['a: 13 → 14'])
  })

  test('降了 / 持平 ⇒ 不报', () => {
    expect(growthViolations([ledger('a', 12)], new Map([['a', 13]]))).toEqual([])
    expect(growthViolations([ledger('a', 13)], new Map([['a', 13]]))).toEqual([])
  })

  test('涨了但显式声明 allowGrowth ⇒ 放行（涨要留下有署名的记录，不是不许涨）', () => {
    expect(
      growthViolations([ledger('a', 14, { why: 'RFC-999 的受控扩表' })], new Map([['a', 13]])),
    ).toEqual([])
  })

  test('上一版没有这条账本 ⇒ 不按「涨」处理（新账本另有一条断言管）', () => {
    expect(growthViolations([ledger('a', 5)], new Map())).toEqual([])
  })

  test('allowGrowth 在没实际上涨时即过期', () => {
    expect(
      staleGrowthPermits([ledger('a', 13, { why: 'RFC-999 的受控扩表' })], new Map([['a', 13]])),
    ).toEqual(['a（本 commit 未涨，allowGrowth 应删除）'])
    expect(
      staleGrowthPermits([ledger('a', 14, { why: 'RFC-999 的受控扩表' })], new Map([['a', 13]])),
    ).toEqual([])
  })

  test('上一版为空表时，涨不出来也报不出来——这正是初版静默跳过的形状', () => {
    // 初版在读不到上一版时直接 return，于是「加豁免 + 改大基线」照绿。现在读不到
    // 会由上面的「历史比对确实跑了」把原因打出来，而判据本身在空表上仍然自洽。
    expect(growthViolations([ledger('a', 99)], new Map())).toEqual([])
  })
})

describe('RFC-317 T21 —— 清点判据自变异', () => {
  test('fixture 语料非空', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(8)
  })

  for (const fixture of FIXTURES) {
    test(`ledgerEntryCount：${fixture.name}`, () => {
      expect(ledgerEntryCount(fixture.source, fixture.symbol), fixture.name).toBe(fixture.count)
    })
  }
})

// ---------------------------------------------------------------------------
// 静态清点必须与运行时真实条数一致
// ---------------------------------------------------------------------------
//
// 高水位棘轮全靠 `ledgerEntryCount` 的静态清点，而它读的是**语法**。语法与运行时
// 一旦背离，棘轮钉住的就是个假数字。实撞过一次：`KNOWN_VIOLATIONS` 里有两处
// `...ARRAY.map(fn)` 展开，只数语法元素得 20、运行时是 35——展开内部从 15 条涨到
// 30 条时，那个 20 纹丝不动，正好是本棘轮要堵的静默增长通路。
//
// 能 import 的账本就拿运行时长度对一次账。不能 import 的（如 .dependency-cruiser.cjs
// 需要 env 才肯加载）只能靠静态清点，那更要保证清点本身是对的。

describe('RFC-317 T16 —— 静态清点与运行时条数对账', () => {
  test('KNOWN_VIOLATIONS：静态清点 === 运行时长度（展开必须被正确展开计数）', async () => {
    const { KNOWN_VIOLATIONS } = (await import('../../../../scripts/depcheck')) as {
      KNOWN_VIOLATIONS: readonly unknown[]
    }
    const statik = ledgerEntryCount(
      readFileSync(resolve(REPO_ROOT, 'scripts', 'depcheck.ts'), 'utf8'),
      'KNOWN_VIOLATIONS',
    )
    expect(
      statik,
      '静态清点与运行时条数不符。棘轮钉的是静态数，两者背离时钉住的就是个假数字——' +
        '典型成因是新增了一种展开写法（`...X.map()` 之外的形态）',
    ).toBe(KNOWN_VIOLATIONS.length)
  })
})

// ---------------------------------------------------------------------------
// T20 —— cruiser 规则里「已入账」的散文声明必须是真的
// ---------------------------------------------------------------------------
//
// `.dependency-cruiser.cjs` 里有四条规则在注释里写着「存量违例逐条记在
// scripts/depcheck.ts → KNOWN_VIOLATIONS」「Ledgered in scripts/depcheck.ts」。
// 这些是**散文**：账本里那几条被清空后，注释仍然这么写，而读代码的人会以为
// 「这条规则的存量债是有账的」。反过来，账本里引用了一条**已删除**的规则名时，
// 那些条目永远不会被触发、也永远不会被 stale 检测抓到（depcheck 只对比触发到的
// 违规），于是变成一堆谁也不敢删的僵尸。
//
// 两个方向都钉住。cruiser 配置只能按**文本**读——它在没有 DEPCRUISE_TSCONFIG 时
// 会主动抛错拒绝加载（那是它自己的失明棘轮），所以这里不 import。

describe('RFC-317 T20 —— cruiser 规则与 KNOWN_VIOLATIONS 双向一致', () => {
  const CONFIG = readFileSync(resolve(REPO_ROOT, '.dependency-cruiser.cjs'), 'utf8')
  /**
   * 机器标记，不是散文。
   *
   * 初版拿正则找「已入账 / Ledgered / KNOWN_VIOLATIONS」这类措辞，立刻撞上一个
   * 无解的情况：把一条过期声明**改正**成「T24 已落地，KNOWN_VIOLATIONS 里不再有
   * 本规则的条目」之后，那段话仍然命中同一个正则——**一句断言和它的否定，在正则
   * 眼里长得一模一样**。散文分类不出来，这正是本 RFC 反复讲的那件事：
   * 要判定的东西必须是机器可读的，不能是写给人看的话。
   */
  const LEDGER_MARKER = /@ledger\s+KNOWN_VIOLATIONS/

  const ruleNames = (): string[] => [...CONFIG.matchAll(/^\s*name: '([a-z0-9-]+)',$/gm)].map((m) => m[1]!)

  /**
   * 本规则块内、`from:` 之前的全部文字（注释 + comment 字段）。
   *
   * 初版取的是「name 行上下固定行数」的窗口，会**串到隔壁规则**去：
   * `no-shared-to-app` 因此被误判成「声称入账却没条目」。窗口式取文本在配置文件里
   * 几乎必然串味——按块边界取才对。这条误报是自己在跑之前抓到的，fixture 见文末。
   */
  const commentaryFor = (rule: string): string => {
    const lines = CONFIG.split('\n')
    const at = lines.findIndex((line) => line.includes(`name: '${rule}'`))
    if (at < 0) return ''
    let start = at
    while (start > 0 && lines[start]!.trim() !== '{') start -= 1
    let end = at
    while (end < lines.length && !/^\s*from: /.test(lines[end]!)) end += 1
    return lines.slice(start, end).join('\n')
  }

  test('语料非空：确实解析出了一批规则名（解析失效时本 describe 零预言力）', () => {
    expect(ruleNames().length).toBeGreaterThanOrEqual(8)
  })

  test('打了 @ledger 标记的规则，账本里必须真有它的条目', async () => {
    const { KNOWN_VIOLATIONS } = (await import('../../../../scripts/depcheck')) as {
      KNOWN_VIOLATIONS: readonly { rule: string }[]
    }
    const ledgered = new Set(KNOWN_VIOLATIONS.map((violation) => violation.rule))
    const liars = ruleNames()
      .filter((rule) => LEDGER_MARKER.test(commentaryFor(rule)))
      .filter((rule) => !ledgered.has(rule))
    expect(
      liars,
      '这些 cruiser 规则打了 @ledger 标记，而 KNOWN_VIOLATIONS 里一条都没有。' +
        '要么债已经还完了——把标记删掉；要么账本条目被误删了——补回来。' +
        '标记与账本不一致时，读代码的人会以为债是有人管的（实测 no-auth-to-services ' +
        '就这样过期挂了一段时间：T24 把 authLoginPolicy 迁进 auth/ 之后，注释仍宣称有账）',
    ).toEqual([])
  })

  test('账本里有条目的规则，必须打上 @ledger 标记（否则读规则的人看不出它有债）', async () => {
    const { KNOWN_VIOLATIONS } = (await import('../../../../scripts/depcheck')) as {
      KNOWN_VIOLATIONS: readonly { rule: string }[]
    }
    const unmarked = [...new Set(KNOWN_VIOLATIONS.map((violation) => violation.rule))]
      .filter((rule) => ruleNames().includes(rule))
      .filter((rule) => !LEDGER_MARKER.test(commentaryFor(rule)))
    expect(
      unmarked,
      '这些规则在 KNOWN_VIOLATIONS 里有存量债，但规则本身没有 @ledger 标记——' +
        '读 cruiser 配置的人会以为这条规则是干净的零违规规则',
    ).toEqual([])
  })

  test('账本引用的规则名必须仍然存在于 cruiser 配置里（否则是永不触发的僵尸条目）', async () => {
    const { KNOWN_VIOLATIONS } = (await import('../../../../scripts/depcheck')) as {
      KNOWN_VIOLATIONS: readonly { rule: string }[]
    }
    const declared = new Set(ruleNames())
    const zombies = [...new Set(KNOWN_VIOLATIONS.map((violation) => violation.rule))].filter(
      (rule) => !declared.has(rule),
    )
    expect(
      zombies,
      '这些账本条目引用了 cruiser 配置里不存在的规则名。规则被删 / 改名后它们永远不会被' +
        '触发，depcheck 的 stale 检测（只比对触发到的违规）也看不见它们——谁都不敢删的僵尸',
    ).toEqual([])
  })

  test('自证：标记判据认得出标记，且**不**被散文（含它的否定式）满足', () => {
    expect(LEDGER_MARKER.test('// @ledger KNOWN_VIOLATIONS —— 本规则有存量债。')).toBe(true)
    // 下面三句都是散文。初版的正则判据把前两句判成「声称入账」——而第二句恰恰在说
    // **没有**条目。一句断言和它的否定在正则眼里同形，这就是不能用散文当判据的实证。
    expect(LEDGER_MARKER.test('Existing debt is ledgered in scripts/depcheck.ts.')).toBe(false)
    expect(LEDGER_MARKER.test('T24 已落地，KNOWN_VIOLATIONS 里不再有本规则的条目。')).toBe(false)
    expect(LEDGER_MARKER.test('Routes are HTTP transport adapters.')).toBe(false)
  })
})

// RFC-317 T20 自变异 —— 注释块提取必须按**块边界**取，不能取固定窗口。
//
// 初版按「name 行上下固定行数」取窗口，直接串到隔壁规则：`no-shared-to-app` 被判成
// 「声称入账却没条目」，而那句「已入账」根本是上一条规则的注释。配置文件里规则挨着
// 排，窗口式取文本几乎必然串味。
describe('RFC-317 T20 自变异 —— 注释归属', () => {
  const FABRICATED = [
    '    {',
    '      // 这条规则的存量违例逐条记在 scripts/depcheck.ts → KNOWN_VIOLATIONS。',
    "      name: 'rule-with-ledger',",
    "      severity: 'error',",
    '      from: { path: "^a/" },',
    '      to: { path: "^b/" },',
    '    },',
    '    {',
    '      // 这条规则是纯禁止，没有任何存量债。',
    "      name: 'rule-without-ledger',",
    "      severity: 'error',",
    '      from: { path: "^c/" },',
    '      to: { path: "^d/" },',
    '    },',
  ].join('\n')

  const blockFor = (config: string, rule: string): string => {
    const lines = config.split('\n')
    const at = lines.findIndex((line) => line.includes(`name: '${rule}'`))
    if (at < 0) return ''
    let start = at
    while (start > 0 && lines[start]!.trim() !== '{') start -= 1
    let end = at
    while (end < lines.length && !/^\s*from: /.test(lines[end]!)) end += 1
    return lines.slice(start, end).join('\n')
  }

  test('相邻规则的注释不会串味（初版固定窗口正是栽在这里）', () => {
    const claim = /KNOWN_VIOLATIONS|[Ll]edgered|入账/
    expect(claim.test(blockFor(FABRICATED, 'rule-with-ledger'))).toBe(true)
    expect(
      claim.test(blockFor(FABRICATED, 'rule-without-ledger')),
      '隔壁规则的「已入账」串进来了——按块边界取才对',
    ).toBe(false)
  })

  test('取不到规则时返回空串而不是抛（规则被删时上层断言自己会报）', () => {
    expect(blockFor(FABRICATED, 'no-such-rule')).toBe('')
  })
})
