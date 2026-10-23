// RFC-395 II-a A1: AST census shared by the ratchet and its negative controls; fixture adapters are the write boundary.
import ts from 'typescript'
export const fixtureTableSymbols = [
  'tasks',
  'taskRepos',
  'nodeRuns',
  'nodeRunOutputs',
  'agents',
  'workflows',
  'clarifyRounds',
] as const
const physicalTables: Readonly<Record<string, string>> = {
  tasks: 'tasks',
  task_repos: 'taskRepos',
  node_runs: 'nodeRuns',
  node_run_outputs: 'nodeRunOutputs',
  agents: 'agents',
  workflows: 'workflows',
  clarify_rounds: 'clarifyRounds',
}
export interface FixtureWriteFinding {
  table: string
  shape: 'insert' | 'update' | 'raw-sql'
  line: number
}
export function directFixtureWrites(path: string, text: string): FixtureWriteFinding[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const aliases = new Map<string, string>(fixtureTableSymbols.map((table) => [table, table]))
  const inserts = new Set(['insertOne'])
  const variables = new Map<string, ts.Expression>()
  function collect(node: ts.Node): void {
    if (ts.isImportSpecifier(node)) {
      const name = (node.propertyName ?? node.name).text
      if (aliases.has(name)) aliases.set(node.name.text, aliases.get(name)!)
      if (name === 'insertOne') inserts.add(node.name.text)
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.propertyName) {
      const table = aliases.get(node.propertyName.getText(source))
      if (table) aliases.set(node.name.text, table)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      variables.set(node.name.text, node.initializer)
    ts.forEachChild(node, collect)
  }
  collect(source)
  function tableOf(node: ts.Node | undefined, seen = new Set<string>()): string | undefined {
    if (!node) return undefined
    if (ts.isIdentifier(node)) {
      const direct = aliases.get(node.text)
      if (direct) return direct
      if (seen.has(node.text)) return undefined
      seen.add(node.text)
      return tableOf(variables.get(node.text), seen)
    }
    if (ts.isPropertyAccessExpression(node)) return aliases.get(node.name.text)
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
      return aliases.get(node.argumentExpression.text)
    return undefined
  }
  const findings: FixtureWriteFinding[] = []
  const add = (node: ts.Node, table: string, shape: FixtureWriteFinding['shape']) =>
    findings.push({
      table,
      shape,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    })
  function sqlText(node: ts.Node, seen = new Set<string>()): string {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      return node.text
    if (ts.isTemplateExpression(node))
      return (
        node.head.text +
        node.templateSpans
          .map(
            (span) =>
              (tableOf(span.expression) ?? sqlText(span.expression, seen)) + span.literal.text,
          )
          .join('')
      )
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return sqlText(node.left, seen) + sqlText(node.right, seen)
    if (ts.isArrayLiteralExpression(node))
      return node.elements.map((entry) => sqlText(entry, seen)).join(';')
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      seen.add(node.text)
      const value = variables.get(node.text)
      return value ? sqlText(value, seen) : ''
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'join'
    )
      return sqlText(node.expression.expression, seen)
    return ''
  }
  function raw(node: ts.Node): void {
    const text = sqlText(node)
    const pattern =
      /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE)\s+[`"[]?([a-zA-Z_]+)\b/gi
    for (const match of text.matchAll(pattern)) {
      const name = match[1]!
      const table = physicalTables[name.toLowerCase()] ?? aliases.get(name)
      if (table) add(node, table, 'raw-sql')
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const call = node.expression
      if (ts.isPropertyAccessExpression(call) && ['insert', 'update'].includes(call.name.text)) {
        const table = tableOf(node.arguments[0])
        if (table) add(node, table, call.name.text as 'insert' | 'update')
      } else if (ts.isIdentifier(call) && inserts.has(call.text)) {
        const table = tableOf(node.arguments[1])
        if (table) add(node, table, 'insert')
      }
      const name = ts.isPropertyAccessExpression(call)
        ? call.name.text
        : ts.isIdentifier(call)
          ? call.text
          : ''
      if (
        [
          'exec',
          'run',
          'query',
          'prepare',
          'all',
          'get',
          'unsafe',
          'execute',
          'executeFixtureDdl',
          'runSql',
          'runSqlite',
          'raw',
          'rawExec',
          'rawRows',
          'rawFirst',
        ].includes(name)
      )
        for (const arg of node.arguments) raw(arg)
    }
    if (ts.isTaggedTemplateExpression(node) && /(?:^|\.)sql$/.test(node.tag.getText(source)))
      raw(node.template)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings.filter(
    (finding, index, array) =>
      array.findIndex(
        (other) =>
          other.table === finding.table &&
          other.shape === finding.shape &&
          other.line === finding.line,
      ) === index,
  )
}
