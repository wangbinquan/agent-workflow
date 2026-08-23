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

import { readdirSync, readFileSync, statSync } from 'node:fs'
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
  const srcRoot = resolve(repoRoot, 'packages', 'backend', 'src')
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

/** 磁盘上全部「架构守卫」测试文件（仅顶层，不递归——三个 tests 目录都是平铺的）。 */
export function guardTestFiles(repoRoot: string): string[] {
  const out: string[] = []
  for (const dir of GUARD_TEST_DIRECTORIES) {
    let names: string[]
    try {
      names = readdirSync(resolve(repoRoot, dir))
    } catch {
      continue
    }
    for (const name of names) {
      if (!/\.test\.[cm]?tsx?$/.test(name)) continue
      if (!GUARD_FILE_NAME_PATTERN.test(name)) continue
      out.push(`${dir}/${name}`)
    }
  }
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
