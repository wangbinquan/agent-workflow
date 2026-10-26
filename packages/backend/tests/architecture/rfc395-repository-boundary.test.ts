// RFC-395 II-a A2: one repository projection and one unbound predicate, with the old storage facts confined to adapters.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { packageSrcUnits, sourceUnit, type SourceUnit } from './census'

const root = resolve(import.meta.dir, '../../../..')
const source = (path: string) => readFileSync(resolve(root, 'packages/backend/src', path), 'utf8')
const sqlAdapter = 'packages/backend/src/modules/task-execution/infrastructure/taskRepositorySql.ts'
const retiredProjections = new Set([
  'mapTaskRepoRow',
  'synthesizeRepoFromTaskRow',
  'repoProjection',
  'fallbackRepo',
  'taskRepoOf',
  'fallbackTaskRepo',
  'fallbackRepository',
])

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node)
    ? unwrap(node.expression)
    : node
}

function inlineUnboundPredicates(unit: SourceUnit): string[] {
  const hits = new Set<ts.Node>()
  const declarations = new Map<ts.Node, Map<string, ts.Node>>()
  const values: Array<readonly [ts.Node, ts.Expression]> = []
  const functions = new Map<string, ts.FunctionLikeDeclaration>()
  const calls: ts.CallExpression[] = []
  const marked = new Set<ts.Node>()
  const fields = new Set(['worktreePath'])
  const scope = (node: ts.Node): ts.Node => {
    let current = node.parent
    while (
      current &&
      !ts.isSourceFile(current) &&
      !ts.isFunctionLike(current) &&
      !ts.isBlock(current)
    )
      current = current.parent
    return current ?? unit.source
  }
  const declare = (node: ts.Node, name: string) => {
    const owner = scope(node)
    const entries = declarations.get(owner) ?? new Map<string, ts.Node>()
    entries.set(name, node)
    declarations.set(owner, entries)
  }
  const lookup = (node: ts.Identifier): ts.Node | undefined => {
    let owner: ts.Node | undefined = node
    while (owner) {
      const declaration = declarations.get(owner)?.get(node.text)
      if (declaration) return declaration
      owner = owner.parent
    }
    return undefined
  }
  const isPath = (expression: ts.Expression): boolean => {
    const node = unwrap(expression)
    if (ts.isPropertyAccessExpression(node)) return fields.has(node.name.text)
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression))
      return fields.has(node.argumentExpression.text)
    return ts.isIdentifier(node) && (node.text === 'worktreePath' || marked.has(lookup(node)!))
  }
  const collect = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
      declare(node, node.name.text)
      if (node.initializer) values.push([node, node.initializer])
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      declare(node, node.name.text)
      const key = node.propertyName?.getText(unit.source) ?? node.name.text
      if (fields.has(key)) marked.add(node)
    }
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      functions.set(node.name.text, node.initializer)
    if (ts.isCallExpression(node)) calls.push(node)
    ts.forEachChild(node, collect)
  }
  collect(unit.source)
  // Follow selected column aliases, scalar bindings and local helper parameters to a fixed point.
  let previous = -1
  while (previous !== marked.size + fields.size) {
    previous = marked.size + fields.size
    for (const [declaration, value] of values) if (isPath(value)) marked.add(declaration)
    for (const call of calls) {
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === 'select'
      ) {
        const selection = call.arguments[0]
        if (selection && ts.isObjectLiteralExpression(selection))
          for (const property of selection.properties)
            if (ts.isPropertyAssignment(property) && isPath(property.initializer))
              fields.add(property.name.getText(unit.source).replace(/^['"]|['"]$/g, ''))
      }
      if (ts.isIdentifier(call.expression)) {
        const fn = functions.get(call.expression.text)
        call.arguments.forEach((argument, index) => {
          if (fn?.parameters[index] && isPath(argument)) marked.add(fn.parameters[index]!)
        })
      }
    }
    const markBindings = (node: ts.Node): void => {
      if (
        ts.isBindingElement(node) &&
        fields.has(node.propertyName?.getText(unit.source) ?? node.name.getText(unit.source))
      )
        marked.add(node)
      ts.forEachChild(node, markBindings)
    }
    markBindings(unit.source)
  }
  const isLength = (expression: ts.Expression) => {
    const node = unwrap(expression)
    return (
      ts.isPropertyAccessExpression(node) && node.name.text === 'length' && isPath(node.expression)
    )
  }
  const empty = (node: ts.Expression) =>
    ts.isStringLiteralLike(unwrap(node)) && unwrap(node).getText(unit.source).slice(1, -1) === ''
  const zero = (node: ts.Expression) =>
    ts.isNumericLiteral(unwrap(node)) && unwrap(node).getText(unit.source) === '0'
  const truthy = (expression: ts.Expression) => {
    if (isPath(expression) || isLength(expression)) hits.add(expression)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      if (
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
        ].includes(operator) &&
        ((isPath(node.left) && empty(node.right)) || (empty(node.left) && isPath(node.right)))
      )
        hits.add(node)
      if (
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
          ts.SyntaxKind.GreaterThanToken,
          ts.SyntaxKind.LessThanToken,
          ts.SyntaxKind.GreaterThanEqualsToken,
          ts.SyntaxKind.LessThanEqualsToken,
        ].includes(operator) &&
        ((isLength(node.left) && zero(node.right)) || (zero(node.left) && isLength(node.right)))
      )
        hits.add(node)
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.BarBarToken
      )
        truthy(node.left)
    }
    if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node))
      truthy(node.expression)
    if (ts.isConditionalExpression(node)) truthy(node.condition)
    if (ts.isForStatement(node) && node.condition) truthy(node.condition)
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      truthy(node.operand)
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(unit.source)
      if (name === 'Boolean' && node.arguments[0]) truthy(node.arguments[0])
      if (
        unit.path !== sqlAdapter &&
        /^(?:\w+\.)?(?:eq|ne)$/.test(name) &&
        node.arguments.length === 2 &&
        ((isPath(node.arguments[0]!) && empty(node.arguments[1]!)) ||
          (empty(node.arguments[0]!) && isPath(node.arguments[1]!)))
      )
        hits.add(node)
    }
    if (
      unit.path !== sqlAdapter &&
      ts.isTaggedTemplateExpression(node) &&
      /^sql(?:\.|$)/.test(node.tag.getText(unit.source))
    ) {
      const template = node.template
      if (ts.isTemplateExpression(template))
        template.templateSpans.forEach((span, index) => {
          const before =
            index === 0 ? template.head.text : template.templateSpans[index - 1]!.literal.text
          if (
            isPath(span.expression) &&
            (/^\s*(?:=|<>|!=)\s*''/.test(span.literal.text) || /''\s*(?:=|<>|!=)\s*$/.test(before))
          )
            hits.add(node)
        })
      if (/\bworktree_path\s*(?:=|<>|!=)\s*''/i.test(template.getText(unit.source))) hits.add(node)
    }
    if (ts.isIdentifier(node) && node.text === 'minimalNodePaths') hits.add(node)
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return [...hits].map((node) => node.getText(unit.source))
}

function retiredProjectionNames(unit: SourceUnit): string[] {
  const hits = new Set<string>()
  const visit = (node: ts.Node): void => {
    const name = ts.isFunctionDeclaration(node)
      ? node.name
      : ts.isVariableDeclaration(node) &&
          node.initializer &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ? node.name
        : ts.isCallExpression(node)
          ? node.expression
          : undefined
    if (name && ts.isIdentifier(name) && retiredProjections.has(name.text)) hits.add(name.text)
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return [...hits].sort()
}

function callsProjection(text: string, name: string): boolean {
  const unit = sourceUnit('projection.ts', text)
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      found = true
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return found
}

test('backend readers use the shared unbound predicate and the single ancestor closure', () => {
  const units = packageSrcUnits(root, 'backend')
  expect(units.length).toBeGreaterThan(1000)
  expect(
    units.flatMap((unit) => inlineUnboundPredicates(unit).map((hit) => `${unit.path}: ${hit}`)),
  ).toEqual([])
  expect(
    units.flatMap((unit) => retiredProjectionNames(unit).map((hit) => `${unit.path}: ${hit}`)),
  ).toEqual([])
})

test('negative fixtures cover operand order, coercion, length, truthiness, aliases, helpers and SQL', () => {
  for (const text of [
    `const empty = task.worktreePath === ''`,
    `const ready = '' != task.worktreePath`,
    `const empty = '' == task.worktreePath`,
    `const ready = task.worktreePath !== ''`,
    `const empty = task.worktreePath.length === 0`,
    `const ready = task.worktreePath.length > 0`,
    `const ready = task.worktreePath.length !== 0`,
    `if (task.worktreePath) use(task)`,
    `const empty = !task.worktreePath`,
    `const ready = Boolean(task.worktreePath)`,
    `const rows = db.select({ path: tasks.worktreePath }); rows.filter(({ path }) => path !== '')`,
    `const path = task.worktreePath; const ready = path != ''`,
    `function empty(path: string) { return path.length === 0 }; empty(task.worktreePath)`,
    `const empty = (path: string) => path.length === 0; empty(task.worktreePath)`,
    `eq(tasks.worktreePath, '')`,
    `ne('', tasks.worktreePath)`,
    "sql`${tasks.worktreePath} <> ''`",
    "sql`'' = ${tasks.worktreePath}`",
    'function minimalNodePaths() { return [] }',
  ])
    expect(inlineUnboundPredicates(sourceUnit('negative.ts', text)), text).not.toEqual([])
  expect(
    inlineUnboundPredicates(
      sourceUnit('ok.ts', 'const empty = isTaskWorkspaceUnbound(task.worktreePath)'),
    ),
  ).toEqual([])
  expect(inlineUnboundPredicates(sourceUnit(sqlAdapter, `eq(tasks.worktreePath, '')`))).toEqual([])
  expect(
    inlineUnboundPredicates(
      sourceUnit(
        'ok.ts',
        `function unrelated(path: string) { return path.length === 0 }; unrelated(name)`,
      ),
    ),
  ).toEqual([])
})

test('absence and projection-call pins cannot pass with a renamed location or an import alone', () => {
  for (const name of retiredProjections) {
    expect(
      retiredProjectionNames(sourceUnit('some/other/store.ts', `const ${name} = () => ({})`)),
    ).toEqual([name])
    expect(
      retiredProjectionNames(sourceUnit('some/other/store.ts', `function ${name}() {}`)),
    ).toEqual([name])
  }
  expect(
    callsProjection(
      "import { projectStoredTaskRepositorySurface } from './adapter'",
      'projectStoredTaskRepositorySurface',
    ),
  ).toBe(false)
  expect(
    callsProjection(
      'const dto = projectStoredTaskRepositorySurface(row)',
      'projectStoredTaskRepositorySurface',
    ),
  ).toBe(true)
})

test('detail, launch, lists and WS keep the repository projection boundary', () => {
  for (const path of [
    // RFC-395 II-a A7 moved rowToTask into its owning query adapter.
    'modules/task-execution/infrastructure/taskDetailQueries.ts',
    'modules/task-execution/infrastructure/taskRouteLaunchOperations.ts',
    'modules/task-execution/infrastructure/taskRouteOperations.ts',
  ])
    expect(callsProjection(source(path), 'projectStoredTaskRepositorySurface'), path).toBe(true)
  for (const path of [
    'taskRouteOperations.ts',
    'taskLifecycleWsProjection.ts',
    'taskExecutionCatalogSources.ts',
    'taskListPage/projection.ts',
  ])
    expect(
      callsProjection(
        source(`modules/task-execution/infrastructure/${path}`),
        'projectStoredTaskRepositorySummary',
      ),
      path,
    ).toBe(true)
  for (const path of [
    'taskRouteWorkspaceParticipant.ts',
    'taskRouteLaunchOperations.ts',
    'taskRouteOperations.ts',
  ])
    expect(source(`modules/task-execution/infrastructure/${path}`)).not.toMatch(
      /\.worktreeDirName\b/,
    )
  expect(
    callsProjection(
      source('platform/persistence/taskRepositorySurface.ts'),
      'projectTaskRepositorySurface',
    ),
  ).toBe(true)
  expect(
    source('modules/task-execution/infrastructure/repositoryPreparationRetryCommand.ts'),
  ).toContain('taskWorkspaceUnboundSql(tasks.workspaceRootRef)')
  expect(
    source('modules/task-execution/infrastructure/taskDefinitionWriteParticipant.ts'),
  ).toContain('taskWorkspaceRootMatchesSql(tasks.workspaceRootRef, input.expectedWorktreePath)')
})
