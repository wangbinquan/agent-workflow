import { createHash } from 'node:crypto'
import ts from 'typescript'

export type IdentityGuardCategory =
  | 'sql-name-selector'
  | 'collection-name-identity'
  | 'id-name-fallback'
  | 'frontend-name-key'
  | 'name-route'

export interface IdentityGuardFinding {
  category: IdentityGuardCategory
  file: string
  functionName: string | null
  line: number
  excerpt: string
  /** Exact hash of SyntaxKind + the full whitespace-normalized syntax node. */
  fingerprint: string
}

const PERSISTED_RESOURCE_TABLES = new Set([
  'agents',
  'skills',
  'mcps',
  'plugins',
  'workgroups',
  'workflows',
  // Generic resource services alias one of the tables above to `table`.
  'table',
])

const SQL_SELECTOR_CALLS = new Set([
  'eq',
  'ne',
  'inArray',
  'notInArray',
  'like',
  'notLike',
  'ilike',
  'notIlike',
])

function functionNameOf(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node)) &&
    node.name !== undefined
  ) {
    return node.name.getText()
  }
  if (
    (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text
  }
  return null
}

function containsNode(node: ts.Node, predicate: (candidate: ts.Node) => boolean): boolean {
  if (predicate(node)) return true
  let found = false
  ts.forEachChild(node, (child) => {
    if (!found && containsNode(child, predicate)) found = true
  })
  return found
}

function accessKey(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (!ts.isElementAccessExpression(node) || node.argumentExpression === undefined) return null
  const key = node.argumentExpression
  if (ts.isStringLiteralLike(key) || ts.isIdentifier(key)) return key.text
  return null
}

function accessReceiver(node: ts.Node): ts.Expression | null {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return node.expression
  }
  return null
}

function callName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text
  return accessKey(node.expression)
}

function identityStem(text: string, kind: 'id' | 'name'): string | null {
  const lower = text.toLowerCase()
  if (lower === kind) return ''
  if (
    lower === `by${kind}` ||
    lower === `${kind}set` ||
    lower === `${kind}map` ||
    lower === `${kind}lookup`
  ) {
    return ''
  }
  const snake = new RegExp(`^(.*)_${kind}$`, 'i').exec(text)
  if (snake !== null) return snake[1]!.toLowerCase()
  const camel = new RegExp(`^(.*)${kind[0]!.toUpperCase()}${kind.slice(1)}$`).exec(text)
  if (camel !== null) return camel[1]!.toLowerCase()
  return null
}

function identifierLooksLikeName(text: string): boolean {
  return (
    /^(?:name|newName|targetName|sourceName|selectorName|byName|nameMap|nameSet|nameLookup)$/i.test(
      text,
    ) ||
    /^(?:agent|skill|mcp|plugin|workgroup|workflow|resource|task)Name$/i.test(text) ||
    /^(?:agent|skill|mcp|plugin|workgroup|workflow|resource|task)_name$/i.test(text)
  )
}

function isNameIdentityNode(node: ts.Node, valueAliases: ReadonlySet<string>): boolean {
  const key = accessKey(node)
  if (key !== null && identifierLooksLikeName(key)) return true
  return (
    ts.isIdentifier(node) && (identifierLooksLikeName(node.text) || valueAliases.has(node.text))
  )
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function expressionIsPersistedTable(
  node: ts.Expression,
  tableAliases: ReadonlySet<string>,
): boolean {
  const current = unwrapExpression(node)
  if (ts.isIdentifier(current)) return tableAliases.has(current.text)
  const key = accessKey(current)
  if (key !== null && PERSISTED_RESOURCE_TABLES.has(key)) return true
  if (
    ts.isCallExpression(current) &&
    ['alias', 'aliasedTable'].includes(callName(current) ?? '') &&
    current.arguments[0] !== undefined
  ) {
    return expressionIsPersistedTable(current.arguments[0], tableAliases)
  }
  return false
}

function expressionIsResourceCollection(
  node: ts.Expression,
  tableAliases: ReadonlySet<string>,
  collectionAliases: ReadonlySet<string>,
): boolean {
  const current = unwrapExpression(node)
  if (ts.isIdentifier(current)) {
    return (
      collectionAliases.has(current.text) ||
      /^(?:agents|skills|mcps|plugins|workgroups|workflows|resources)$/i.test(current.text)
    )
  }
  if (!ts.isCallExpression(current)) return false
  const called = callName(current)
  if (
    called === 'from' &&
    current.arguments[0] !== undefined &&
    expressionIsPersistedTable(current.arguments[0], tableAliases)
  ) {
    return true
  }
  const receiver = accessReceiver(current.expression)
  return (
    receiver !== null && expressionIsResourceCollection(receiver, tableAliases, collectionAliases)
  )
}

function receiverUsesPersistedTable(node: ts.Node, tableAliases: ReadonlySet<string>): boolean {
  return containsNode(
    node,
    (candidate) => ts.isIdentifier(candidate) && tableAliases.has(candidate.text),
  )
}

function isPersistedResourceNameAccess(node: ts.Node, tableAliases: ReadonlySet<string>): boolean {
  return (
    accessKey(node) === 'name' &&
    accessReceiver(node) !== null &&
    receiverUsesPersistedTable(accessReceiver(node)!, tableAliases)
  )
}

function identityStems(node: ts.Node): { ids: Set<string>; names: Set<string> } {
  const ids = new Set<string>()
  const names = new Set<string>()
  const walk = (candidate: ts.Node): void => {
    const key = accessKey(candidate)
    const receiver = accessReceiver(candidate)
    if (key !== null && receiver !== null) {
      if (key === 'id' || key === 'name') {
        const owner = receiver.getText().replace(/\?$/, '').toLowerCase()
        ;(key === 'id' ? ids : names).add(owner)
        return
      }
      const idStem = identityStem(key, 'id')
      const nameStem = identityStem(key, 'name')
      if (idStem !== null) ids.add(idStem)
      if (nameStem !== null) names.add(nameStem)
      // Walk the receiver itself. `forEachChild(receiver, ...)` misses the
      // receiver identifier in `byId.get(...) ?? byName.get(...)`.
      walk(receiver)
      if (ts.isElementAccessExpression(candidate) && candidate.argumentExpression !== undefined) {
        walk(candidate.argumentExpression)
      }
      return
    }
    if (ts.isIdentifier(candidate)) {
      const idStem = identityStem(candidate.text, 'id')
      const nameStem = identityStem(candidate.text, 'name')
      if (idStem !== null) ids.add(idStem)
      if (nameStem !== null) names.add(nameStem)
    }
    ts.forEachChild(candidate, walk)
  }
  walk(node)
  return { ids, names }
}

function hasMatchingIdentityStem(
  left: ReturnType<typeof identityStems>,
  right: ReturnType<typeof identityStems>,
): boolean {
  return (
    [...left.ids].some((stem) => right.names.has(stem)) ||
    [...left.names].some((stem) => right.ids.has(stem))
  )
}

function isIdentityValueExpression(node: ts.Expression): boolean {
  let candidate = node
  while (
    ts.isParenthesizedExpression(candidate) ||
    ts.isAsExpression(candidate) ||
    ts.isTypeAssertionExpression(candidate) ||
    ts.isNonNullExpression(candidate)
  ) {
    candidate = candidate.expression
  }
  if (
    ts.isIdentifier(candidate) ||
    ts.isPropertyAccessExpression(candidate) ||
    ts.isElementAccessExpression(candidate)
  ) {
    return true
  }
  return (
    ts.isCallExpression(candidate) && ['get', 'localeCompare'].includes(callName(candidate) ?? '')
  )
}

function isIdNameFallback(node: ts.ConditionalExpression | ts.BinaryExpression): boolean {
  if (ts.isBinaryExpression(node)) {
    if (!isIdentityValueExpression(node.left) || !isIdentityValueExpression(node.right)) {
      return false
    }
    return hasMatchingIdentityStem(identityStems(node.left), identityStems(node.right))
  }
  if (!isIdentityValueExpression(node.whenTrue) || !isIdentityValueExpression(node.whenFalse)) {
    return false
  }
  return hasMatchingIdentityStem(identityStems(node.whenTrue), identityStems(node.whenFalse))
}

function collectionReceiverLooksResourceBacked(
  node: ts.CallExpression,
  tableAliases: ReadonlySet<string>,
  collectionAliases: ReadonlySet<string>,
): boolean {
  const receiverNode = accessReceiver(node.expression)
  if (receiverNode === null) return false
  if (
    ts.isPropertyAccessExpression(receiverNode) &&
    /^(?:data|system)?(?:inputs|outputs)$/i.test(receiverNode.name.text)
  ) {
    return false
  }
  if (
    ts.isExpression(receiverNode) &&
    expressionIsResourceCollection(receiverNode, tableAliases, collectionAliases)
  ) {
    return true
  }
  const receiver = receiverNode.getText().toLowerCase()
  return (
    /agent|skill|mcp|plugin|workgroup|workflow|resource/.test(receiver) ||
    /(?:^|[._])byname$|namemap$|nameset$|namelookup$/.test(receiver)
  )
}

function mapOrSetUsesNameAsKey(
  node: ts.NewExpression,
  nameValueAliases: ReadonlySet<string>,
): boolean {
  const firstArg = node.arguments?.[0]
  if (firstArg === undefined) return false
  if (ts.isIdentifier(node.expression) && node.expression.text === 'Set') {
    return containsNode(firstArg, (candidate) => isNameIdentityNode(candidate, nameValueAliases))
  }
  let nameKey = false
  const visit = (candidate: ts.Node): void => {
    if (
      ts.isArrayLiteralExpression(candidate) &&
      candidate.elements[0] !== undefined &&
      containsNode(candidate.elements[0], (element) =>
        isNameIdentityNode(element, nameValueAliases),
      )
    ) {
      nameKey = true
      return
    }
    if (!nameKey) ts.forEachChild(candidate, visit)
  }
  visit(firstArg)
  return nameKey
}

function collectionReceiverLooksMapLike(node: ts.CallExpression): boolean {
  const receiverNode = accessReceiver(node.expression)
  if (receiverNode === null) return false
  return /(?:map|set|lookup|byname|byagent|names)$/i.test(receiverNode.getText())
}

function collectionMethodUsesName(
  node: ts.CallExpression,
  nameValueAliases: ReadonlySet<string>,
  tableAliases: ReadonlySet<string>,
  collectionAliases: ReadonlySet<string>,
): boolean {
  const method = callName(node)
  if (method === null) return false
  if (
    ['find', 'some'].includes(method) &&
    collectionReceiverLooksResourceBacked(node, tableAliases, collectionAliases) &&
    node.arguments.some((argument) =>
      containsNode(argument, (candidate) => isNameIdentityNode(candidate, nameValueAliases)),
    )
  ) {
    return true
  }
  if (
    method === 'includes' &&
    collectionReceiverLooksResourceBacked(node, tableAliases, collectionAliases) &&
    node.arguments.some((argument) =>
      containsNode(argument, (candidate) => isNameIdentityNode(candidate, nameValueAliases)),
    )
  ) {
    return true
  }
  if (
    ['get', 'set', 'has', 'delete'].includes(method) &&
    collectionReceiverLooksMapLike(node) &&
    node.arguments[0] !== undefined &&
    containsNode(node.arguments[0], (candidate) => isNameIdentityNode(candidate, nameValueAliases))
  ) {
    return true
  }
  return false
}

function normalizedText(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, ' ').trim()
}

function fingerprintOf(node: ts.Node, source: ts.SourceFile): string {
  const material = `${ts.SyntaxKind[node.kind]}:${normalizedText(node, source)}`
  return `${ts.SyntaxKind[node.kind]}:${createHash('sha256').update(material).digest('hex').slice(0, 20)}`
}

/**
 * RFC-223 T15 structural/semantic identity scan.
 *
 * The scan reasons over syntax roles (Drizzle table column, collection key,
 * id/name fallback, JSX/query/computed key and route parameter) rather than
 * matching raw source lines. Callers may allow only exact AST fingerprints.
 */
export function analyzeIdentitySource(
  sourceText: string,
  file = 'fixture.ts',
): IdentityGuardFinding[] {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const findings: IdentityGuardFinding[] = []
  const reported = new Set<string>()
  const functionStack: Array<string | null> = []
  const aliasScopes: Array<{
    nameValues: Set<string>
    tables: Set<string>
    collections: Set<string>
  }> = [{ nameValues: new Set(), tables: new Set(), collections: new Set() }]

  const aliasesFor = (kind: 'nameValues' | 'tables' | 'collections'): Set<string> => {
    const values =
      kind === 'tables' ? new Set<string>(PERSISTED_RESOURCE_TABLES) : new Set<string>()
    for (const scope of aliasScopes) {
      for (const value of scope[kind]) values.add(value)
    }
    return values
  }

  const report = (category: IdentityGuardCategory, node: ts.Node): void => {
    const dedupeKey = `${category}:${node.pos}:${node.end}`
    if (reported.has(dedupeKey)) return
    reported.add(dedupeKey)
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    const normalized = normalizedText(node, source)
    findings.push({
      category,
      file,
      functionName: [...functionStack].reverse().find((name) => name !== null) ?? null,
      line: line + 1,
      excerpt: normalized.slice(0, 240),
      fingerprint: fingerprintOf(node, source),
    })
  }

  const visit = (node: ts.Node): void => {
    const fn = functionNameOf(node)
    const pushed = fn !== null
    if (pushed) functionStack.push(fn)
    const createsAliasScope = ts.isFunctionLike(node) || ts.isBlock(node)
    if (createsAliasScope) {
      aliasScopes.push({ nameValues: new Set(), tables: new Set(), collections: new Set() })
    }

    const nameValueAliases = aliasesFor('nameValues')
    const tableAliases = aliasesFor('tables')
    const collectionAliases = aliasesFor('collections')
    let declaredAlias:
      | {
          name: string
          nameValue: boolean
          table: boolean
          collection: boolean
        }
      | undefined
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const initializer = unwrapExpression(node.initializer)
      declaredAlias = {
        name: node.name.text,
        nameValue: isNameIdentityNode(initializer, nameValueAliases),
        table: expressionIsPersistedTable(initializer, tableAliases),
        collection: expressionIsResourceCollection(initializer, tableAliases, collectionAliases),
      }
    }

    if (ts.isCallExpression(node)) {
      const called = callName(node)
      if (
        called !== null &&
        SQL_SELECTOR_CALLS.has(called) &&
        node.arguments.some((arg) =>
          containsNode(arg, (candidate) => isPersistedResourceNameAccess(candidate, tableAliases)),
        )
      ) {
        report('sql-name-selector', node)
      }
      if (collectionMethodUsesName(node, nameValueAliases, tableAliases, collectionAliases)) {
        report('collection-name-identity', node)
      }
    }

    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'Map' || node.expression.text === 'Set') &&
      mapOrSetUsesNameAsKey(node, nameValueAliases)
    ) {
      report('collection-name-identity', node)
    }

    if (
      (ts.isConditionalExpression(node) ||
        (ts.isBinaryExpression(node) &&
          (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
            node.operatorToken.kind === ts.SyntaxKind.BarBarToken))) &&
      isIdNameFallback(node)
    ) {
      const parent = node.parent
      const parentIsFallback =
        ts.isConditionalExpression(parent) ||
        (ts.isBinaryExpression(parent) &&
          (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
            parent.operatorToken.kind === ts.SyntaxKind.BarBarToken))
      if (
        !parentIsFallback ||
        !isIdNameFallback(parent as ts.ConditionalExpression | ts.BinaryExpression)
      ) {
        report('id-name-fallback', node)
      }
    }

    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === 'key' &&
      node.initializer !== undefined &&
      containsNode(node.initializer, (candidate) => isNameIdentityNode(candidate, nameValueAliases))
    ) {
      report('frontend-name-key', node)
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      node.left.argumentExpression !== undefined &&
      containsNode(node.left.argumentExpression, (candidate) =>
        isNameIdentityNode(candidate, nameValueAliases),
      )
    ) {
      report('frontend-name-key', node)
    }

    if (
      ts.isComputedPropertyName(node) &&
      containsNode(node.expression, (candidate) => isNameIdentityNode(candidate, nameValueAliases))
    ) {
      report('frontend-name-key', node)
    }

    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === 'queryKey' &&
      containsNode(node.initializer, (candidate) => isNameIdentityNode(candidate, nameValueAliases))
    ) {
      report('frontend-name-key', node)
    }

    if (
      ts.isStringLiteralLike(node) &&
      /\/:(?:agent|skill|mcp|plugin|workgroup|workflow)?name(?:\/|$)/.test(node.text)
    ) {
      report('name-route', node)
    }

    ts.forEachChild(node, visit)
    if (declaredAlias !== undefined) {
      const scope = aliasScopes[aliasScopes.length - 1]!
      if (declaredAlias.nameValue) scope.nameValues.add(declaredAlias.name)
      if (declaredAlias.table) scope.tables.add(declaredAlias.name)
      if (declaredAlias.collection) scope.collections.add(declaredAlias.name)
    }
    if (createsAliasScope) aliasScopes.pop()
    if (pushed) functionStack.pop()
  }

  visit(source)
  return findings
}
