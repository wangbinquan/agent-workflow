// RFC-395 II-a A1: the column inventory defines the read boundary; epoch-1 encodings stay in explicit legacy fixtures.
import ts from 'typescript'
import inventory from '../../fixtures/rfc395-column-destinations.json'
import { fixtureTableSymbols } from './directWrites'

const physical: Readonly<Record<string, string>> = {
  tasks: 'tasks',
  task_repos: 'taskRepos',
  node_runs: 'nodeRuns',
  node_run_outputs: 'nodeRunOutputs',
  agents: 'agents',
  workflows: 'workflows',
  clarify_rounds: 'clarifyRounds',
}
export const movedFixtureColumns = inventory.columns.filter(
  (column) => column.target !== `${column.table}.${column.physical}`,
)
export interface FixtureReadFinding {
  table: string
  shape: 'column' | 'task-repos' | 'raw-sql' | 'whole-row'
  line: number
  column?: string
}

export function movedSqlReads(text: string): { table: string; column?: string }[] {
  const findings: { table: string; column?: string }[] = []
  // Find SQL inside child-process scripts before removing SQL string values.
  const sql = text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
  for (const fragment of sql.split(';')) {
    const start = fragment.search(/\bselect\b/i)
    if (start < 0) continue
    const statement = fragment.slice(start).replace(/'(?:''|[^'])*'/g, "''")
    for (const [name, table] of Object.entries(physical)) {
      const mention = new RegExp(`\\b(?:from|join)\\s+[\x60"\\[]?${name}\\b`, 'i')
      if (!mention.test(statement)) continue
      if (name === 'task_repos') {
        findings.push({ table })
        continue
      }
      const columns = movedFixtureColumns.filter((entry) => entry.table === name)
      if (!columns.length) continue
      if (/\bselect\s+(?:[\w]+\.)?\*/i.test(statement)) {
        findings.push({ table, column: '*' })
        continue
      }
      for (const entry of columns)
        if (new RegExp(`\\b${entry.physical}\\b`, 'i').test(statement))
          findings.push({ table, column: entry.physical })
    }
  }
  return findings
}

export function directFixtureReads(path: string, text: string): FixtureReadFinding[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const aliases = new Map<string, string>(fixtureTableSymbols.map((name) => [name, name]))
  const variables = new Map<string, ts.Expression>()
  const columnAliases = new Map<string, { table: string; property: string }>()
  function collect(node: ts.Node): void {
    if (ts.isImportSpecifier(node)) {
      const original = (node.propertyName ?? node.name).text
      if (aliases.has(original)) aliases.set(node.name.text, aliases.get(original)!)
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const original = node.propertyName?.getText(source) ?? node.name.text
      if (aliases.has(original)) aliases.set(node.name.text, aliases.get(original)!)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      variables.set(node.name.text, node.initializer)
    ts.forEachChild(node, collect)
  }
  collect(source)
  function tableOf(node: ts.Node | undefined, seen = new Set<string>()): string | undefined {
    if (!node) return undefined
    if (ts.isIdentifier(node)) {
      if (aliases.has(node.text)) return aliases.get(node.text)
      if (seen.has(node.text)) return undefined
      seen.add(node.text)
      return tableOf(variables.get(node.text), seen)
    }
    if (ts.isPropertyAccessExpression(node)) return aliases.get(node.name.text)
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
      return aliases.get(node.argumentExpression.text)
    return undefined
  }
  function columns(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      const table = tableOf(node.initializer)
      if (table)
        for (const binding of node.name.elements)
          if (ts.isIdentifier(binding.name))
            columnAliases.set(binding.name.text, {
              table,
              property: binding.propertyName?.getText(source) ?? binding.name.text,
            })
    }
    ts.forEachChild(node, columns)
  }
  columns(source)
  const rowAliases = new Map<ts.Node, Map<string, string>>()
  const functionRows = new Map<ts.Node, Map<string, string>>()
  const factoryFields = new Map<string, Map<string, string>>()
  function rowScope(node: ts.Node): ts.Node {
    let scope = node.parent
    while (scope && !ts.isBlock(scope) && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope))
      scope = scope.parent
    return scope ?? source
  }
  function lookupRow(node: ts.Identifier): string | undefined {
    for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
      const table = rowAliases.get(scope)?.get(node.text)
      if (table) return table
    }
    return undefined
  }
  function lookupFunction(node: ts.Identifier): string | undefined {
    for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
      const table = functionRows.get(scope)?.get(node.text)
      if (table) return table
    }
    return undefined
  }
  function callbackRow(callback: ts.Node | undefined): string | undefined {
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)))
      return undefined
    if (!ts.isBlock(callback.body)) return rowOf(callback.body)
    for (const statement of callback.body.statements)
      if (ts.isReturnStatement(statement)) return rowOf(statement.expression)
    return undefined
  }
  function rowOf(node: ts.Node | undefined): string | undefined {
    if (!node) return undefined
    if (ts.isIdentifier(node)) return lookupRow(node)
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties)
        if (ts.isSpreadAssignment(property)) {
          const table = rowOf(property.expression)
          if (table) return table
        }
      return undefined
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        const table = rowOf(element)
        if (table) return table
      }
      return undefined
    }
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'Map')
      return rowOf(node.arguments?.[0])
    if (
      ts.isAwaitExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node)
    )
      return rowOf(node.expression)
    if (ts.isElementAccessExpression(node)) return rowOf(node.expression)
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) {
        let factory: ts.Node | undefined = node.expression.expression
        if (ts.isIdentifier(factory)) factory = variables.get(factory.text)
        while (factory && (ts.isAwaitExpression(factory) || ts.isParenthesizedExpression(factory)))
          factory = factory.expression
        if (factory && ts.isCallExpression(factory) && ts.isIdentifier(factory.expression)) {
          const table = factoryFields.get(factory.expression.text)?.get(node.expression.name.text)
          if (table) return table
        }
        if (node.expression.name.text === 'from') {
          const select = node.expression.expression
          if (
            ts.isCallExpression(select) &&
            ts.isPropertyAccessExpression(select.expression) &&
            select.expression.name.text === 'select' &&
            !select.arguments.length
          )
            return tableOf(node.arguments[0])
        }
        if (['map', 'flatMap', 'then'].includes(node.expression.name.text))
          return callbackRow(node.arguments[0])
        if (
          [
            'where',
            'orderBy',
            'limit',
            'offset',
            'filter',
            'find',
            'slice',
            'sort',
            'at',
            'get',
          ].includes(node.expression.name.text)
        )
          return rowOf(node.expression.expression)
        return undefined
      }
      if (
        ts.isIdentifier(node.expression) &&
        ['first', 'firstRow', 'queryRows'].includes(node.expression.text)
      )
        return rowOf(node.arguments[0])
      if (ts.isIdentifier(node.expression)) return lookupFunction(node.expression)
    }
    return undefined
  }
  function bindRows(name: ts.BindingName, table: string): void {
    if (ts.isIdentifier(name)) {
      const scope = rowScope(name)
      const names = rowAliases.get(scope) ?? new Map<string, string>()
      names.set(name.text, table)
      rowAliases.set(scope, names)
    } else
      for (const item of name.elements)
        if (ts.isBindingElement(item) && (ts.isArrayBindingPattern(name) || item.dotDotDotToken))
          bindRows(item.name, table)
  }
  function traceRows(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const table = rowOf(node.initializer)
      if (table) bindRows(node.name, table)
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const table = rowOf(node.expression.expression)
      if (
        table &&
        ['map', 'filter', 'find', 'some', 'every', 'forEach', 'then'].includes(
          node.expression.name.text,
        )
      )
        for (const callback of node.arguments)
          if (
            (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
            callback.parameters[0]
          )
            bindRows(callback.parameters[0].name, table)
    }
    ts.forEachChild(node, traceRows)
  }
  function traceFunctions(node: ts.Node): void {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node)) &&
      node.body
    ) {
      const name =
        (ts.isArrowFunction(node) ? undefined : node.name?.getText(source)) ??
        (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(source) : undefined)
      const tables = new Set<string>()
      const visitReturns = (child: ts.Node): void => {
        if (child !== node.body && ts.isFunctionLike(child)) return
        if (
          name &&
          ts.isReturnStatement(child) &&
          child.expression &&
          ts.isObjectLiteralExpression(child.expression)
        ) {
          const fields = factoryFields.get(name) ?? new Map<string, string>()
          for (const property of child.expression.properties) {
            const value = ts.isShorthandPropertyAssignment(property)
              ? property.name
              : ts.isPropertyAssignment(property)
                ? property.initializer
                : undefined
            const table =
              value && ts.isIdentifier(value) ? lookupFunction(value) : callbackRow(value)
            if (table && property.name) fields.set(property.name.getText(source), table)
          }
          if (fields.size) factoryFields.set(name, fields)
        }
        if (ts.isReturnStatement(child)) {
          const table = rowOf(child.expression)
          if (table) tables.add(table)
        }
        ts.forEachChild(child, visitReturns)
      }
      if (ts.isBlock(node.body)) visitReturns(node.body)
      else {
        const table = rowOf(node.body)
        if (table) tables.add(table)
      }
      if (name && tables.size === 1) {
        const scope = rowScope(node),
          names = functionRows.get(scope) ?? new Map<string, string>()
        names.set(name, [...tables][0]!)
        functionRows.set(scope, names)
      }
    }
    ts.forEachChild(node, traceFunctions)
  }
  // Callback bindings, local return helpers and Map lookups can introduce successive aliases.
  for (let pass = 0; pass < 3; pass++) {
    traceRows(source)
    traceFunctions(source)
  }
  const findings: FixtureReadFinding[] = []
  const add = (node: ts.Node, finding: Omit<FixtureReadFinding, 'line'>) =>
    findings.push({
      ...finding,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    })
  const moved = (table: string, property: string) =>
    movedFixtureColumns.some(
      (entry) => physical[entry.table] === table && entry.property === property,
    )
  function sqlText(node: ts.Node | undefined, seen = new Set<string>()): string {
    if (!node) return ''
    if (ts.isStringLiteralLike(node)) return node.text
    if (ts.isTemplateExpression(node))
      return (
        node.head.text +
        node.templateSpans
          .map((span) => {
            const table = tableOf(span.expression)
            const column = ts.isPropertyAccessExpression(span.expression)
              ? inventory.columns.find(
                  (entry) =>
                    physical[entry.table] ===
                      tableOf((span.expression as ts.PropertyAccessExpression).expression) &&
                    entry.property === (span.expression as ts.PropertyAccessExpression).name.text,
                )
              : undefined
            return (
              (column?.physical ??
                Object.keys(physical).find((name) => physical[name] === table) ??
                sqlText(span.expression, seen)) + span.literal.text
            )
          })
          .join('')
      )
    if (ts.isTaggedTemplateExpression(node)) return sqlText(node.template, seen)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return sqlText(node.left, seen) + sqlText(node.right, seen)
    if (ts.isArrayLiteralExpression(node))
      return node.elements.map((element) => sqlText(element, seen)).join(';')
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      seen.add(node.text)
      return sqlText(variables.get(node.text), seen)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'join'
    )
      return sqlText(node.expression.expression, seen)
    return ''
  }
  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node)) {
      const table = tableOf(node.expression) ?? rowOf(node.expression)
      if (table && moved(table, node.name.text))
        add(node, { table, shape: 'column', column: node.name.text })
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const table = tableOf(node.expression)
      if (table && moved(table, node.argumentExpression.text))
        add(node, { table, shape: 'column', column: node.argumentExpression.text })
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const column = columnAliases.get(node.name.text)
      if (column && moved(column.table, column.property))
        add(node, { table: column.table, shape: 'column', column: column.property })
    }
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : ''
      if (
        [
          'toEqual',
          'toMatchObject',
          'toStrictEqual',
          'toMatchSnapshot',
          'toMatchInlineSnapshot',
        ].includes(name)
      ) {
        const inputs: ts.Node[] = [...node.arguments]
        let receiver: ts.Expression | undefined = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.expression
          : undefined
        while (receiver && ts.isPropertyAccessExpression(receiver)) receiver = receiver.expression
        if (
          receiver &&
          ts.isCallExpression(receiver) &&
          receiver.expression.getText(source) === 'expect'
        )
          inputs.push(...receiver.arguments)
        for (const input of inputs) {
          const table = rowOf(input)
          if (table && movedFixtureColumns.some((column) => physical[column.table] === table))
            add(input, { table, shape: 'whole-row' })
        }
      }
      if (name === 'from' && tableOf(node.arguments[0]) === 'taskRepos')
        add(node, { table: 'taskRepos', shape: 'task-repos' })
      if (
        [
          'exec',
          'run',
          'query',
          'prepare',
          'rawRows',
          'rawFirst',
          'rawExec',
          'execSql',
          'querySql',
          'sqliteQuery',
          'readSql',
          'sql',
          'runSqlite',
          'sqlite',
        ].includes(name)
      )
        for (const argument of node.arguments)
          for (const finding of movedSqlReads(sqlText(argument)))
            add(argument, { ...finding, shape: 'raw-sql' })
    }
    if (ts.isTaggedTemplateExpression(node) && /(?:^|\.)sql$/.test(node.tag.getText(source)))
      for (const finding of movedSqlReads(sqlText(node.template)))
        add(node, { ...finding, shape: 'raw-sql' })
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings.filter(
    (finding, index) =>
      findings.findIndex(
        (other) =>
          other.table === finding.table &&
          other.shape === finding.shape &&
          other.column === finding.column &&
          other.line === finding.line,
      ) === index,
  )
}

/** E2E SQL can be embedded in child-process scripts as well as direct database calls. */
export function e2eFixtureSqlFindings(
  path: string,
  text: string,
): { line: number; kind: 'read' | 'write'; table: string }[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const findings: { line: number; kind: 'read' | 'write'; table: string }[] = []
  function sqlValue(node: ts.Node): string {
    if (ts.isStringLiteralLike(node)) return node.text
    if (ts.isTemplateExpression(node))
      return (
        node.head.text +
        node.templateSpans
          .map((span) => (sqlValue(span.expression) || ' ? ') + span.literal.text)
          .join('')
      )
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return sqlValue(node.left) + sqlValue(node.right)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'join' &&
      ts.isArrayLiteralExpression(node.expression.expression)
    )
      return node.expression.expression.elements
        .map(sqlValue)
        .join(node.arguments[0] ? sqlValue(node.arguments[0]) : ',')
    return ''
  }
  function visit(node: ts.Node): void {
    const parent = node.parent
    const fragment =
      parent &&
      ((ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
        ts.isTemplateSpan(parent))
    if (
      !fragment &&
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateExpression(node) ||
        ts.isBinaryExpression(node) ||
        ts.isCallExpression(node))
    ) {
      const value = sqlValue(node)
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      for (const finding of movedSqlReads(value))
        findings.push({ line, kind: 'read', table: finding.table })
      for (const match of value.matchAll(
        /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+[\x60"[]?([a-zA-Z_]+)\b/gi,
      )) {
        const table = physical[match[1]!.toLowerCase()]
        if (table) findings.push({ line, kind: 'write', table })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}
