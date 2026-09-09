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
 * 判据形状：扫 tests / scripts 下的**顶层集合常量**（初始化式是数组 / 对象 /
 * new Set / new Map），两条判据取**并集**——
 *
 *   **A（词汇）**：名字命中账本词汇（ALLOWLIST / EXEMPT / KNOWN_VIOLATIONS / DEBT /
 *   _HASHES / ALLOWED_ / PENDING_）。这条覆盖「当过滤器用、从不被断言」的豁免表。
 *
 *   **B（结构）**：住在 `tests/architecture/` 里、且被 `toEqual` / `toStrictEqual`
 *   **等值断言**过。与名字无关。
 *
 * 为什么要有 B：A 是一张**词汇表，而词汇表自己会漏词**——T73 就是在往
 * `rfc254-platform-surface-guard` 的 `ALLOWANCES` 里加条目时才发现该词没进表、
 * 那份账本在覆盖规则眼里根本不存在。补一个词只是把同一个错推迟到下一个新名词：
 * RFC-359 W5 一轮新增的守卫里，`SQLITE_ONLY_PROTECTIONS` /
 * `PROVIDER_RUNTIME_UNEXERCISED` / `COVERAGE_PARITY_LEDGER` /
 * `DUAL_ENGINE_PREDICATE_GAPS` 等**一个都不命中** A，于是整批新账本全在网外。
 *
 * B 换成不依赖命名的两个事实：**住在哪**（守卫都在 `tests/architecture/`，目录不像
 * 名词那样漂）与**怎么用**（账本的定义就是「被拿来做等值断言的存量快照」）。
 * 「被等值断言」这一条不能省——实测：守卫目录内顶层集合常量共 143 个未登记，
 * 加上等值断言约束后降到 23 个且几乎全是真账本，其余是语料根 / 正则表 / 夹具。
 *
 * 判据 B 只作用于 `tests/architecture/`。守卫目录**外**也有账本（RFC-359 W7 实测 13 处，
 * 含 `scheduler-audit-s10` 的 `RAW_TRANSACTION_SITES`、`rfc310-architecture-lock` 的
 * `COMPOSITION_CONSUMERS`、前端 `tab-callsite-contract` 的 `TRUE_TAB_CALLSITES`），而
 * 目录外**不能**直接套 B：那些文件同时是普通测试，实测 B 会捞出 152 个未登记常量、
 * 其中 139 个是夹具。于是有第三条——
 *
 *   **C（来源）**：顶层「一批同形条目」的常量，被等值断言，声明后不再就地改动，
 *   且同一条断言的**另一侧**取自**仓库锚点**（`import.meta.dir(name)` / `__dirname` …）。
 *
 * C 的立意是把账本与夹具的**真实**区别写成机器判据：账本断言的是**仓库自己的存量**，
 * 夹具断言的是**一个函数对给定输入的输出**。一个测试要谈论仓库，就必须先把自己在仓库里
 * 的位置变成一条路径——除此之外没有别的入口。所以 C 认的是「**从哪儿读起**」而不是
 * 「**怎么读**」：`readdirSync` / `listSourceFiles` / `migrateSqlite` / `spawnSync('git')`
 * 是一张永远漏词的 API 词汇表（W7 收口时正是它漏掉了经 `migrateSqlite` 取证的
 * `rfc359-w5-t19g`），而锚点只有那几种写法，且值从锚点流到断言这件事是可追的
 * （沿声明与扫描累加器做一次不动点传播，与 RFC-349 `postgresqlSurface.ts` 把
 * 「命名前缀」换成「类型可达」是同一个动作）。
 *
 * 「一批同形条目」这一条不能省：账本是**一批**同形条目，夹具常常是**一条**领域记录。
 * 对象字面量按数据键（带引号）或值本身还是集合时才算集合，键是裸标识符、值是标量的
 * 对象（`{ kind: 'ok', summary: '', message: '' }`）是记录不是账本。实测：加上这一条，
 * 目录外新暴露的常量从 15 个降到 4 个，而 13 处已知账本一个都没丢。
 *
 * C ⊆ B（C 比 B 多要求一侧来自锚点），所以它在守卫目录内一条都不多认——实测 0 条，
 * 目录内的口径完全没动。
 *
 * 每一处要么在基线文件里有条目，要么进下面这张**具名豁免表**并写清为什么它不是账本。
 */
const NOT_A_LEDGER: Readonly<Record<string, string>> = {
  // 这张表自己：它是「哪些集合不算账本」的声明，不是债务。
  'packages/backend/tests/architecture/rfc317-ledger-highwater.test.ts|NOT_A_LEDGER':
    '本规则的豁免表本身；它的条目数由下面那条精确相等断言钉住',
  // RFC-329：债务是叶子，理由不是。这张表按 group 存一句话，条数完全由
  // MCP_SURFACE_EXEMPTION_LEAVES（已入基线，389）决定——最后一条叶子被移走时理由必须
  // 一起删（rfc329-mcp-surface-guard.test.ts 有「没有叶子的理由算 stale」那条断言），
  // 所以给它单独钉一个数字只会在收敛叶子时多红一次，钉不住任何多出来的债。
  'packages/backend/tests/architecture/rfc329McpSurfaceLedger.ts|EXEMPT_REASONS':
    'RFC-329 豁免叶子的分组理由字典；债务由 MCP_SURFACE_EXEMPTION_LEAVES 计量，这里只是它的说明文字',
  // —— 以下五条由判据 B（RFC-359 W7 新增）扫出来。它们都住在 `tests/architecture/` 里、
  // 也都被等值断言，但都不是「仓内存量的快照」，钉一个只降不升的数字没有意义。 ——
  //
  // ① 从扫描结果**派生**的期望：内容由 `capabilityTemplateAccessCalls`（一次源码扫描）
  //    经条件展开算出来，不是手工维护的清单——手工改它做不到，把它钉住只会在被扫对象
  //    正常演化时假红。
  'packages/backend/tests/architecture/rfc317-acl-write-gate-guard.test.ts|CAPABILITY_TEMPLATE_OPERATION_GATES':
    '由 capabilityTemplateAccessCalls 扫描结果派生的期望值，不是手工维护的存量清单',
  // ② 判据**自证**用的夹具：喂给纯函数 matcher 的假语料（`__fixture__/` / `modules/demo/` /
  //    `fixture-foo-*.test.ts`），一个字节都不来自真实仓库。它们变化只说明自证用例改了，
  //    与债务无关；反过来把它们钉住会让「给 matcher 补一条自证」变成要改基线的事。
  'packages/backend/tests/architecture/rfc359-w5-adapter-production-consumer.test.ts|FIXTURE_EXPECTED_DECLARATIONS':
    'matcher 自证的假语料（__fixture__/thing.ts），不来自真实仓库',
  'packages/backend/tests/rfc359-w26-workgroup-empty-scan.test.ts|observedValues':
    '固定的工作组字符串输入夹具（含空字符串和 Unicode），用于原查询完整返回值对拍，不是仓库债务或允许名单',
  'packages/backend/tests/rfc359-w26-workgroup-member-values.test.ts|directMembers':
    '固定成员输入夹具，用于原十列映射及读取顺序对拍，不是仓库扫描或豁免清单',
  'packages/backend/tests/rfc359-w26-workgroup-member-values.test.ts|fields':
    '原成员行的十个有序字段，断言完整对象属性顺序，不是仓库债务或高水位',
  'packages/backend/tests/rfc359-w12-clarify-inline-session-log.test.ts|EXPECTED_DESIGNER_SESSIONS':
    '真实子进程夹具的两次 designer session 与日志末尾换行预期，不是仓库扫描结果或债务豁免表',
  'packages/backend/tests/architecture/rfc359-w5-provider-pair-conformance.test.ts|FIXTURE_SOURCES':
    'matcher 自证的假语料（modules/demo/…），不来自真实仓库',
  'packages/backend/tests/architecture/rfc359-w5-provider-pair-conformance.test.ts|FIXTURE_SINGLE_ENGINE_TEST':
    'matcher 自证的假测试单元（fixture-foo-single-engine.test.ts），不来自真实仓库',
  'packages/backend/tests/architecture/rfc359-w5-provider-pair-conformance.test.ts|FIXTURE_HALF_TEST':
    'matcher 自证的假测试单元（fixture-foo-half.test.ts），不来自真实仓库',
  // —— 以下四条由判据 C（RFC-359 W7 第二波）扫出来，都住在守卫目录**外**。 ——
  //
  // ③ **双向**常驻基线：文件头注释写明「reverse AST check, with resident baselines so
  //    drift is visible in either direction」——它记的不是债，是「今天读到了哪些字段」。
  //    校验器多读一个字段是正常演进，钉一个只降不升的数字会在那时候假红。三处同族，
  //    一起豁免（只豁免其中两处会让「为什么这个族里有一处要登记」变成一道无解的题）。
  'packages/backend/tests/intent-teaching-registry.test.ts|VALIDATOR_BASELINE':
    'RFC-348 双向漂移基线：记「校验器今天读哪些名字」，两个方向都要看得见漂移，不是只降不升的债',
  'packages/backend/tests/intent-teaching-registry.test.ts|LAUNCH_BASELINE':
    'RFC-348 双向漂移基线：记「启动路径今天读哪些名字」，两个方向都要看得见漂移，不是只降不升的债',
  'packages/backend/tests/intent-teaching-registry.test.ts|FRONTEND_BASELINE':
    'RFC-348 双向漂移基线：记「前端今天读哪些名字」，两个方向都要看得见漂移，不是只降不升的债',
  // ④ 断言是 `expect.arrayContaining(...)` 的**部分**匹配，不是存量快照——这批工具名
  //    是「只读工具至少得有这些」的正向清单，多一个只读工具时它本来就该长。
  'packages/backend/tests/rfc326-mcp-review-tools.test.ts|READ_TOOLS':
    'RFC-326 只读评审工具的正向清单，经 expect.arrayContaining 部分匹配，不是仓内存量的快照',
  'packages/backend/tests/rfc359-w43-alternates-hook-diagnostics.test.ts|stages':
    '原 beforeAll 的固定诊断阶段期望序列，用于逐值核对操作开始/结束次序；不是生产债务或绕过清单。',
  'packages/backend/tests/rfc359-w43-daemon-setup-diagnostic.test.ts|pendingStages':
    '原初始化前缀停在 pending 时应出现的固定诊断消息，用于等待/清理协议对拍；不是生产债务或绕过清单。',
}

describe('RFC-317 T72 —— 新账本必须入网（R10 的覆盖面）', () => {
  /**
   * 显式预算，不吃 bun 的 5s 缺省。
   *
   * 这条判据要**逐字节读完** tests / scripts 下的全部源码（2026-08-24 实测 2044 个
   * 文件），成本随两个 RFC 并行加测试单调上涨。实测三档：本机整文件 37 条 1.7s；
   * CI ubuntu 单条 2.3s；CI macOS 单条 **5.6s —— 刚好越过 5s 缺省而红**（四个分片
   * 同机并行，I/O 争抢）。
   *
   * 这不是「重跑就过了」：判据本身没有时序依赖，红的原因是预算比语料小。给一个
   * 数量级留白的显式预算，既让受压 runner 不再假红，也不至于把真的挂死藏起来——
   * 扫描断了会立刻抛错，真跑飞会远超 30s。
   */
  const CORPUS_SCAN_TIMEOUT_MS = 30_000

  test(
    'tests / scripts 下的账本形状常量，要么入基线、要么在具名豁免表里',
    () => {
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
      expect(
        corpus.length,
        'tests / scripts 的文件枚举断了，下面的缺席断言全部失去意义',
      ).toBeGreaterThan(300)
      const found: string[] = []
      const unregistered: string[] = []
      {
        for (const file of corpus) {
          const rel = portable(relative(REPO_ROOT, file))
          const inGuardDirectory = rel.includes('/tests/architecture/')
          for (const symbol of ledgerShapedSymbols(readFileSync(file, 'utf8'), inGuardDirectory)) {
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
    },
    CORPUS_SCAN_TIMEOUT_MS,
  )

  test('豁免表逐条相等（删一条消红也会红）', () => {
    expect(Object.keys(NOT_A_LEDGER).sort()).toEqual([
      'packages/backend/tests/architecture/rfc317-acl-write-gate-guard.test.ts|CAPABILITY_TEMPLATE_OPERATION_GATES',
      'packages/backend/tests/architecture/rfc317-ledger-highwater.test.ts|NOT_A_LEDGER',
      'packages/backend/tests/architecture/rfc329McpSurfaceLedger.ts|EXEMPT_REASONS',
      'packages/backend/tests/architecture/rfc359-w5-adapter-production-consumer.test.ts|FIXTURE_EXPECTED_DECLARATIONS',
      'packages/backend/tests/architecture/rfc359-w5-provider-pair-conformance.test.ts|FIXTURE_HALF_TEST',
      'packages/backend/tests/architecture/rfc359-w5-provider-pair-conformance.test.ts|FIXTURE_SINGLE_ENGINE_TEST',
      'packages/backend/tests/architecture/rfc359-w5-provider-pair-conformance.test.ts|FIXTURE_SOURCES',
      'packages/backend/tests/intent-teaching-registry.test.ts|FRONTEND_BASELINE',
      'packages/backend/tests/intent-teaching-registry.test.ts|LAUNCH_BASELINE',
      'packages/backend/tests/intent-teaching-registry.test.ts|VALIDATOR_BASELINE',
      'packages/backend/tests/rfc326-mcp-review-tools.test.ts|READ_TOOLS',
      'packages/backend/tests/rfc359-w12-clarify-inline-session-log.test.ts|EXPECTED_DESIGNER_SESSIONS',
      'packages/backend/tests/rfc359-w26-workgroup-empty-scan.test.ts|observedValues',
      'packages/backend/tests/rfc359-w26-workgroup-member-values.test.ts|directMembers',
      'packages/backend/tests/rfc359-w26-workgroup-member-values.test.ts|fields',
      'packages/backend/tests/rfc359-w43-alternates-hook-diagnostics.test.ts|stages',
      'packages/backend/tests/rfc359-w43-daemon-setup-diagnostic.test.ts|pendingStages',
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

  test('matcher 自证（判据 B）：守卫目录内「被等值断言的集合」不看名字也算账本', () => {
    // 名字完全不命中词汇表——判据 A 放过它，判据 B 必须抓住。
    // 这正是 RFC-359 W5 那批新账本（SQLITE_ONLY_PROTECTIONS 等）逃逸的形状。
    const assertedInGuard = [
      "export const SQLITE_ONLY_PROTECTIONS: readonly string[] = ['a']",
      "test('x', () => { expect(actual).toEqual([...SQLITE_ONLY_PROTECTIONS]) })",
    ].join('\n')
    expect(ledgerShapedSymbols(assertedInGuard, true)).toEqual(['SQLITE_ONLY_PROTECTIONS'])
    expect(
      ledgerShapedSymbols(assertedInGuard, false),
      '判据 B 只作用于守卫目录；目录外套用它会把大批普通夹具误判成账本',
    ).toEqual([])

    // 账本在**实际**侧而不是期望侧，同样要认出来。
    const assertedOnActualSide = [
      "const UNDEFINED_CLASS_SNAPSHOT = new Set(['x'])",
      "test('x', () => { expect(UNDEFINED_CLASS_SNAPSHOT).toStrictEqual(scanned) })",
    ].join('\n')
    expect(ledgerShapedSymbols(assertedOnActualSide, true)).toEqual(['UNDEFINED_CLASS_SNAPSHOT'])

    // 集合但从没被等值断言——是语料 / 夹具，不是账本。去掉这一条约束的话，
    // 守卫目录内未登记的顶层集合会从 23 个涨到 143 个，豁免表会变得没法维护。
    const neverAsserted = [
      "const SCAN_ROOTS = ['packages/backend/src']",
      "test('x', () => { expect(SCAN_ROOTS.length).toBeGreaterThan(0) })",
    ].join('\n')
    expect(ledgerShapedSymbols(neverAsserted, true)).toEqual([])

    // 扫描累加器（空初始化 + push/add）是判据的**实际**侧，不是账本。
    const accumulator = [
      'const observedDebt: string[] = []',
      'for (const f of files) { observedDebt.push(f) }',
      "test('x', () => { expect(observedDebt).toEqual([...LEDGER]) })",
    ].join('\n')
    expect(
      ledgerShapedSymbols(accumulator, true),
      '把扫描累加器登记进只降不升的棘轮毫无意义——它每次跑出来的数都不同',
    ).toEqual([])
    // 但**故意留空的账本**要认出来（`ASSEMBLY_CALLS_IN_MOUNT` 就是 0 条、且「多一条 ⇒ 红」）。
    const intentionallyEmpty = [
      'const ASSEMBLY_CALLS_IN_MOUNT: readonly string[] = []',
      "test('x', () => { expect(scanned).toEqual([...ASSEMBLY_CALLS_IN_MOUNT]) })",
    ].join('\n')
    expect(ledgerShapedSymbols(intentionallyEmpty, true)).toEqual(['ASSEMBLY_CALLS_IN_MOUNT'])

    // 回归：名字只出现在**字符串字面量**里不算「被断言」。判据初稿用文本匹配时，
    // 本文件的 NOT_A_LEDGER 因为期望值里写着自己的名字而被误判成账本。
    const nameOnlyInsideStringLiteral = [
      'const OWNERS_TABLE = { a: 1 }',
      "test('x', () => { expect(keys).toEqual(['file.ts|OWNERS_TABLE']) })",
    ].join('\n')
    expect(ledgerShapedSymbols(nameOnlyInsideStringLiteral, true)).toEqual([])
  })

  /**
   * 判据 C 的自证。正例是那 13 处逃逸账本的**真实形状**（逐条对着源码抄下来的骨架），
   * 反例是同一批文件里、判据必须放过的夹具形状。两个方向都写死：只证「认得出」不算数
   * ——一条把所有集合都算成账本的判据也能通过那一半。
   */
  test('matcher 自证（判据 C）：目录外「拿仓库扫描结果对账」的集合算账本，夹具不算', () => {
    // ① 扫描累加器在实际侧、账本在期望侧（`rfc310-architecture-lock` 的形状）。
    //    名字完全不命中词汇表，判据 A 放过它。
    const scannedAgainstLedger = [
      "const SRC = resolve(import.meta.dir, '..', 'src')",
      "const COMPOSITION_CONSUMERS: string[] = ['cli/start.ts']",
      'function walk() { const out = []; for (const f of readdirSync(SRC)) out.push(f); return out }',
      "test('x', () => { expect(walk().sort()).toEqual(COMPOSITION_CONSUMERS) })",
    ].join('\n')
    expect(ledgerShapedSymbols(scannedAgainstLedger)).toEqual(['COMPOSITION_CONSUMERS'])

    // ② 下标赋值累加器 + **故意留空**的账本（`scheduler-audit-s10` 的形状）。
    //    `x[k] = v` 也是「声明之后又被塞了东西」——判据初版只认 `.push` 家族，漏了它。
    const indexAccumulator = [
      "const BACKEND_SRC = resolve(__dirname, '..', 'src')",
      'const RAW_TRANSACTION_SITES: Record<string, number> = {}',
      'const actual: Record<string, number> = {}',
      'for (const file of walkTsFiles(BACKEND_SRC)) { actual[file] = 1 }',
      "test('x', () => { expect(actual).toEqual(RAW_TRANSACTION_SITES) })",
    ].join('\n')
    expect(ledgerShapedSymbols(indexAccumulator)).toEqual(['RAW_TRANSACTION_SITES'])

    // ③ 锚点是 `import.meta.dirname`（前端 vitest 的写法，`rfc317-dead-class-invariants`）。
    //    meta 属性必须整体当一个名字认——拆成 `dirname` 就认不出锚点了。
    const viteAnchor = [
      "const SRC = resolve(import.meta.dirname, '..', 'src')",
      "const UNDEFINED_CLASS_SNAPSHOT: readonly string[] = ['btn-ghost']",
      'const undefined_ = classesIn(SRC)',
      "test('x', () => { expect(undefined_).toEqual([...UNDEFINED_CLASS_SNAPSHOT].sort()) })",
    ].join('\n')
    expect(ledgerShapedSymbols(viteAnchor)).toEqual(['UNDEFINED_CLASS_SNAPSHOT'])

    // —— 反例 ——

    // ④ 没有仓库锚点：断言的另一侧是被测函数对给定输入的输出。这是**绝大多数**测试的
    //    形状，误伤它等于逼着所有人给普通夹具改名。
    const unitFixture = [
      "const EXPECTED_ROWS = [{ id: 'a' }]",
      "test('x', () => { expect(project(input)).toEqual(EXPECTED_ROWS) })",
    ].join('\n')
    expect(
      ledgerShapedSymbols(unitFixture),
      '判据 C 认的是「另一侧取自仓库」，没有锚点就不该认',
    ).toEqual([])

    // ⑤ 有锚点，但账本侧是**一条领域记录**（裸标识符键 + 标量值），不是一批条目。
    //    `rfc339-wrapper-runtime-cutover` 的 `ok: NodeStepOutcome` 就是这个形状：
    //    同一个文件里确实在扫仓，夹具只是恰好跟扫描结果撞在同一条断言上。
    const recordFixtureInScanningFile = [
      "const ROOT = resolve(import.meta.dir, '..', '..')",
      "const ok = { kind: 'ok', summary: '', message: '' }",
      'const scanned = tsFilesUnder(ROOT)',
      "test('x', () => { expect(runOver(scanned)).toEqual(ok) })",
    ].join('\n')
    expect(
      ledgerShapedSymbols(recordFixtureInScanningFile),
      '一条领域记录不是账本——账本是一批同形条目',
    ).toEqual([])

    // ⑥ 有锚点、也是一批条目，但它自己就是扫描累加器（判据的**实际**侧）。
    const accumulatorInScanningFile = [
      "const ROOT = resolve(import.meta.dir, '..')",
      'const observed: string[] = []',
      'for (const f of readdirSync(ROOT)) observed.push(f)',
      "test('x', () => { expect(observed).toEqual([...LEDGER]) })",
    ].join('\n')
    expect(ledgerShapedSymbols(accumulatorInScanningFile)).toEqual([])

    // ⑦ 判据 C 只在目录外生效；目录内仍走更宽的 B（⑤ 在 B 眼里是账本）。
    expect(
      ledgerShapedSymbols(recordFixtureInScanningFile, true),
      '守卫目录内的口径不该被 C 收窄——C 是目录外的替代，不是全局的加严',
    ).toEqual(['ok'])
  })

  /**
   * 变异检查：把判据 C 的两条约束各自拆掉，自证必须变红。
   *
   * 这条是上面那批正 / 反例的「牙齿检查」——没有它，判据被人改松（比如哪天顺手把
   * 「一批同形条目」删了图省事）时上面的反例会静静地跟着放宽，而没有一处会红。
   */
  test('判据 C 的自证有牙齿：拆掉任一条约束，反例立刻被误判成账本', () => {
    const recordFixture = ts.createSourceFile(
      'x.ts',
      [
        "const ROOT = resolve(import.meta.dir, '..', '..')",
        "const ok = { kind: 'ok', summary: '', message: '' }",
        'const scanned = tsFilesUnder(ROOT)',
        "test('x', () => { expect(runOver(scanned)).toEqual(ok) })",
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    )
    const sides = equalitySides(recordFixture)
    const derived = repoDerivedNames(recordFixture)
    // 「另一侧取自仓库锚点」这一条本来就成立（`scanned` 由 ROOT 算出来）——
    // 所以放过 `ok` 的**唯一**理由是「一批同形条目」那一条。拆掉它就会误判。
    expect(
      sides.some((side) => [...side.actual].some((name) => derived.has(name))),
      '这条反例本来就踩中「另一侧来自仓库」，它被放过全靠 entryShaped',
    ).toBe(true)
    expect(
      isEntryCollection(
        (
          (recordFixture.statements[1] as ts.VariableStatement).declarationList
            .declarations[0] as ts.VariableDeclaration
        ).initializer as ts.Expression,
      ),
      '判据被改松了：裸标识符键 + 标量值的对象被当成了一批同形条目',
    ).toBe(false)

    // 反过来，「一批同形条目」单独也不够——没有锚点时它必须放过普通夹具。
    const noAnchor = ts.createSourceFile(
      'x.ts',
      ["const EXPECTED_ROWS = [{ id: 'a' }]", 'const actual = project(input)'].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    )
    expect(
      repoDerivedNames(noAnchor),
      '判据被改松了：没有任何仓库锚点的文件不该产出「来自仓库」的名字',
    ).toEqual(new Set())
  })
})

// 判据 A 的词汇表。RFC-317 T73 —— 补 `ALLOWANCE`：`rfc254-platform-surface-guard` 的
// 豁免表叫 `ALLOWANCES`，判据初版的词汇表漏了它，于是那份账本在覆盖规则眼里根本不存在。
// 这条漏词是在**往那张表里加条目时**才发现的——判据的词汇表本身也会有覆盖缺口。
//
// RFC-359 W7：**别再往这里加词**。加词只能补上已经发现的那一个漏，补不了下一个新名词；
// 守卫目录内改由不依赖命名的判据 B 兜底（见上面 T72 的规则说明）。
const LEDGER_NAME = /ALLOWLIST|ALLOWED_|ALLOWANCE|EXEMPT|KNOWN_VIOLATIONS|_HASHES|DEBT|PENDING_/

/** 判据 B 认的等值断言。`toMatchObject` 是部分匹配、不构成「存量快照」，不算。 */
const EQUALITY_MATCHER = /^(?:toEqual|toStrictEqual)$/

/** 会改动集合内容的方法。带这些调用的常量是**扫描累加器**，不是账本。 */
const MUTATING_METHOD = /^(?:push|unshift|splice|pop|shift|add|set|delete|clear)$/

/**
 * 判据 C 的**仓库锚点**：把「本文件在仓库里的位置」变成一条路径的那几种写法。
 *
 * 这不是一张 API 词汇表。它不枚举「怎么读仓库」（`readdirSync` / `listSourceFiles` /
 * `migrateSqlite` / `spawnSync('git', …)` …，那种表必然漏词，W7 收口时就漏过一个），
 * 只认「**从哪儿读起**」——一个测试要谈论仓库自己的存量，就必须先拿到仓库里的一条
 * 路径，而路径的起点只有这几种写法。
 */
const REPO_ANCHOR = /^(?:__dirname|__filename|import\.meta\.(?:dir|dirname|filename|path|url))$/

/**
 * 一段 AST 里引用到的名字。`import.meta.dir` 这类 meta 属性整体算**一个**名字
 * （否则 `dir` 会被拆成一个普通标识符，锚点就认不出来了）。
 */
function referencedNames(node: ts.Node | undefined): Set<string> {
  const names = new Set<string>()
  if (node === undefined) return names
  const visit = (current: ts.Node): void => {
    if (ts.isPropertyAccessExpression(current) && ts.isMetaProperty(current.expression)) {
      names.add(`import.meta.${current.name.text}`)
      return
    }
    if (ts.isIdentifier(current)) names.add(current.text)
    ts.forEachChild(current, visit)
  }
  visit(node)
  return names
}

/**
 * 「一批同形条目」而不是「一条记录」。
 *
 * 账本是**一批**条目的快照；夹具常常是**一条**领域记录（`{ kind: 'ok', summary: '',
 * message: '' }`）。数组 / Set / Map 天然是前者；对象字面量只有在**按数据键**（键是
 * 带引号的字符串，即键本身是数据：文件路径、class 名、族名）或**值本身还是集合**
 * （`{ insert: { 'cli/x.ts': 1 } }` 这种两层账本）时才算。键是裸标识符、值是标量的
 * 对象是一条记录。
 *
 * 空对象 / 空数组算集合：**故意留空的账本**（`RAW_TRANSACTION_SITES = {}`，「多一条
 * 就是红」）必须留在网内。
 */
function isEntryCollection(node: ts.Expression): boolean {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return isEntryCollection(node.expression)
  }
  if (ts.isParenthesizedExpression(node)) return isEntryCollection(node.expression)
  if (ts.isArrayLiteralExpression(node)) return true
  if (ts.isNewExpression(node)) return /\b(Set|Map)$/.test(node.expression.getText())
  if (!ts.isObjectLiteralExpression(node)) return false
  const assignments = node.properties.filter(ts.isPropertyAssignment)
  if (assignments.length === 0) return true
  const keyedByData = assignments.every(
    (property) => ts.isStringLiteral(property.name) || ts.isComputedPropertyName(property.name),
  )
  const nestsCollections = assignments.every((property) => isEntryCollection(property.initializer))
  return keyedByData || nestsCollections
}

/**
 * 值可能来自仓库锚点的名字，按声明与扫描累加器做一次不动点传播。
 *
 * 传播两种边：① `const x = <提到锚点的表达式>` / `function f() { …锚点… }` —— 声明沾上；
 * ② `x.push(…)` / `x[k] = …` 且**改动所在的作用域**里提到了锚点 —— 累加器沾上（扫描
 * 的典型写法就是「在遍历文件的循环里往累加器塞」，锚点不出现在 push 的实参上）。
 *
 * 纯文本判据：不解析 import、不碰磁盘，扫描与自证共用同一份实现。代价是**锚点住在
 * 被 import 的 helper 里**的守卫认不出来——那是漏，不是误判，与今天（目录外只有判据 A）
 * 相比不会更差。
 */
function repoDerivedNames(source: ts.SourceFile): Set<string> {
  const derived = new Set<string>()
  for (const name of referencedNames(source)) if (REPO_ANCHOR.test(name)) derived.add(name)
  const edges: { readonly name: string; readonly from: Set<string> }[] = []
  const visit = (node: ts.Node, scope: ts.Node): void => {
    // 作用域取「函数 / 循环**语句**」而不是 block：扫描的语料通常来自循环头
    // （`for (const f of walkTsFiles(SRC))`），只看 block 会把锚点漏在外面。
    const inner =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isIterationStatement(node, false)
        ? node
        : scope
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      edges.push({ name: node.name.text, from: referencedNames(node.initializer) })
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      edges.push({ name: node.name.text, from: referencedNames(node.body) })
    }
    if (isInPlaceMutation(node)) {
      edges.push({ name: mutationTarget(node), from: referencedNames(scope) })
    }
    ts.forEachChild(node, (child) => visit(child, inner))
  }
  visit(source, source)
  for (;;) {
    const before = derived.size
    for (const edge of edges) {
      if (derived.has(edge.name)) continue
      for (const from of edge.from) {
        if (derived.has(from)) {
          derived.add(edge.name)
          break
        }
      }
    }
    if (derived.size === before) return derived
  }
}

/** `x.push(…)` 家族，或 `x[k] = …` 下标赋值——两者都是「声明之后又被塞了东西」。 */
function isInPlaceMutation(node: ts.Node): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    MUTATING_METHOD.test(node.expression.name.text)
  ) {
    return true
  }
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isElementAccessExpression(node.left) &&
    ts.isIdentifier(node.left.expression)
  )
}

function mutationTarget(node: ts.Node): string {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    return (node.expression.expression as ts.Identifier).text
  }
  const binary = node as ts.BinaryExpression
  return ((binary.left as ts.ElementAccessExpression).expression as ts.Identifier).text
}

/** 每条等值断言的两侧各自引用到的名字（`expect(左).toEqual(右)`）。 */
function equalitySides(source: ts.SourceFile): { actual: Set<string>; expected: Set<string> }[] {
  const sides: { actual: Set<string>; expected: Set<string> }[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      EQUALITY_MATCHER.test(node.expression.name.text)
    ) {
      let subject: ts.Expression | undefined
      const findExpect = (current: ts.Node): void => {
        if (
          ts.isCallExpression(current) &&
          ts.isIdentifier(current.expression) &&
          current.expression.text === 'expect'
        ) {
          subject ??= current.arguments[0]
        }
        ts.forEachChild(current, findExpect)
      }
      findExpect(node.expression.expression)
      sides.push({
        actual: referencedNames(subject),
        expected: referencedNames(node.arguments[0]),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sides
}

/**
 * 声明之后被就地改动过的顶层常量名。
 *
 * 账本与扫描累加器在**形状**上分不开——两者都可能是 `const x: string[] = []`；分得开的是
 * **用法**：账本声明时就写全内容、此后一个字不动（改它就是一次有署名的销账），累加器则先空着
 * 再 `push` / `add` 进扫描结果。累加器是判据的**实际**侧，把它登记进只降不升的棘轮毫无意义
 * （它每次跑出来的数都不同）。实测本仓有 2 个这样的常量落进判据 B（`rfc359-w5-t20` 的
 * `observedDebt` / `unshimmed`），靠这一条机械排除，不必进具名豁免表。
 */
function mutatedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (isInPlaceMutation(node)) names.add(mutationTarget(node))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

/**
 * 一条 `expect(…).toEqual(…)` 里出现的**标识符**集合（两侧都取——账本既可能在期望侧
 * `toEqual([...LEDGER])`，也可能在实际侧 `expect(LEDGER).toEqual(…)`）。
 *
 * 取标识符而不是匹配源码文本：`[...LEDGER]` / `LEDGER.map(…)` / `new Set(LEDGER)` 都要认出来，
 * 而**字符串字面量里恰好含这个名字的不算**——本判据初稿用文本匹配时，
 * `expect(Object.keys(NOT_A_LEDGER)).toEqual(['…|NOT_A_LEDGER'])` 这种把自己的名字写进
 * 期望字符串的写法会被误判成「被断言」。
 */
function equalityAssertedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const collect = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text)
    ts.forEachChild(node, collect)
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      EQUALITY_MATCHER.test(node.expression.name.text)
    ) {
      collect(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

/**
 * 顶层集合常量里、判据 A ∪ B 认定为账本形状的那些。纯函数——扫描与自证共用。
 *
 * `inGuardDirectory` 决定第二条判据是 B 还是 C（见上面 T72 的规则说明）：
 * `tests/architecture/` 里被等值断言过的顶层集合常量一律算账本、**与名字无关**（B）；
 * 目录外那批文件同时是普通测试，改用更窄的 C——同一条断言的另一侧必须取自仓库锚点，
 * 且这一侧得是「一批同形条目」。两处都与判据 A 取并集。
 */
function ledgerShapedSymbols(text: string, inGuardDirectory = false): string[] {
  const source = ts.createSourceFile('ledger.ts', text, ts.ScriptTarget.Latest, true)
  const collections: { readonly name: string; readonly entryShaped: boolean }[] = []
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      const initializer = declaration.initializer
      if (initializer === undefined) continue
      if (!isCollectionInitializer(initializer)) continue
      collections.push({
        name: declaration.name.text,
        entryShaped: isEntryCollection(initializer),
      })
    }
  }
  const mutated = mutatedNames(source)
  if (inGuardDirectory) {
    const asserted = equalityAssertedNames(source)
    return collections
      .filter(({ name }) => LEDGER_NAME.test(name) || (asserted.has(name) && !mutated.has(name)))
      .map(({ name }) => name)
  }
  const derived = repoDerivedNames(source)
  const sides = equalitySides(source)
  const assertedAgainstRepoScan = (name: string): boolean =>
    sides.some(
      (side) =>
        (side.expected.has(name) &&
          [...side.actual].some((other) => other !== name && derived.has(other))) ||
        (side.actual.has(name) &&
          [...side.expected].some((other) => other !== name && derived.has(other))),
    )
  return collections
    .filter(
      ({ name, entryShaped }) =>
        LEDGER_NAME.test(name) ||
        (entryShaped && !mutated.has(name) && assertedAgainstRepoScan(name)),
    )
    .map(({ name }) => name)
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
        `[RFC-317 T17] 未做历史比对，原因：${PREVIOUS.kind}。` + '本轮只校验了「与源码逐字相等」。',
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
          (ledger.allowGrowth.why.trim().length < 20 || !/RFC-\d{3}/.test(ledger.allowGrowth.why)),
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
    source: 'const L: Record<string, number> = { a: 1, b: 2 }\n',
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

  const ruleNames = (): string[] =>
    [...CONFIG.matchAll(/^\s*name: '([a-z0-9-]+)',$/gm)].map((m) => m[1]!)

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
