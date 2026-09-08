// RFC-359 W5 —— provider 组合根必须被测试**真正构造**过（只降不升）。
//
// 危害：源码文本锁会把「从未跑过」伪装成「已经覆盖」
// ------------------------------------------------
// 双 provider 的装配面看上去总是对称的：每个 bounded context 的 `composition*` 下都躺着一对
// `composeSqliteXxx` / `composePostgresqlXxx`，`architecture/*.json` 里两侧都在册，守卫也都绿。
// 但「在册」与「跑过」是两件事。本仓最常见的 PostgreSQL 侧「覆盖」形态是**源码文本锁**——
// 测试 `readFileSync` 一个生产文件、再 `expect(source).toContain('composePostgresqlXxx(')`。
// 那条断言证明的只是**装配点这行字还在**：工厂内部的 SQL 方言、列名、事务语义、参数占位符
// 全部没有被执行过一次。于是「PostgreSQL 上从来没跑过」这件事，在覆盖率、在 grep、在
// 「两个 provider 都有测试」的印象里，与真的跑过**完全同形**。
//
// 这不是假想。本轮调研在本仓查实的三条：
//   ① `composePostgresqlTaskExecutionProviderRuntime`（`modules/task-execution/composition/
//      providerRuntime.ts`）在整棵 `tests/` 下**零引用**——PostgreSQL 侧的执行链组合根
//      从未被任何测试构造过；
//   ② `rfc349-postgresql-daemon-system-identity.test.ts` 是**源码文本锁**：`readFileSync`
//      daemon 源码 + `toContain('actorOfDirectAuthority(systemIdentity)')`，一行生产代码都没跑；
//   ③ `rfc349-child-execution-launch-postgresql-adapter.test.ts` 确实构造了适配器，但喂的是
//      **假 pool**（`const pool: PostgresqlPool = { … }`）——它证明的是接线，不是 PostgreSQL 行为。
// 三条合起来的结论是：装配面「两个 provider 都有」，实际只有一侧被执行过。
//
// 本守卫守的东西
// -------------
// 「这个 provider 组合根，有没有任何一个测试**真的把它构造出来**过。」判据只有一种正形态：
// **值级 import 进来的绑定出现在 `CallExpression` 的 callee 位置**。由此排除掉的三种
// 「看起来覆盖了」正是本守卫的全部价值所在——判不准就等于没写：
//   - **字符串字面量里的名字**：`expect(src).toContain('composePostgresqlXxx(')` 在 AST 里
//     是 StringLiteral，永远到不了 callee 位置。这一条挡的就是上面 ② 那类源码文本锁。
//   - **只 import 未调用**：有绑定、没有调用点。import 只证明模块能解析，不证明工厂跑过。
//   - **注释里的名字**：注释根本不进 AST——这也是这里用 AST 而不是正则的原因（本仓教训：
//     用正则剥注释迟早吃掉真代码）。
// 另外刻意要求「该名字有**值级 import 绑定**」而不是只比名字：测试里自己写一个同名 stub
// 再调用它，不能算作构造过生产装配面。
//
// 为什么现在是高水位而不是 0
// ------------------------
// 本守卫落地时有 70 个 provider 组合根从未被测试构造过，一次性补齐等于重写半个 PostgreSQL
// 测试面。所以那一轮**只上守卫、不做迁移**：机制同 RFC-317 T17 与
// `rfc359-sync-transaction-highwater.ts`——逐条列出欠债并与实测**逐字相等**。
// **增**了红：又一个组合根只有装配、没有构造。**减**了也红：某个组合根终于被真的构造过了，
// 把账本一起改小，让这次收敛留下一次有署名的提交记录。长期目标是 0。
//
// RFC-359 W7 第一轮还债把 70 收敛到 20：`tests/rfc359-w7-*-composition-roots.test.ts` 四个文件
// 给 50 个组合根写了「双引擎装配 + 至少驱动一个真方法」的用例（webhook 全家、目录 ACL /
// 概览 / 演示种子、认证 / 身份访问 / 记忆、code-capability 三个读端口与能力模板、研发配置、
// 工作区维护、数字员工模块与动作执行器、资源包 apply 收敛）。剩下的 20 条不是「忘了写」，
// 而是各自卡在一件具体的事上——`design/RFC-359-*/` 之外不另立文档，逐条理由见那四个文件的
// 头注释与 W7 的交接说明：
//   · `providerRuntime.ts` 的两个执行链组合根要整包 daemon 依赖（runtime / routeLaunch /
//     routes / lifecycleRepair / fusion / trigger / rootResumeRuntime …），得先有一份可复用的
//     bootstrap 夹具；
//   · intent 的 7 条与 `runtime-management` 的 realtime 运行时正在被 provider 适配器合一改写，
//     这一轮刻意不去钉住即将消失的名字；
//   · collaboration 路由操作、event-center、资源包目录 / 提供方、intent-apply 资源绑定需要
//     跨 context 的已准入 authority 与外部生命周期 owner，属于下一波。
//
// 扫描面刻意按 RFC-359 W5 的口径限定在 `src/**/composition*`——`cli/**` 里的 daemon 组合根
// （`composePostgresqlDaemonApplication`）同属这个问题域但不在本账本内，那是下一步的事。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import ts from 'typescript'

const SRC = resolve(import.meta.dir, '..', '..', 'src')
const TESTS = resolve(import.meta.dir, '..')

/**
 * 架构守卫账本所在的目录——**账本不构成「现状」证据**。
 *
 * `tests/architecture/` 底下每个文件都是架构守卫（`census.ts` 的 `guardTestFiles` 也是这么
 * 判的：目录本身就是声明），而账本的职责就是**点名**符号。下面这份账本自己就把 70 个欠债
 * 符号写成了字符串字面量；隔壁的 provider 配对账本同样点名它们。若把这些也算成「源码文本锁」，
 * 会同时坏两件事：一份账本改写它自己记录的事实；另一份账本增删一行，这里的现状就跟着翻——
 * 两条互不相干的守卫被绑成了一体。
 *
 * 所以「现状」（文本锁 / 只 import）只取 `tests/architecture/` **之外**的证据。
 * **构造**不受此限：在哪儿真调用都算数，架构目录里也照收——那是事实，不是描述。
 */
const ARCHITECTURE_LEDGER_DIR = 'architecture/'

/**
 * provider 专属组合根工厂的命名式：`composeSqlite*` / `composePostgresql*` /
 * `createSqlite*Runtime` / `createPostgresql*Runtime`。清单由此**派生**，不手写文件名单。
 */
const PROVIDER_ROOT_NAME =
  /^(?:compose(?:Sqlite|Postgresql)\w*|create(?:Sqlite|Postgresql)\w*Runtime)$/

/**
 * 上式的前缀——只用于测试语料的**廉价预筛**（省掉 1700 余次无谓的 AST 解析）。
 * 预筛不改判据：任何一种构造形态（直呼 / 别名 import / 命名空间调用）都必然让这个前缀
 * 出现在文件文本里，所以筛掉的文件不可能藏着构造点。
 */
const PROVIDER_ROOT_PREFIX = /(?:compose|create)(?:Sqlite|Postgresql)/

/**
 * `<相对 src 的路径>#<导出符号>: <现状>`，按 `路径#符号` 字典序。只降不升。
 *
 * 还债姿势：给该组合根写一条**真的把它构造出来**的测试——`import` 它、用一个真实（或
 * 至少可执行）的 db 客户端调用它，然后对它交出来的东西断言行为。把 `toContain('composeXxx(')`
 * 改成真调用即可摘掉对应行；`readFileSync` + 文本断言无论写多少条都不算。
 */
// W12 第七批：协作路由读写、实时持久事件回放及数字员工 workflow/agent 到 done
// 均经真实组合根执行，最后四项销账。空账本仍由独立 fixture 验证增减两个方向。
export const PROVIDER_RUNTIME_UNEXERCISED: readonly string[] = []

interface ProviderRoot {
  readonly file: string
  readonly symbol: string
}

interface ImportBindings {
  /** 本地名 → 原始导出名（`import { a as b }` 记 `b → a`）。 */
  readonly aliases: ReadonlyMap<string, string>
  /** `import * as m from '…'` 的 `m`。 */
  readonly namespaces: ReadonlySet<string>
}

interface RootFacts {
  /** 被某个测试真正构造过的符号。 */
  readonly constructed: ReadonlySet<string>
  /** 被某个测试值级 import 过的符号（调用与否另算）。 */
  readonly imported: ReadonlySet<string>
  /** 在某个测试的字符串字面量里出现过的符号——源码文本锁的形态。 */
  readonly textLocked: ReadonlySet<string>
}

function walk(root: string, dir: string, out: string[]): string[] {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(root, rel, out)
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(rel)
    }
  }
  return out
}

/** `src/**` 下路径命中 `composition*` 的文件——组合根的家。 */
function isCompositionPath(rel: string): boolean {
  return rel.split('/').some((segment) => segment === 'composition' || segment === 'composition.ts')
}

/** 组合根源文件语料——语料下限的分母之一（RFC-317 T13：扫空 = 假绿）。 */
function compositionSourceFiles(): string[] {
  return walk(SRC, '', []).filter(isCompositionPath).sort()
}

/**
 * backend 测试语料——语料下限的分母之二。
 *
 * 两棵树都要有下限：src 侧塌了会把清单扫成空（无债可欠、假绿），tests 侧塌了会把**全部**
 * 组合根判成「从未构造」（账本瞬间膨胀，同样是零预言力，只是往另一个方向坏）。
 */
function backendTestFiles(): string[] {
  return walk(TESTS, '', []).sort()
}

const COMPOSITION_SOURCE_FILES: readonly string[] = compositionSourceFiles()
const BACKEND_TEST_FILES: readonly string[] = backendTestFiles()

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
}

/** `src/**\/composition*` 下按命名式派生出的全部 provider 组合根导出。 */
function providerRoots(): ProviderRoot[] {
  const out: ProviderRoot[] = []
  for (const rel of COMPOSITION_SOURCE_FILES) {
    const source = parse(rel, readFileSync(join(SRC, rel), 'utf8'))
    for (const statement of source.statements) {
      const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []
      if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
      if (ts.isFunctionDeclaration(statement)) {
        const name = statement.name
        if (name !== undefined && PROVIDER_ROOT_NAME.test(name.text)) {
          out.push({ file: rel, symbol: name.text })
        }
        continue
      }
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && PROVIDER_ROOT_NAME.test(declaration.name.text)) {
          out.push({ file: rel, symbol: declaration.name.text })
        }
      }
    }
  }
  return out
}

/**
 * 值级 import 绑定。
 *
 * `import type { X }` / `import { type X }` 一律不算——类型别名调用不了，把它算进来只会
 * 制造「有 import 就算数」的假象，而那正是本守卫要拆穿的三种形态之一。
 */
export function valueImportBindings(
  source: ts.SourceFile,
  candidates: ReadonlySet<string>,
): ImportBindings {
  const aliases = new Map<string, string>()
  const namespaces = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const clause = statement.importClause
    if (clause === undefined || clause.isTypeOnly) continue
    const bindings = clause.namedBindings
    if (bindings === undefined) continue
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text)
      continue
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue
      const original = element.propertyName?.text ?? element.name.text
      if (candidates.has(original)) aliases.set(element.name.text, original)
    }
  }
  return { aliases, namespaces }
}

/**
 * 一个测试源文件里被**真正构造**过的组合根符号。
 *
 * 纯函数（只吃 SourceFile + 候选名，不碰文件系统），所以下面的变异 fixture 喂的是与账本
 * **同一份**判据——不是判据的一份拷贝。
 */
export function constructedProviderRoots(
  source: ts.SourceFile,
  candidates: ReadonlySet<string>,
): Set<string> {
  const { aliases, namespaces } = valueImportBindings(source, candidates)
  const found = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee)) {
        const original = aliases.get(callee.text)
        if (original !== undefined) found.add(original)
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text) &&
        candidates.has(callee.name.text)
      ) {
        found.add(callee.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** 以**字符串字面量**形态出现的候选名——源码文本锁的形态（模板串取其静态片段）。 */
export function stringLiteralMentions(
  source: ts.SourceFile,
  candidates: ReadonlySet<string>,
): Set<string> {
  const found = new Set<string>()
  const record = (text: string): void => {
    for (const name of candidates) {
      if (text.includes(name)) found.add(name)
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      record(node.text)
    } else if (ts.isTemplateExpression(node)) {
      record(node.head.text + node.templateSpans.map((span) => span.literal.text).join(''))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function collectFacts(candidates: ReadonlySet<string>): RootFacts {
  const constructed = new Set<string>()
  const imported = new Set<string>()
  const textLocked = new Set<string>()
  for (const rel of BACKEND_TEST_FILES) {
    const text = readFileSync(join(TESTS, rel), 'utf8')
    if (!PROVIDER_ROOT_PREFIX.test(text)) continue
    const source = parse(rel, text)
    // 构造：全树都算——在哪儿真调用都是事实。
    for (const name of constructedProviderRoots(source, candidates)) constructed.add(name)
    // 现状：只取架构账本之外的证据（见 ARCHITECTURE_LEDGER_DIR）。
    if (rel.startsWith(ARCHITECTURE_LEDGER_DIR)) continue
    for (const original of valueImportBindings(source, candidates).aliases.values()) {
      imported.add(original)
    }
    for (const name of stringLiteralMentions(source, candidates)) textLocked.add(name)
  }
  return { constructed, imported, textLocked }
}

const ROOTS: readonly ProviderRoot[] = providerRoots()
const ROOT_NAMES: ReadonlySet<string> = new Set(ROOTS.map((root) => root.symbol))
const FACTS: RootFacts = collectFacts(ROOT_NAMES)

/** 欠债项的「现状」一句话——写进账本，让每一行都自带下一步该怎么还。 */
function statusOf(symbol: string, facts: RootFacts): string {
  const textLocked = facts.textLocked.has(symbol)
  const importedOnly = facts.imported.has(symbol)
  if (textLocked && importedOnly) return '源码文本锁 + 只 import 未调用'
  if (textLocked) return '只有源码文本锁'
  if (importedOnly) return '只 import 未调用'
  return '零引用'
}

/**
 * 「有生产装配、但测试从未构造」的组合根。
 *
 * `extraConstructed` 只服务于变异实证：把一个伪造出来的构造点并进来，看账本是否如期变红。
 */
function debtRows(
  extraConstructed: ReadonlySet<string>,
  roots: readonly ProviderRoot[] = ROOTS,
  facts: RootFacts = FACTS,
): string[] {
  const rows: { key: string; row: string }[] = []
  for (const root of roots) {
    if (facts.constructed.has(root.symbol) || extraConstructed.has(root.symbol)) continue
    const key = `${root.file}#${root.symbol}`
    rows.push({ key, row: `${key}: ${statusOf(root.symbol, facts)}` })
  }
  rows.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  return rows.map((entry) => entry.row)
}

const NOTHING_EXTRA: ReadonlySet<string> = new Set<string>()
const TIMEOUT_MS = 120_000

describe('RFC-359 W5 —— provider 组合根必须被测试真正构造过', () => {
  test(
    '语料非空：src 与 tests 两棵树都扫到了（任一塌掉都是零预言力，且坏的方向相反）',
    () => {
      expect(
        COMPOSITION_SOURCE_FILES.length,
        'src 侧扫成空 ⇒ 无债可欠，假绿',
      ).toBeGreaterThanOrEqual(150)
      expect(
        BACKEND_TEST_FILES.length,
        'tests 侧扫成空 ⇒ 全部组合根都被判成没构造',
      ).toBeGreaterThanOrEqual(1500)
      expect(ROOTS.length, '命名式一条都派生不出来 ⇒ 清单本身失效').toBeGreaterThanOrEqual(80)
      // 架构账本排除必须是**真的排除**：该目录确实在语料里（本文件就躺在里面），
      // 才谈得上把它从「现状」证据里摘出去。目录改名会让这条当场红。
      expect(
        BACKEND_TEST_FILES.filter((rel) => rel.startsWith(ARCHITECTURE_LEDGER_DIR)).length,
        `架构账本目录没对上任何文件（${ARCHITECTURE_LEDGER_DIR}）`,
      ).toBeGreaterThanOrEqual(40)
    },
    TIMEOUT_MS,
  )

  test(
    '逐条与账本相等（增了是新的「只装配不构造」，减了是终于跑过了，都要改账本）',
    () => {
      expect(
        debtRows(NOTHING_EXTRA),
        'provider 组合根的「从未被测试构造」清单与账本不符。\n' +
          '**增**了：又多了一个只在装配面上存在、从未被任何测试构造过的 provider 组合根——' +
          "它内部的方言 / 列名 / 事务语义一次都没被执行过，而 `toContain('composeXxx(')` 这类" +
          '源码文本锁会让它看起来是覆盖的。给它写一条真的 import + 调用的测试，别再加文本锁。\n' +
          '**减**了：某个组合根终于被真的构造过了——把账本一起改小，让这次收敛留下一次有署名的提交记录。',
      ).toEqual([...PROVIDER_RUNTIME_UNEXERCISED])
    },
    TIMEOUT_MS,
  )

  test(
    '账本按 `路径#符号` 字典序、无重复（清点稳定的前提）',
    () => {
      const keys = PROVIDER_RUNTIME_UNEXERCISED.map((row) => row.slice(0, row.lastIndexOf(': ')))
      expect(new Set(keys).size, '账本里有重复的 路径#符号').toBe(keys.length)
      expect([...keys].sort()).toEqual(keys)
    },
    TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// 变异实证：三种「看起来覆盖了」必须被判准（RFC-317 T14 / T21）
// ---------------------------------------------------------------------------
//
// 判据一旦判错，本守卫会用与「全部合规」完全相同的形态绿掉：漏判 ⇒ 账本凭空变长，
// 误判 ⇒ 账本凭空缩短、真实缺口被抹掉。fixture 一律**内存字符串**，不落磁盘、不依赖
// 仓里某个文件恰好保持某形状。自带根与事实，真实账本清零后仍验证同一个判据。
//
// fixture 刻意**自带候选名集合**（`new Set([symbol])`）而不是复用 `ROOT_NAMES`：要证明的是
// 「判据本身还咬得动」，喂进去的东西就必须一点真实语料都不碰——碰了就变成在断言当下这棵树
// 的现状，那是规则本身，不是判据还活着的证据（RFC-317 T14 的判据即按此写）。

const FIXTURE_ROOT: ProviderRoot = {
  file: 'modules/x/composition/y.ts',
  symbol: 'composePostgresqlFixtureRuntime',
}
const EMPTY_FACTS: RootFacts = {
  constructed: NOTHING_EXTRA,
  imported: NOTHING_EXTRA,
  textLocked: NOTHING_EXTRA,
}

function fixtureDebtRows(constructed: ReadonlySet<string>): string[] {
  return debtRows(constructed, [FIXTURE_ROOT], EMPTY_FACTS)
}

/** 固定内存缺口，不依赖真实账本还剩几条。 */
function anyDebtSymbol(): { row: string; symbol: string } {
  return {
    row: `${FIXTURE_ROOT.file}#${FIXTURE_ROOT.symbol}: 零引用`,
    symbol: FIXTURE_ROOT.symbol,
  }
}

describe('RFC-359 W5 —— 判据自变异：三种「看起来覆盖了」', () => {
  test('空账本仍拒绝新增未构造根，真实构造后才恢复', () => {
    const roots = [...ROOTS, FIXTURE_ROOT]
    const { row, symbol } = anyDebtSymbol()
    const introduced = debtRows(NOTHING_EXTRA, roots)
    expect(introduced).toContain(row)
    expect(introduced).not.toEqual([...PROVIDER_RUNTIME_UNEXERCISED])
    expect(debtRows(new Set([symbol]), roots)).toEqual([...PROVIDER_RUNTIME_UNEXERCISED])
  })

  test(
    '① 真调用（import + CallExpression）⇒ 算覆盖，账本必须红并提示移除该行',
    () => {
      const { row, symbol } = anyDebtSymbol()
      const candidates = new Set([symbol])
      const source = parse(
        'fixture.test.ts',
        `import { ${symbol} } from '@/modules/x/composition/y'\n` +
          `const runtime = ${symbol}(db, {})\n`,
      )
      const found = constructedProviderRoots(source, candidates)
      expect([...found], '真调用没被认出来 ⇒ 收敛了也摘不掉行，账本会永远停在旧数上').toEqual([
        symbol,
      ])
      expect(
        fixtureDebtRows(found),
        '把一个真构造点并进来之后，账本必须正好少这一行——少不掉说明棘轮不会因收敛而红',
      ).toEqual(fixtureDebtRows(NOTHING_EXTRA).filter((each) => each !== row))
      // 「账本要红」说到底就是这一句：收敛发生后逐字相等必须不再成立，逼人把账本改小。
      expect(
        fixtureDebtRows(found),
        '收敛之后账本居然还相等 ⇒ 这条棘轮只会因新增而红，不会因还债而红，等于半条',
      ).not.toEqual(fixtureDebtRows(NOTHING_EXTRA))
    },
    TIMEOUT_MS,
  )

  test(
    "② 只有 `toContain('composeXxx(')` 字符串（源码文本锁）⇒ **不**算覆盖",
    () => {
      const { symbol } = anyDebtSymbol()
      const candidates = new Set([symbol])
      const source = parse(
        'fixture.test.ts',
        `import { readFileSync } from 'node:fs'\n` +
          `const src = readFileSync('/x/start.ts', 'utf8')\n` +
          `expect(src).toContain('${symbol}(db, {')\n`,
      )
      expect(
        [...constructedProviderRoots(source, candidates)],
        '源码文本锁被算成了构造——这正是本守卫存在的理由：它证明的只是「装配点这行字还在」',
      ).toEqual([])
      expect(
        [...stringLiteralMentions(source, candidates)],
        '文本锁形态必须能被认出来，否则欠债行的「现状」会退化成「零引用」',
      ).toEqual([symbol])
      expect(fixtureDebtRows(NOTHING_EXTRA), '账本不得因为一条文本锁而缩短').toContain(
        anyDebtSymbol().row,
      )
    },
    TIMEOUT_MS,
  )

  test(
    '③ 只 import 未调用（含在非调用位置引用）⇒ **不**算覆盖',
    () => {
      const { symbol } = anyDebtSymbol()
      const candidates = new Set([symbol])
      const source = parse(
        'fixture.test.ts',
        `import { ${symbol} } from '@/modules/x/composition/y'\n` +
          `expect(typeof ${symbol}).toBe('function')\n`,
      )
      expect(
        [...constructedProviderRoots(source, candidates)],
        'import + 一句 typeof 断言被算成了构造——那只证明模块能解析，工厂一次都没跑',
      ).toEqual([])
      // 绑定确实建立了：判「没调用」不是因为没看见这个名字。
      expect([...valueImportBindings(source, candidates).aliases.values()]).toEqual([symbol])
      expect(fixtureDebtRows(NOTHING_EXTRA), '账本不得因为一条 import 而缩短').toContain(
        anyDebtSymbol().row,
      )
    },
    TIMEOUT_MS,
  )

  test(
    '注释里的调用不算覆盖（用 AST 而不是正则的直接理由）',
    () => {
      const { symbol } = anyDebtSymbol()
      const candidates = new Set([symbol])
      const source = parse(
        'fixture.test.ts',
        `import { readFileSync } from 'node:fs'\n` +
          `// 以前这里是 ${symbol}(db, {})，改成读文件断言了\n` +
          `const src = readFileSync('/x/start.ts', 'utf8')\n`,
      )
      expect(
        [...constructedProviderRoots(source, candidates)],
        '注释被算成了构造 ⇒ 把调用注释掉就能凭空还债',
      ).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    '别名 import 后调用仍算覆盖（判据不能被 `as` 绕过）',
    () => {
      const { symbol } = anyDebtSymbol()
      const candidates = new Set([symbol])
      const source = parse(
        'fixture.test.ts',
        `import { ${symbol} as make } from '@/modules/x/composition/y'\n` +
          `const runtime = make(db, {})\n`,
      )
      expect([...constructedProviderRoots(source, candidates)]).toEqual([symbol])
    },
    TIMEOUT_MS,
  )

  test(
    '`import type` 的绑定不算覆盖（类型别名调用不了）',
    () => {
      const { symbol } = anyDebtSymbol()
      const candidates = new Set([symbol])
      const source = parse(
        'fixture.test.ts',
        `import type { ${symbol} } from '@/modules/x/composition/y'\n` +
          `const runtime: ReturnType<typeof ${symbol}> = fake\n`,
      )
      expect([...valueImportBindings(source, candidates).aliases.values()]).toEqual([])
      expect([...constructedProviderRoots(source, candidates)]).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    '测试里自写的同名 stub 不算覆盖（没有值级 import ⇒ 调的不是生产装配面）',
    () => {
      const { symbol } = anyDebtSymbol()
      const candidates = new Set([symbol])
      const source = parse(
        'fixture.test.ts',
        `function ${symbol}() {\n  return { fake: true }\n}\n` + `const runtime = ${symbol}()\n`,
      )
      expect(
        [...constructedProviderRoots(source, candidates)],
        '同名 stub 被算成了构造 ⇒ 只要在测试里写个同名函数就能凭空还债',
      ).toEqual([])
    },
    TIMEOUT_MS,
  )
})
