// RFC-395 II-a A7：按持久化来源识别表引用，普通 DTO 的同名字段不算访问。
// 归属由编译 registry 提供；横向目录的后继账本可复用同一引用扫描器。
import ts from 'typescript'
import type { SourceUnit } from './census'

export interface OwnershipTable {
  readonly schemaSymbol: string
  readonly id: string
  readonly owner: string
}

export function tableOwnerContext(owner: string): string {
  return owner === 'code-capability' || owner === 'code-capability/history'
    ? 'development-automation'
    : owner
}

/** 只解析源码，不执行业务模块或数据库操作。 */
export function referencedPersistenceTables(
  unit: SourceUnit,
  tables: readonly OwnershipTable[],
): readonly string[] {
  const symbols = new Set(tables.map((table) => table.schemaSymbol))
  const physical = new Map(tables.map((table) => [table.id, table.schemaSymbol]))
  const seen = new Set<string>()
  const namespaces = new Set<string>()
  const readers = new Set<string>()
  const sessionNamespaces = new Set<string>()
  const typeSets = new Set<string>()
  const add = (symbol: string) => {
    if (symbols.has(symbol)) seen.add(symbol)
  }
  for (const statement of unit.source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const specifier = statement.moduleSpecifier.text
    const bindings = statement.importClause?.namedBindings
    const schema = /(?:^|\/)(?:schema|persistenceSchema)(?:\.ts)?$/.test(specifier)
    if (bindings && ts.isNamespaceImport(bindings) && schema) namespaces.add(bindings.name.text)
    if (bindings && ts.isNamespaceImport(bindings) && /\/sessionTables(?:\.ts)?$/.test(specifier))
      sessionNamespaces.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        const name = (binding.propertyName ?? binding.name).text
        if (schema) add(name)
        if (/\/sessionTables(?:\.ts)?$/.test(specifier)) {
          if (name === 'tablesOf') readers.add(binding.name.text)
          if (name === 'PersistenceTables') typeSets.add(binding.name.text)
        }
      }
    }
  }
  const unwrap = (node: ts.Node): ts.Node =>
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
      ? unwrap(node.expression)
      : node
  const isReader = (node: ts.Node): boolean => {
    const value = unwrap(node)
    return (
      (ts.isIdentifier(value) && readers.has(value.text)) ||
      (ts.isPropertyAccessExpression(value) &&
        ts.isIdentifier(value.expression) &&
        sessionNamespaces.has(value.expression.text) &&
        value.name.text === 'tablesOf')
    )
  }
  const isTableSet = (node: ts.Node): boolean => {
    const value = unwrap(node)
    return (
      (ts.isCallExpression(value) && isReader(value.expression)) ||
      (ts.isIdentifier(value) && namespaces.has(value.text)) ||
      (ts.isPropertyAccessExpression(value) && value.name.text === 'query')
    )
  }
  // 别名与解构可以分开声明；先收集表集别名，再读取成员。
  let changed = true
  while (changed) {
    changed = false
    const aliases = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isTableSet(node.initializer) &&
        !namespaces.has(node.name.text)
      ) {
        namespaces.add(node.name.text)
        changed = true
      }
      ts.forEachChild(node, aliases)
    }
    aliases(unit.source)
  }
  const sqlTables = (text: string): void => {
    // 字符串 / 模板的 SQL 标识符，而非注释或同名 DTO 字符串。
    const pattern =
      /\b(?:from|join|update|into|using)\s+(?:["`]?\w+["`]?\.)?["`]?([a-z][a-z0-9_]*)["`]?/gi
    for (const match of text.matchAll(pattern)) {
      const symbol = physical.get(match[1]!.toLowerCase())
      if (symbol) seen.add(symbol)
    }
    // 逗号连接：`FROM a x, b y` 的第二张及之后的表。只认紧跟逗号的标识符，名字仍须是 registry 物理表名。
    const commaJoin = /\bfrom\s+[^;()]*?,\s*(?:["`]?\w+["`]?\.)?["`]?([a-z][a-z0-9_]*)["`]?/gi
    for (const match of text.matchAll(commaJoin)) {
      const symbol = physical.get(match[1]!.toLowerCase())
      if (symbol) seen.add(symbol)
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isTableSet(node.initializer)
    ) {
      for (const binding of node.name.elements) {
        const name = binding.propertyName ?? binding.name
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) add(name.text)
      }
    }
    if (ts.isPropertyAccessExpression(node) && isTableSet(node.expression)) add(node.name.text)
    if (
      ts.isElementAccessExpression(node) &&
      isTableSet(node.expression) &&
      ts.isStringLiteral(node.argumentExpression)
    )
      add(node.argumentExpression.text)
    if (
      ts.isIndexedAccessTypeNode(node) &&
      ts.isTypeReferenceNode(node.objectType) &&
      ((ts.isIdentifier(node.objectType.typeName) && typeSets.has(node.objectType.typeName.text)) ||
        (ts.isQualifiedName(node.objectType.typeName) &&
          ts.isIdentifier(node.objectType.typeName.left) &&
          sessionNamespaces.has(node.objectType.typeName.left.text) &&
          node.objectType.typeName.right.text === 'PersistenceTables')) &&
      ts.isLiteralTypeNode(node.indexType) &&
      ts.isStringLiteral(node.indexType.literal)
    ) {
      add(node.indexType.literal.text)
    }
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      sqlTables(node.text)
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return [...seen].sort()
}

/** RFC-395 II-a A7 part 2：横向目录没有领域 owner，每个表引用都必须分类。 */
export function horizontalTableReferences(
  units: readonly SourceUnit[],
  tables: readonly OwnershipTable[],
): readonly { readonly table: string; readonly owner: string; readonly file: string }[] {
  const bySymbol = new Map(tables.map((table) => [table.schemaSymbol, table]))
  const prefix = 'packages/backend/src/'
  return units
    .filter((unit) => unit.path.startsWith(prefix) && !unit.path.startsWith(`${prefix}modules/`))
    .flatMap((unit) =>
      referencedPersistenceTables(unit, tables).map((table) => ({
        table,
        owner: bySymbol.get(table)!.owner,
        file: unit.path.slice(prefix.length),
      })),
    )
    .sort((a, b) => `${a.table}|${a.file}`.localeCompare(`${b.table}|${b.file}`))
}

export function ownershipReferenceDelta(actual: readonly string[], allowed: readonly string[]) {
  const actualSet = new Set(actual)
  const allowedSet = new Set(allowed)
  return {
    unexpected: [...actualSet].filter((key) => !allowedSet.has(key)).sort(),
    stale: [...allowedSet].filter((key) => !actualSet.has(key)).sort(),
    duplicates: [...allowedSet]
      .filter((key) => allowed.filter((item) => item === key).length > 1)
      .sort(),
  }
}
