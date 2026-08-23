// RFC-317 B0/T1 — 架构采数内核（可复跑，供守卫与报表共用同一份实现）。
//
// 为什么单独一个模块：R1（inbound）、R2（outbound）、R3（模块形状）三条规则的
// 判据必须与「生成债务账本时的判据」逐字相同，否则账本与守卫会各算各的，
// 出现「账本说 66、守卫扫出 71」这种无法归因的差。这里是唯一实现，守卫与
// `scripts/architecture-census.ts` 都从这里取。
//
// 边的解析口径直接沿用 `rfc294-architecture-preflight.test.ts` 的 `importEdges`：
// static import / `import type` / `export … from` / `import()` / `require()` 五种
// 形态全覆盖——这正是 dependency-cruiser 看不见的四种。
//
// 本模块**不含断言**，纯函数 + 文件系统读取，root 由调用方传入（不读 env，
// 避免再造一个 env 型 test seam）。

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { posix, relative, resolve } from 'node:path'

import ts from 'typescript'

export interface SourceUnit {
  readonly path: string
  readonly text: string
  readonly source: ts.SourceFile
}

export interface ModuleLocation {
  readonly context: string
  readonly rest: string
}

export type EdgeKind = 'type' | 'value'

export type EdgeSyntax = 'dynamic-import' | 'export' | 'import-type' | 'require' | 'static-import'

export interface ImportEdge {
  readonly from: SourceUnit
  readonly specifier: string
  readonly kind: EdgeKind
  readonly syntax: EdgeSyntax
}

/** RFC-294 §3.2 的受控 public 入口，exact 五个，不含别名。 */
export const PUBLIC_ENTRYPOINTS = [
  'commands',
  'events',
  'participants',
  'queries',
  'types',
] as const

/**
 * RFC-294 §2 的模块内层集合。`inbound` 是 RFC-317 D3 裁决新承认的入站适配层
 * （目标架构本就有 inbound adapter 概念，只是此前没给它目录名）。
 */
export const MODULE_TOP_LEVEL_ENTRIES = [
  'application',
  'composition',
  'composition.ts',
  'domain',
  'engine',
  'inbound',
  'infrastructure',
  'ports',
  'public',
] as const

/** 只有 bootstrap 可以指向模块的 `composition` 入口（RFC-294 §G1）。 */
export const BOOTSTRAP_FILES = [
  'packages/backend/src/cli/start.ts',
  'packages/backend/src/server.ts',
] as const

/** R2：模块的这几层不得反向依赖 legacy 横向层。`infrastructure` / `composition` 是适配层，另计。 */
export const FENCED_MODULE_LAYERS = ['application', 'domain', 'engine', 'public'] as const

/** R2 的禁止目标前缀（值级与类型级一并禁——类型也会泄漏内部形状）。 */
export const LEGACY_TARGET_PREFIXES = ['@/services/', '@/routes/', '@/ws/', '@/mcp/'] as const

/** R2 的禁止裸包（transport / ORM 不得出现在业务层）。 */
export const LEGACY_TARGET_PACKAGES = ['drizzle-orm', 'hono'] as const

/** R2 附加：domain 必须是纯的（RFC-294 §G1）。 */
export const DOMAIN_FORBIDDEN_PACKAGES = [
  'bun:sqlite',
  'node:child_process',
  'node:fs',
  'node:path',
  'node:process',
] as const

export function portable(path: string): string {
  return path.replaceAll('\\', '/')
}

export function sourceUnit(path: string, text: string): SourceUnit {
  const portablePath = portable(path)
  return {
    path: portablePath,
    text,
    source: ts.createSourceFile(
      portablePath,
      text,
      ts.ScriptTarget.Latest,
      true,
      portablePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  }
}

function walkTsFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) walkTsFiles(path, out)
    else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}

/**
 * `packages/backend/src` 下的全部生产源文件。
 *
 * 用 `readdirSync` 递归而不是 `git ls-files`：后者看不见未跟踪的新文件，会让
 * 本批新增的文件整批假绿（`docs/dev-gotchas.md` 记录的 RFC-311 T19 事故）。
 */
export function backendUnits(repoRoot: string): SourceUnit[] {
  return packageSrcUnits(repoRoot, 'backend')
}

/**
 * 任一 workspace 包 `src/` 下的全部生产源文件。
 *
 * 跨包语料是**必需的**，不是锦上添花：`shared/` 里的注册表可能只被 `frontend/`
 * 消费，只扫 backend 会把它误判成死表。同理只扫 shared 会漏掉 backend 侧的读点。
 */
export function packageSrcUnits(
  repoRoot: string,
  pkg: 'backend' | 'shared' | 'frontend',
): SourceUnit[] {
  const srcRoot = resolve(repoRoot, 'packages', pkg, 'src')
  return walkTsFiles(srcRoot, [])
    .sort()
    .map((path) => sourceUnit(portable(relative(repoRoot, path)), readFileSync(path, 'utf8')))
}

export function isModuleUnit(unit: SourceUnit): boolean {
  return unit.path.startsWith('packages/backend/src/modules/')
}

function withoutTsExtension(path: string): string {
  return path.replace(/\.[cm]?[jt]sx?$/, '')
}

export function moduleLocation(path: string): ModuleLocation | null {
  const normalized = withoutTsExtension(portable(path))
  const marker = '/modules/'
  const markerIndex = normalized.lastIndexOf(marker)
  const tail = markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized
  const parts = tail.split('/')
  if (parts.length < 2 || tail === normalized) return null
  return { context: parts[0]!, rest: parts.slice(1).join('/') }
}

function literalSpecifier(node: ts.Expression | ts.TypeNode): string | null {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) return node.literal.text
  return null
}

export function importEdges(unit: SourceUnit): ImportEdge[] {
  const edges: ImportEdge[] = []
  const add = (specifier: string, kind: EdgeKind, syntax: EdgeSyntax): void => {
    edges.push({ from: unit, specifier, kind, syntax })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause
      if (clause === undefined) {
        add(node.moduleSpecifier.text, 'value', 'static-import')
      } else {
        if (clause.name !== undefined) {
          add(node.moduleSpecifier.text, clause.isTypeOnly ? 'type' : 'value', 'static-import')
        }
        const bindings = clause.namedBindings
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          add(node.moduleSpecifier.text, clause.isTypeOnly ? 'type' : 'value', 'static-import')
        } else if (bindings !== undefined) {
          for (const element of bindings.elements) {
            add(
              node.moduleSpecifier.text,
              clause.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
              'static-import',
            )
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const specifier = literalSpecifier(node.moduleSpecifier)
      if (specifier !== null) {
        if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            add(specifier, node.isTypeOnly || element.isTypeOnly ? 'type' : 'value', 'export')
          }
        } else {
          add(specifier, node.isTypeOnly ? 'type' : 'value', 'export')
        }
      }
    } else if (ts.isImportTypeNode(node)) {
      const specifier = literalSpecifier(node.argument)
      if (specifier !== null) add(specifier, 'type', 'import-type')
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const specifier = literalSpecifier(node.arguments[0]!)
      if (specifier !== null) {
        add(
          specifier,
          'value',
          node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require',
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)

  const seen = new Set<string>()
  return edges.filter((edge) => {
    const key = `${edge.specifier}|${edge.kind}|${edge.syntax}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 边指向的模块位置；非模块目标返回 null。相对路径按 from 的目录解析。 */
export function targetModule(edge: ImportEdge): ModuleLocation | null {
  if (edge.specifier.startsWith('@/modules/')) {
    return moduleLocation(`/modules/${edge.specifier.slice('@/modules/'.length)}`)
  }
  if (!edge.specifier.startsWith('.')) return null
  return moduleLocation(posix.normalize(posix.join(posix.dirname(edge.from.path), edge.specifier)))
}

export interface BoundaryEdge {
  readonly rule: 'R1-inbound-module-internals' | 'R2-outbound-module-to-legacy'
  readonly from: string
  readonly to: string
  readonly specifier: string
  readonly edgeKind: EdgeKind
  readonly syntax: EdgeSyntax
  readonly context: string
  readonly layer: string
}

function firstSegment(rest: string): string {
  return rest.split('/')[0] ?? ''
}

/** `public/<entry>` 且 `<entry>` 是 exact 五入口之一 —— 允许；其余 public 子路径不算 exact。 */
function isExactPublicEntry(rest: string): boolean {
  const parts = rest.split('/')
  if (parts.length !== 2 || parts[0] !== 'public') return false
  const entry = withoutTsExtension(parts[1] ?? '')
  return (PUBLIC_ENTRYPOINTS as readonly string[]).includes(entry)
}

function isCompositionEntry(rest: string): boolean {
  return rest === 'composition' || rest.startsWith('composition/')
}

/** `@/modules/<ctx>` —— 指向模块根、没有任何子路径的裸导入。 */
const BARE_MODULE_ROOT = /^@\/modules\/([a-z0-9-]+)$/

/**
 * R1：`packages/backend/src` 下**非 module** 文件指向 module 内部的边。
 *
 * 允许：exact `public/{commands,queries,participants,events,types}`；
 * bootstrap（`server.ts` / `cli/start.ts`）可额外指向 `composition`。
 *
 * 裸模块根导入（`@/modules/foo`）单独判：`moduleLocation` 对它返回 null，若不显式
 * 兜住，它会成为**规则本身的结构性盲区**——将来谁给某个 context 加一个 `index.ts`
 * barrel，所有内部实现就能从那条边免检外流。今天全仓命中为 0，正好在零基线上封住。
 */
export function inboundBoundaryEdges(units: readonly SourceUnit[]): BoundaryEdge[] {
  const out: BoundaryEdge[] = []
  const bootstrap = new Set<string>(BOOTSTRAP_FILES)
  for (const unit of units) {
    if (isModuleUnit(unit)) continue
    for (const edge of importEdges(unit)) {
      const bare = BARE_MODULE_ROOT.exec(edge.specifier)
      if (bare !== null) {
        out.push({
          rule: 'R1-inbound-module-internals',
          from: unit.path,
          to: `modules/${bare[1]!}`,
          specifier: edge.specifier,
          edgeKind: edge.kind,
          syntax: edge.syntax,
          context: bare[1]!,
          layer: '<module-root>',
        })
        continue
      }
      const target = targetModule(edge)
      if (target === null) continue
      if (isExactPublicEntry(target.rest)) continue
      if (isCompositionEntry(target.rest) && bootstrap.has(unit.path)) continue
      out.push({
        rule: 'R1-inbound-module-internals',
        from: unit.path,
        to: `modules/${target.context}/${target.rest}`,
        specifier: edge.specifier,
        edgeKind: edge.kind,
        syntax: edge.syntax,
        context: target.context,
        layer: firstSegment(target.rest),
      })
    }
  }
  return out.sort((a, b) => `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`))
}

/** 模块文件所属的层：`modules/<ctx>/<layer>/…`，模块根文件的层就是文件名。 */
export function layerOf(unit: SourceUnit): { context: string; layer: string } | null {
  const location = moduleLocation(unit.path)
  if (location === null) return null
  const parts = location.rest.split('/')
  const layer = parts.length === 1 ? `${parts[0]!}.ts` : parts[0]!
  return { context: location.context, layer }
}

/** R2：模块的 domain/application/engine/public 层反向依赖 legacy 横向层的边。 */
export function outboundBoundaryEdges(units: readonly SourceUnit[]): BoundaryEdge[] {
  const fenced = new Set<string>(FENCED_MODULE_LAYERS)
  const out: BoundaryEdge[] = []
  for (const unit of units) {
    const place = layerOf(unit)
    if (place === null || !fenced.has(place.layer)) continue
    for (const edge of importEdges(unit)) {
      const spec = edge.specifier
      const hitsPrefix = LEGACY_TARGET_PREFIXES.some((prefix) => spec.startsWith(prefix))
      const hitsPackage = (LEGACY_TARGET_PACKAGES as readonly string[]).includes(spec)
      const hitsDomainPure =
        place.layer === 'domain' && (DOMAIN_FORBIDDEN_PACKAGES as readonly string[]).includes(spec)
      if (!hitsPrefix && !hitsPackage && !hitsDomainPure) continue
      out.push({
        rule: 'R2-outbound-module-to-legacy',
        from: unit.path,
        to: spec,
        specifier: spec,
        edgeKind: edge.kind,
        syntax: edge.syntax,
        context: place.context,
        layer: place.layer,
      })
    }
  }
  return out.sort((a, b) => `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`))
}

/**
 * 「架构守卫」的文件名判据。
 *
 * 单一事实源：`architecture/guard-manifest.json` 的生成器与钉死它的守卫都用这一个，
 * 否则两边各写一份正则、迟早出现「manifest 里有、扫描扫不到」的无法归因差。
 */
export const GUARD_FILE_NAME_PATTERN =
  /architecture|boundary|ratchet|lock|guard|invariants|preflight|callsite|extinction|interlock/

export const GUARD_TEST_DIRECTORIES = [
  'packages/backend/tests',
  'packages/frontend/tests',
  'packages/shared/tests',
] as const

/**
 * 磁盘上全部「架构守卫」测试文件。
 *
 * **必须递归**。初版只扫了三个 tests 目录的顶层，理由是「它们都是平铺的」——
 * 然后本 RFC 自己把第一个新守卫放进了 `tests/architecture/` 子目录，于是两向钉死
 * 结构上看不见它、却全绿。这正是 `docs/dev-gotchas.md` 那条自检要问的第二句
 * （「递归吗？」），写守卫的人当场踩了一次。判据按**文件名**匹配，与它躺在哪一层
 * 目录无关。
 */
export function guardTestFiles(repoRoot: string): string[] {
  const out: string[] = []
  const visit = (dir: string, rel: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const name = entry.name
      if (entry.isDirectory()) {
        if (name === 'node_modules' || name === 'fixtures' || name === '__snapshots__') continue
        visit(resolve(dir, name), `${rel}/${name}`)
        continue
      }
      if (!/\.test\.[cm]?tsx?$/.test(name)) continue
      // `tests/architecture/` 底下的每个测试都是守卫——**目录本身就是声明**，不必再
      // 在文件名里重复一遍。这条是被自己坑出来的：RFC-317 T16 的
      // `rfc317-ledger-highwater.test.ts` 放在该目录下，名字里却没有 guard/lock/
      // ratchet 任一关键词，于是**没进清单**——一条崭新的守卫从第一天起就可以被静默
      // 删除，而两向钉死那条断言照绿（磁盘侧与清单侧同时看不见它）。
      const inGuardDirectory = rel.endsWith('/architecture')
      if (!inGuardDirectory && !GUARD_FILE_NAME_PATTERN.test(name)) continue
      out.push(`${rel}/${name}`)
    }
  }
  for (const dir of GUARD_TEST_DIRECTORIES) visit(resolve(repoRoot, dir), dir)
  return out.sort()
}

export interface ModuleShape {
  readonly context: string
  readonly topLevelEntries: readonly string[]
  readonly unexpectedEntries: readonly string[]
  readonly publicEntries: readonly string[]
  readonly nonExactPublicEntries: readonly string[]
  readonly fileCount: number
}

/**
 * R3：逐 context 的形状。
 *
 * subject 由 `readdirSync(modules/)` **派生**而非硬编码——硬编码正是
 * `rfc310-architecture-lock.test.ts:27` 只覆盖一个模块的成因。目录缺失时
 * `readdirSync` 会抛，这是刻意的：吞掉 ENOENT 会让规则在模块改名后静默变绿
 * （`findings.md` G-10）。
 */
export function moduleShapes(repoRoot: string): ModuleShape[] {
  const modulesRoot = resolve(repoRoot, 'packages', 'backend', 'src', 'modules')
  const allowed = new Set<string>(MODULE_TOP_LEVEL_ENTRIES)
  const exact = new Set<string>(PUBLIC_ENTRYPOINTS)
  return readdirSync(modulesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((context) => {
      const contextRoot = resolve(modulesRoot, context)
      const topLevelEntries = readdirSync(contextRoot).sort()
      const publicRoot = resolve(contextRoot, 'public')
      let publicEntries: string[] = []
      try {
        if (statSync(publicRoot).isDirectory()) publicEntries = readdirSync(publicRoot).sort()
      } catch {
        publicEntries = []
      }
      return {
        context,
        topLevelEntries,
        unexpectedEntries: topLevelEntries.filter((name) => !allowed.has(name)),
        publicEntries,
        nonExactPublicEntries: publicEntries.filter(
          (name) => !exact.has(withoutTsExtension(name)) || !/\.[cm]?tsx?$/.test(name),
        ),
        fileCount: walkTsFiles(contextRoot, []).length,
      }
    })
}

// ---------------------------------------------------------------------------
// 守卫自检采数（RFC-317 B2 / T13 / T21 · findings G-07 · CC-07）
// ---------------------------------------------------------------------------
//
// 源码扫描型守卫有一个**静默**失效面：扫描根写错、walk 提前 return、后缀过滤把
// 语料筛成空——此时「违规集合为空」与「合规」在断言层面**完全同形**，守卫绿得
// 毫无信息量。G-07 已实测到 rfc294 / rfc305 / rfc284 / ux-source-ratchets 这四条
// 最吃重的 ratchet 一条语料下限都没有。
//
// 这里只做**采数**：判定「谁在扫语料」以及「它自己声明的语料下限是多少」。
// 断言留给 rfc317-guard-corpus-floor.test.ts，且两者共用这一份实现——否则又是
// 「账本一套判据、守卫另一套判据」。

/** 文件枚举 API：出现其一即认为该守卫在扫语料，而非读固定几个文件。 */
const CORPUS_ENUMERATION_CALLEES = new Set([
  'readdirSync',
  'readdir',
  'opendirSync',
  'globSync',
  'guardTestFiles',
  'backendUnits',
  'packageSrcUnits',
  'moduleShapes',
])


function calleeName(node: ts.CallExpression): string | null {
  const target = node.expression
  if (ts.isIdentifier(target)) return target.text
  if (ts.isPropertyAccessExpression(target)) return target.name.text
  return null
}

/**
 * 该守卫是否在枚举文件语料。
 *
 * 判据是 **AST 调用名**而非文本——注释里提到 `readdirSync`、字符串里出现
 * `'globSync'` 都不算，避免 dev-gotchas 记过的「正向检查被注释满足」。
 */
export function isCorpusScanner(unit: SourceUnit): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      if (name !== null && CORPUS_ENUMERATION_CALLEES.has(name)) {
        found = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return found
}

/**
 * 守卫自己声明的语料下限：`expect(<…length>).toBeGreaterThan(n)` 记 `n + 1`、
 * `.toBeGreaterThanOrEqual(n)` / `.toBe(n)` 记 `n`；同一文件多条取**最大**。
 *
 * 取最大而非最小：一个文件里可能既有「语料 ≥ 200」也有「某子集 ≥ 1」，前者才是
 * 「扫描器还活着」的证据强度，账本要钉死的也是它。
 */
export function corpusFloor(unit: SourceUnit): number | null {
  const topLevel = topLevelFacts(unit.source, CORPUS_ENUMERATION_CALLEES, 'references')
  let floor: number | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const matcher = node.expression.name.text
      const argument = node.arguments[0]
      if (
        (matcher === 'toBeGreaterThan' ||
          matcher === 'toBeGreaterThanOrEqual' ||
          matcher === 'toBe') &&
        argument !== undefined &&
        ts.isNumericLiteral(argument)
      ) {
        const measured = measuredCorpusSize(node.expression.expression, topLevel)
        if (measured) {
          const value = Number(argument.text) + (matcher === 'toBeGreaterThan' ? 1 : 0)
          if (value >= 1 && (floor === null || value > floor)) floor = value
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return floor
}

/**
 * 这个 `expect(…)` 量的是**语料规模**吗？
 *
 * 判据分两半，缺一不可：
 *   ① 被度量的表达式以 `.length` / `.size` 收尾——它在数东西；
 *   ② 被数的那个东西**能追溯到文件枚举**（`readdirSync` / `globSync` /
 *      `guardTestFiles` / `backendUnits` / `moduleShapes`，含经由自定义
 *      `walk()` 之类的传递）。
 *
 * 第二半是被实测逼出来的。上一版只有第一半（一条 `/\.(?:length|size)\b/` 正则打在
 * 接收者文本上），于是 `rfc310-digital-employee-os-architecture` 里的
 * `expect(entry.owner.length).toBeGreaterThan(20)`——**一句「manifest 里的 owner
 * 描述别写得太敷衍」的字符串长度断言**——被记成了「该守卫声明了 21 个文件的语料下限」，
 * 而它其实一条语料下限都没有。账本里于是躺着一个**没有任何东西在校验的数字**，
 * 却长得和真下限一模一样：这正是 T13 要防的假绿，只不过发生在守卫的守卫自己身上。
 *
 * 种子刻意用 `CORPUS_ENUMERATION_CALLEES` 而非 `CORPUS_PRODUCING_CALLEES`：后者含
 * `readFileSync`，而 `JSON.parse(readFileSync(manifest))` 出来的是**一份账本**，不是
 * 语料；用它当种子的话上面那条误判照样成立（`entry` 会经 `manifest` 被判成语料）。
 * 「语料下限」量的是**扫了多少个文件**，所以只有枚举才是它的源头。
 */
function measuredCorpusSize(expectCall: ts.Node, topLevel: TopLevelFacts): boolean {
  if (!ts.isCallExpression(expectCall)) return false
  if (!ts.isIdentifier(expectCall.expression) || expectCall.expression.text !== 'expect') {
    return false
  }
  const measured = expectCall.arguments[0]
  if (measured === undefined) return false

  // 「在数东西」：子树里出现 `.length` / `.size`。**不能**要求顶层节点就是属性访问——
  // 仓里最常见的语料下限写法是把两个根加起来（`expect(walk(BACKEND).length +
  // walk(SHARED).length)`，见 rfc070 / rfc222 / rfc305），顶层是个 `+`。
  let counts = false
  const findCount = (child: ts.Node): void => {
    if (counts) return
    if (
      ts.isPropertyAccessExpression(child) &&
      (child.name.text === 'length' || child.name.text === 'size')
    ) {
      counts = true
      return
    }
    ts.forEachChild(child, findCount)
  }
  findCount(measured)
  if (!counts && !isPlainCounterReference(measured)) return false

  const scope = scopeFacts(expectCall, topLevel, CORPUS_ENUMERATION_CALLEES)
  const accumulators = new Set([
    ...enumerationAccumulators(expectCall, scope.corpus),
    ...enumerationCounters(expectCall, scope.corpus),
  ])
  let derived = false
  const visit = (child: ts.Node): void => {
    if (derived) return
    if (ts.isCallExpression(child)) {
      const target = child.expression
      const callee = ts.isIdentifier(target)
        ? target.text
        : ts.isPropertyAccessExpression(target)
          ? target.name.text
          : null
      if (callee !== null && CORPUS_ENUMERATION_CALLEES.has(callee)) {
        derived = true
        return
      }
    }
    if (ts.isIdentifier(child) && (scope.corpus.has(child.text) || accumulators.has(child.text))) {
      derived = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(measured)
  return derived
}

/** `expect(scanned)` 这种「光秃秃一个名字」——是否要走计数器那条判据。 */
function isPlainCounterReference(measured: ts.Node): boolean {
  return ts.isIdentifier(measured)
}

/**
 * 「逐文件自增计数器」形态的语料规模。
 *
 * `rfc311-perf-guards` 不持有文件数组，它在 `walk()` 里 `scanned += 1`，然后
 * `expect(scanned).toBeGreaterThan(200)`。这条下限是真的——扫描根一失效 `scanned`
 * 就是 0、断言立刻红——只是它身上没有 `.length` 可抓。
 *
 * 判据：`let x = <数字字面量>`，且 `x` 在某个**枚举语料的函数体 / 循环体**内被自增。
 * 「枚举语料」沿用同一份判据（子树里有枚举 callee 或语料名字），所以这里不会把一个
 * 与语料无关的普通计数器算进来。
 */
function enumerationCounters(node: ts.Node, corpus: ReadonlySet<string>): ReadonlySet<string> {
  const numeric = new Set<string>()
  const roots: ts.Node[] = []
  let current: ts.Node | undefined = node
  while (current !== undefined) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      roots.push(current)
      for (const statement of current.statements) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer !== undefined &&
            ts.isNumericLiteral(declaration.initializer)
          ) {
            numeric.add(declaration.name.text)
          }
        }
      }
    }
    current = current.parent
  }
  if (numeric.size === 0) return numeric

  const enumerating = (subtree: ts.Node): boolean => {
    let hit = false
    const visit = (child: ts.Node): void => {
      if (hit) return
      if (ts.isCallExpression(child)) {
        const target = child.expression
        const callee = ts.isIdentifier(target)
          ? target.text
          : ts.isPropertyAccessExpression(target)
            ? target.name.text
            : null
        if (callee !== null && CORPUS_ENUMERATION_CALLEES.has(callee)) {
          hit = true
          return
        }
      }
      if (ts.isIdentifier(child) && corpus.has(child.text)) {
        hit = true
        return
      }
      ts.forEachChild(child, visit)
    }
    visit(subtree)
    return hit
  }

  const incremented = new Set<string>()
  const scan = (child: ts.Node): void => {
    const bumped =
      ts.isPostfixUnaryExpression(child) || ts.isPrefixUnaryExpression(child)
        ? child.operand
        : ts.isBinaryExpression(child) &&
            child.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
          ? child.left
          : undefined
    if (bumped !== undefined && ts.isIdentifier(bumped) && numeric.has(bumped.text)) {
      let owner: ts.Node | undefined = child.parent
      while (owner !== undefined) {
        if (
          ts.isFunctionDeclaration(owner) ||
          ts.isFunctionExpression(owner) ||
          ts.isArrowFunction(owner) ||
          ts.isForOfStatement(owner) ||
          ts.isForInStatement(owner) ||
          ts.isForStatement(owner)
        ) {
          if (enumerating(owner)) {
            incremented.add(bumped.text)
            break
          }
        }
        owner = owner.parent
      }
    }
    ts.forEachChild(child, scan)
  }
  for (const root of roots) scan(root)
  return incremented
}

/**
 * 「出参累加器」形态的语料持有者。
 *
 * `rfc254-file-url-pathname-guard` 的写法是
 * `const files: string[] = []` + `walk(BACKEND_SRC, files)` + `expect(files.length)…`：
 * `files` 的**初始化式是空数组字面量**，赋值发生在 `walk` 内部，所以按初始化式传播的
 * 那套（`scopeFacts`）看不见它——一条 500 的真下限会被判成没有下限。
 *
 * 判据刻意收窄到「初始化式恰好是 `[]`，且该名字被当作实参传给了一个枚举语料的函数」。
 * 不放宽成「凡是传给枚举函数的实参都算」：那样 `walk(dir, out)` 里的 `dir`（一个路径
 * 字符串）也会被算成语料，于是 `expect(dir.length)` 这种字符串长度断言又会被记成语料
 * 下限——正是本判据要修的那类错，只是换了个入口。
 */
function enumerationAccumulators(node: ts.Node, corpus: ReadonlySet<string>): ReadonlySet<string> {
  const empties = new Set<string>()
  let current: ts.Node | undefined = node
  const roots: ts.Node[] = []
  while (current !== undefined) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      roots.push(current)
      for (const statement of current.statements) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer !== undefined &&
            ts.isArrayLiteralExpression(declaration.initializer) &&
            declaration.initializer.elements.length === 0
          ) {
            empties.add(declaration.name.text)
          }
        }
      }
    }
    current = current.parent
  }
  if (empties.size === 0) return empties

  const filled = new Set<string>()
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) {
      const target = child.expression
      const callee = ts.isIdentifier(target) ? target.text : null
      if (callee !== null && (corpus.has(callee) || CORPUS_ENUMERATION_CALLEES.has(callee))) {
        for (const argument of child.arguments) {
          if (ts.isIdentifier(argument) && empties.has(argument.text)) filled.add(argument.text)
        }
      }
    }
    ts.forEachChild(child, visit)
  }
  for (const root of roots) visit(root)
  return filled
}

// ---------------------------------------------------------------------------
// 负 fixture 采数（RFC-317 B2 / T14 · findings G-07）
// ---------------------------------------------------------------------------
//
// 语料下限（上一节）挡住的是「扫了个寂寞」；这一节挡的是另一半：**语料还在，但
// matcher 已经不咬了**。正则被重排、生产代码换了写法、AST 判据漏掉一种语法形态——
// 违规集合同样回到空，同样与「合规」同形。
//
// G-07 的原话是「三条 ratchet 在散文里声称做过变异实证，但仓里没有一条今天还能
// 复跑的 fixture」。散文不是证据：**能复跑的证据是把一段伪造的违规源码喂给守卫
// 自己的 matcher，并断言它确实报**。
//
// 判定一条断言是不是「负 fixture」，要同时满足三件事：
//   ① 断言引用了本文件顶层声明的 **matcher**（非语料产出者）；
//   ② 断言的主体是一段**伪造的源码字面量**（内联、或同 test 体 / 顶层的 const），
//      而不是一条指向真实树的路径——`'packages/backend/src/x.ts'` 不算；
//   ③ 断言**不引用语料**。引用了语料就说明它在断言真实树的现状，那是规则本身，
//      不是「matcher 还咬得动」的证据。
//
// 三条缺一不可。只要①②会把 `countOccurrences(SCHEDULER_SRC, FORK_MARKER)` 这类
// 「拿真实源码 + 一个 needle 常量」的断言误判成 fixture（实测撞到两处）。

/** 触及文件系统的调用名：其（传递）调用者被视为**语料产出者**。 */
const CORPUS_PRODUCING_CALLEES = new Set([
  'readdirSync',
  'readdir',
  'opendirSync',
  'globSync',
  'guardTestFiles',
  'backendUnits',
  'moduleShapes',
  'readFileSync',
  'readFile',
  'existsSync',
  'statSync',
])

/** 「像一段源码」而不是「像一条路径」。 */
const CODE_SHAPED = /[(){};]|=>|\s=\s|\n|import |export |function |const /
const PURE_PATH_LIKE = /^[\w./@*-]+$/

/** 伪造的**文件名**输入：判据本身以文件名为主体时，fixture 喂的就是文件名。 */
const FABRICATED_FILE_NAME = /\.(?:test|spec)\.[cm]?tsx?$|\.(?:ts|tsx|css|sql|json)$/

function isFabricatedSource(text: string): boolean {
  if (text.length < 8) return false
  if (FABRICATED_FILE_NAME.test(text)) return true
  return !PURE_PATH_LIKE.test(text) && CODE_SHAPED.test(text)
}

function containsFabricatedSource(node: ts.Node): boolean {
  let found = false
  const visit = (child: ts.Node): void => {
    if (found) return
    if (
      (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) &&
      isFabricatedSource(child.text)
    ) {
      found = true
      return
    }
    if (ts.isTemplateExpression(child)) {
      const joined =
        child.head.text + child.templateSpans.map((span) => span.literal.text).join(' ')
      if (isFabricatedSource(joined)) {
        found = true
        return
      }
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

interface TopLevelFacts {
  /** 语料产出者：（传递）调用了文件系统枚举 / 读取。 */
  readonly corpus: ReadonlySet<string>
  /** 候选 matcher：顶层声明且不产出语料。 */
  readonly matcher: ReadonlySet<string>
  /** fixture 载体：初始化式里含伪造源码字面量。 */
  readonly carrier: ReadonlySet<string>
}

/**
 * 传播深度。两个用途要的深度**不同**，混用会互相拆台：
 *
 * - `'calls'`（负 fixture 用）——只跟随**被调用的名字**。要判的是「这条断言的
 *   **输入**是不是伪造的」；一个 matcher 内部查了张从真实注册表派生的表，它**仍然
 *   是 matcher**。把它算成「碰了语料」会把合格的 fixture 判成不合格（实测：
 *   rfc317-identity-dispatch / rfc287-t9 / tasks-list-scroll-boundary 三条全被误杀，
 *   它们喂的都是伪造源码字面量）。
 * - `'references'`（语料下限用）——连普通标识符引用一起跟随。要判的是「这个量会不会
 *   **随语料一起塌掉**」，那么 `function callsitesOf(v) { return allFiles.filter(…) }`
 *   里对 `allFiles` 的**引用**（非调用）就必须算数，否则 btn-variants-callsite 那条
 *   语料一空就必红的真下限会被判成没有下限。
 */
type CorpusReach = 'calls' | 'references'

function topLevelFacts(
  source: ts.SourceFile,
  seeds: ReadonlySet<string>,
  reach: CorpusReach,
): TopLevelFacts {
  const declarations = new Map<string, ts.Node>()
  // 被 import 进来的名字同样是候选 matcher——而且是**最好的**那种：判据抽进非 test
  // 模块（如本文件）后，守卫与「守卫的守卫」才能各自 import 同一份实现。漏掉这一支
  // 会把最规范的写法判成「没有 fixture」（实测把本 RFC 自己的 T21 判成缺）。
  const imported = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) imported.add(element.name.text)
    }
    if (statement.importClause?.name !== undefined) imported.add(statement.importClause.name.text)
  }
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      declarations.set(statement.name.text, statement)
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          declarations.set(declaration.name.text, declaration.initializer)
        }
      }
    }
  }
  const producesCorpus = (node: ts.Node, seen: Set<string>): boolean => {
    let hit = false
    const visit = (child: ts.Node): void => {
      if (hit) return
      if (ts.isCallExpression(child)) {
        const target = child.expression
        const name = ts.isIdentifier(target)
          ? target.text
          : ts.isPropertyAccessExpression(target)
            ? target.name.text
            : null
        if (name !== null) {
          if (seeds.has(name)) {
            hit = true
            return
          }
          const referenced = declarations.get(name)
          if (referenced !== undefined && !seen.has(name)) {
            seen.add(name)
            if (producesCorpus(referenced, seen)) {
              hit = true
              return
            }
          }
        }
      }
      // 见 CorpusReach：只有 'references' 深度才跟随普通标识符引用。
      if (reach === 'references' && ts.isIdentifier(child)) {
        const referenced = declarations.get(child.text)
        if (referenced !== undefined && !seen.has(child.text)) {
          seen.add(child.text)
          if (producesCorpus(referenced, seen)) {
            hit = true
            return
          }
        }
      }
      ts.forEachChild(child, visit)
    }
    visit(node)
    return hit
  }
  const corpus = new Set<string>()
  const matcher = new Set<string>()
  const carrier = new Set<string>()
  for (const [name, node] of declarations) {
    if (producesCorpus(node, new Set([name]))) corpus.add(name)
    else matcher.add(name)
    if (containsFabricatedSource(node)) carrier.add(name)
  }
  for (const name of imported) {
    if (declarations.has(name)) continue
    if (seeds.has(name)) corpus.add(name)
    else matcher.add(name)
  }
  return { corpus, matcher, carrier }
}

interface ScopeFacts {
  /** 作用域链上声明的、含伪造输入字面量的名字（fixture 载体）。 */
  readonly carriers: ReadonlySet<string>
  /** 作用域链上声明的、（传递）来自真实语料的名字。 */
  readonly corpus: ReadonlySet<string>
}

/**
 * 从断言处向外走完整作用域链，分出「伪造输入」与「真实语料」两类名字。
 *
 * 这里做到**局部**变量而不只是顶层声明，是被实测逼出来的。判据前三版都只看顶层：
 *   - 只认紧邻 test 块的 const ⇒ 把 describe 作用域共享的 fixture 判成没有；
 *   - 只把顶层名字算作语料 ⇒ `const offenders = files.filter((f) =>
 *     readFileSync(f).includes('function describeError('))` 里的 `offenders`
 *     被当成 fixture 载体（它的初始化式里确实有一段「像源码」的字面量），于是
 *     `expect(offenders).toEqual([])`——一条彻头彻尾的**规则**断言——被记成了
 *     「这条守卫有负 fixture」。
 * 第二种错的方向最坏：它让本来缺 fixture 的守卫凭空达标，判据于是自己变成假绿源。
 *
 * 语料的传播要跑到不动点：`files → offenders → filtered` 这种链条上，只看一跳会漏。
 */
function scopeFacts(
  node: ts.Node,
  topLevel: TopLevelFacts,
  seeds: ReadonlySet<string>,
): ScopeFacts {
  const initializers = new Map<string, ts.Node>()
  const forOfBindings = new Map<string, ts.Node>()
  let current: ts.Node | undefined = node
  while (current !== undefined) {
    if (ts.isForOfStatement(current) && ts.isVariableDeclarationList(current.initializer)) {
      for (const declaration of current.initializer.declarations) {
        if (ts.isIdentifier(declaration.name)) forOfBindings.set(declaration.name.text, current.expression)
      }
    }
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      for (const statement of current.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
              initializers.set(declaration.name.text, declaration.initializer)
            }
          }
        }
      }
    }
    current = current.parent
  }
  for (const [name, iterable] of forOfBindings) initializers.set(name, iterable)

  const corpus = new Set<string>(topLevel.corpus)
  let grew = true
  while (grew) {
    grew = false
    for (const [name, initializer] of initializers) {
      if (corpus.has(name)) continue
      let derived = false
      const visit = (child: ts.Node): void => {
        if (derived) return
        if (ts.isCallExpression(child)) {
          const target = child.expression
          const callee = ts.isIdentifier(target)
            ? target.text
            : ts.isPropertyAccessExpression(target)
              ? target.name.text
              : null
          if (callee !== null && seeds.has(callee)) {
            derived = true
            return
          }
        }
        if (ts.isIdentifier(child) && corpus.has(child.text)) {
          derived = true
          return
        }
        ts.forEachChild(child, visit)
      }
      visit(initializer)
      if (derived) {
        corpus.add(name)
        grew = true
      }
    }
  }

  const carriers = new Set<string>()
  for (const [name, initializer] of initializers) {
    if (corpus.has(name)) continue
    if (containsFabricatedSource(initializer)) carriers.add(name)
  }
  return { carriers, corpus }
}

/**
 * 本守卫里「把伪造输入喂给某个决定过程、且完全不碰真实语料」的断言列表。
 *
 * 判据刻意**不**要求断言里语法上出现某个具名 matcher。要求过三版，每版都把本 RFC
 * 自己刚写的合格 fixture 判成不合格（matcher 藏在局部 `probe()` 里、藏在 describe
 * 作用域的 helper 里、藏在 `Object.fromEntries` 外壳下）。真正把 fixture 与「规则
 * 本身」分开的是另外两件事：**喂的是伪造输入**，且**一点真实语料都不碰**。碰了语料
 * 就是在断言现状——那是规则，不是「决定过程还工作」的证据。
 */
export function negativeFixtureAssertions(unit: SourceUnit): string[] {
  const source = unit.source
  const topLevel = topLevelFacts(source, CORPUS_PRODUCING_CALLEES, 'calls')
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'expect' &&
      node.arguments[0] !== undefined
    ) {
      const subject = node.arguments[0]
      const scope = scopeFacts(node, topLevel, CORPUS_PRODUCING_CALLEES)
      let fabricated = containsFabricatedSource(subject)
      let touchesCorpus = false
      const walk = (child: ts.Node): void => {
        if (ts.isIdentifier(child)) {
          if (scope.corpus.has(child.text)) touchesCorpus = true
          if (scope.carriers.has(child.text) || topLevel.carrier.has(child.text)) fabricated = true
        }
        if (ts.isCallExpression(child)) {
          const target = child.expression
          const callee = ts.isIdentifier(target)
            ? target.text
            : ts.isPropertyAccessExpression(target)
              ? target.name.text
              : null
          if (callee !== null && CORPUS_PRODUCING_CALLEES.has(callee)) touchesCorpus = true
        }
        ts.forEachChild(child, walk)
      }
      walk(subject)
      if (fabricated && !touchesCorpus) {
        found.push(subject.getText(source).slice(0, 100).replace(/\s+/g, ' '))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * 该守卫是否存在「对语料断言**不存在**」的检查。
 *
 * 只有断言不存在的守卫才有「静默零违规」这个失效面：`toEqual([])` 在「真的没有」
 * 与「根本没扫到」之间不可分辨。断言**存在**的守卫（`expect(sites.length)
 * .toBeGreaterThanOrEqual(4)`）自带证明——扫描一旦失效它立刻转红，再要求它配一条
 * 负 fixture 就是纯仪式。判据窄一点、但每条都必要，比宽而掺水更耐用。
 */
const ABSENCE_MATCHERS = new Set([
  'toEqual',
  'toStrictEqual',
  'toHaveLength',
  'toBe',
  'toMatch',
  'toContain',
  'toContainEqual',
])

function isEmptyExpectation(node: ts.CallExpression, matcher: string, negated: boolean): boolean {
  const argument = node.arguments[0]
  if (negated) return matcher === 'toMatch' || matcher === 'toContain' || matcher === 'toContainEqual'
  if (matcher === 'toEqual' || matcher === 'toStrictEqual') {
    return argument !== undefined && ts.isArrayLiteralExpression(argument) && argument.elements.length === 0
  }
  if (matcher === 'toHaveLength' || matcher === 'toBe') {
    return argument !== undefined && ts.isNumericLiteral(argument) && argument.text === '0'
  }
  return false
}

export function assertsAbsence(unit: SourceUnit): boolean {
  const source = unit.source
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const matcher = node.expression.name.text
      if (ABSENCE_MATCHERS.has(matcher)) {
        let receiver = node.expression.expression
        let negated = false
        if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'not') {
          negated = true
          receiver = receiver.expression
        }
        if (
          ts.isCallExpression(receiver) &&
          ts.isIdentifier(receiver.expression) &&
          receiver.expression.text === 'expect' &&
          receiver.arguments[0] !== undefined &&
          isEmptyExpectation(node, matcher, negated)
        ) {
          // 不再要求断言主体**语法上**引用语料：真实写法里违规集合几乎总是先收进一个
          // 局部 `violations` 再断言（`expect(violations).toEqual([])`）。初版加了这条
          // 限制，于是把 rfc148 这类标准灭绝守卫判成「不断言不存在」而豁免掉——判据
          // 比现实窄，豁免面就会悄悄变大。文件本身已经是扫语料型，这里只问它有没有
          // 「不存在」形态的断言。
          found = true
          return
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

// ---------------------------------------------------------------------------
// 账本清点（RFC-317 B2-c / T16 · findings CC-06 / CC-03）
// ---------------------------------------------------------------------------
//
// 本仓的「已知违规 / 豁免」账本散在九处，形态各异：数组、对象、`new Set([...])`、
// `new Map([...])`、`Record<string, …>`。它们各自都有精确相等或 stale 检测，但
// **没有任何地方看得见账本整体在长**——每加一条只是 diff 里多两行，没有一个数字会变。
//
// 这里只做清点：从**源码文本**按符号名数出条目数。取文本而非 import，是因为高水位
// 棘轮要拿 `git show HEAD~1:<file>` 的历史版本用同一把尺子量。

/**
 * 一个展开元素静态贡献多少条目。
 *
 * `...ARRAY.map(fn)` 贡献的条数等于 `ARRAY` 的长度——这是本仓账本里真实存在的写法
 * （`scripts/depcheck.ts` 的 KNOWN_VIOLATIONS 有两处）。**不处理展开是危险的**：
 * 只数语法元素的话，KNOWN_VIOLATIONS 是 20，运行时却是 35；其中一个展开从 15 条
 * 涨到 30 条时，那个 20 纹丝不动——正好是本棘轮要堵的那条静默增长通路。
 *
 * 数不出来就返回 null，让调用方红，绝不编一个数出来。
 */
function spreadContribution(node: ts.SpreadElement): number | null {
  let expression: ts.Expression = node.expression
  // `...(X).map(fn)` / `...(X as const).map(fn)`
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    (expression.expression.name.text === 'map' || expression.expression.name.text === 'flatMap')
  ) {
    expression = expression.expression.expression
  }
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    expression = ts.isParenthesizedExpression(expression) ? expression.expression : expression.expression
  }
  return ts.isArrayLiteralExpression(expression) ? expression.elements.length : null
}

/** 能被清点的账本容器形态。 */
function ledgerElementCount(node: ts.Node): number | null {
  if (ts.isArrayLiteralExpression(node)) {
    let total = 0
    for (const element of node.elements) {
      if (!ts.isSpreadElement(element)) {
        total += 1
        continue
      }
      const contributed = spreadContribution(element)
      if (contributed === null) return null
      total += contributed
    }
    return total
  }
  if (ts.isObjectLiteralExpression(node)) return node.properties.length
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return ledgerElementCount(node.expression)
  }
  if (ts.isParenthesizedExpression(node)) return ledgerElementCount(node.expression)
  if (ts.isNewExpression(node)) {
    // new Set([...]) / new Map([...])
    const argument = node.arguments?.[0]
    return argument === undefined ? null : ledgerElementCount(argument)
  }
  return null
}

/**
 * 数出某份源码里名为 `symbol` 的账本有多少条目；找不到该符号返回 `null`。
 *
 * 返回 `null` 而不是 0 很重要：符号被改名 / 删除时，0 会被当成「账本清空了，真棒」，
 * 而实际是清点失效——又一次「零与合规同形」。调用方必须把 `null` 当成红。
 */
export function ledgerEntryCount(text: string, symbol: string): number | null {
  const source = ts.createSourceFile('ledger.ts', text, ts.ScriptTarget.Latest, true)
  let count: number | null = null
  const visit = (node: ts.Node): void => {
    if (count !== null) return
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === symbol &&
      node.initializer !== undefined
    ) {
      count = ledgerElementCount(node.initializer)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

/**
 * 该文件里出现的、属于给定词汇表的字符串字面量（含出现位置，便于定位）。
 *
 * 判据走 **AST 字面量**而不是 grep：注释里写着「这里原本按 `cfg.type === 'workflow'`
 * 分叉」不是违规，而一条 `grep -c "'workflow'"` 会把它算成违规——本判据自己的说明
 * 注释就已经踩中过这一点（见 rfc317-acl-mounter-type-neutrality 的 fixture）。
 */
export function mintedVocabulary(unit: SourceUnit, vocabulary: readonly string[]): string[] {
  const wanted = new Set(vocabulary)
  const hits: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      wanted.has(node.text)
    ) {
      const line = unit.source.getLineAndCharacterOfPosition(node.getStart(unit.source)).line + 1
      hits.push(`${unit.path}:${line} '${node.text}'`)
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return hits
}

// ---------------------------------------------------------------------------
// 注册表反向完备（RFC-317 T42 · findings G-09）
// ---------------------------------------------------------------------------
//
// `satisfies Record<K, V>` 只挡住**一个方向**：它逼着表对 K 是全的。它挡不住反过来的
// 那种失效——**一行是死的**，或者新加的那一支在消费侧从来没接上。这两种在本仓都真实
// 发生过：RFC-247 找到四个没有任何路由使用的权限点，RFC-146 找到四个没有运行期消费者
// 的「愿望清单维度」。两次都是手工发现的，只有第一次留下了永久机制。
//
// 这里把那个机制做成可复用的：给一组键与一片生产语料，报出**没有任何消费者**的键。

/** 一个键在生产代码里被消费的两种形态。 */
export type RegistryKeyConsumption = 'string-literal' | 'property-access'

/**
 * 报出没有生产消费者的注册表键。
 *
 * 两种形态都算消费：
 *   · **字符串字面量**——`handlers['some-kind']`、把键当值传来传去（权限点、端口名）；
 *   · **属性访问**——`CADENCE.tokenAuditGc`、解构 `const { tokenAuditGc } = CADENCE`。
 * 只认前者会把所有「按属性名读」的注册表判成全死（本仓大多数注册表是这一类）；
 * 只认后者则会漏掉按字符串索引的那一类。两者都要。
 *
 * `declaringFiles` 里的自引用不算消费——否则每张表都在自己的文件里"消费"了自己。
 */
export function registryKeysWithoutConsumer(input: {
  readonly keys: readonly string[]
  readonly units: readonly SourceUnit[]
  readonly declaringFiles: readonly string[]
}): string[] {
  const declaring = new Set(input.declaringFiles)
  const wanted = new Set(input.keys)
  const consumed = new Set<string>()
  for (const unit of input.units) {
    if (declaring.has(unit.path)) continue
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        wanted.has(node.text)
      ) {
        consumed.add(node.text)
      }
      if (ts.isPropertyAccessExpression(node) && wanted.has(node.name.text)) {
        consumed.add(node.name.text)
      }
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && wanted.has(node.name.text)) {
        consumed.add(node.name.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return input.keys.filter((key) => !consumed.has(key)).sort()
}

/**
 * 该注册表**符号本身**在声明文件之外有没有被引用。
 *
 * 这一层必须先于键级判据。键级判据证明的是「这个**名字**在生产代码里出现过」，
 * 而不是「这张表的这一行被读过」——一张**整体没人引用**的表，它的键名往往恰好以别的
 * 身份出现在别处（另一张表的键、一个局部变量名），于是键级判据会报「大部分键都有
 * 消费者」，把「整张表是死的」这件事完全盖住。实测（T43 删除前）：`REF_DOMAIN_POLICIES`
 * 在声明文件之外零引用，键级判据却只报出 1 个死键——差一点就把整张死表放行了。
 */
export function registrySymbolHasConsumer(input: {
  readonly symbol: string
  readonly units: readonly SourceUnit[]
  readonly declaringFile: string
}): boolean {
  for (const unit of input.units) {
    if (unit.path === input.declaringFile) continue
    let found = false
    const visit = (node: ts.Node): void => {
      if (found) return
      if (ts.isIdentifier(node) && node.text === input.symbol) {
        found = true
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
    if (found) return true
  }
  return false
}

/**
 * 声明文件里名为 `declarationName` 的**顶层声明**（函数或常量）内部有没有读到 `symbol`。
 *
 * 这是 `{ via: 访问器 }` 形态的第二半判据。只查「访问器有外部消费者」是不够的——
 * 那样把一张死表和一个恰好活着的同文件函数配成对就能蒙混过关。必须同时证明
 * **该访问器真的读了这张表**，两半合起来才construct出「表 → 访问器 → 外部」这条活链。
 *
 * 函数声明与 `const X = ...` 都算：本仓的同文件访问器两种形态都有
 * （`listRepairOptionsForAlert` 是函数，`PROMPT_INJECTED_PORT_NAMES` 是常量）。
 */
export function declarationReadsSymbol(input: {
  readonly unit: SourceUnit
  readonly declarationName: string
  readonly symbol: string
}): boolean {
  let found = false
  const containsSymbol = (node: ts.Node): boolean => {
    let hit = false
    const scan = (n: ts.Node): void => {
      if (hit) return
      if (ts.isIdentifier(n) && n.text === input.symbol) {
        hit = true
        return
      }
      ts.forEachChild(n, scan)
    }
    ts.forEachChild(node, scan)
    return hit
  }
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === input.declarationName &&
      containsSymbol(node)
    ) {
      found = true
      return
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === input.declarationName &&
      node.initializer !== undefined &&
      containsSymbol(node)
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(input.unit.source)
  return found
}
