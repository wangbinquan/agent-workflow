import { TASK_AGGREGATE_LOCK_ORDER } from '@/modules/task-execution/application/ports/taskAggregateWrite'
// RFC-395 II-a A2: definition mutations and workgroup config reads stay behind their ports.
import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dir, '../../src')
const writer = 'modules/task-execution/infrastructure/taskDefinitionWriteParticipant.ts'
const creator = 'modules/task-execution/infrastructure/taskCreationParticipant.ts'
const reader = 'modules/task-execution/infrastructure/taskWorkgroupConfig.ts'
const sharedReader = 'shared/schemas/workgroupRuntime.ts'
const frozen = new Set([
  'workflowSnapshot',
  'workflowVersion',
  'workgroupConfigJson',
  'refClosureJson',
  'workflowId',
  'workgroupId',
  'sourceAgentId',
  'sourceAgentName',
  'codeRoundId',
  'inputs',
  'maxDurationMs',
  'maxTotalTokens',
  'schemaVersion',
])
const physical =
  /\b(?:workflow_snapshot|workflow_version|workgroup_config_json|ref_closure_json|workflow_id|workgroup_id|source_agent_id|source_agent_name|code_round_id|inputs|max_duration_ms|max_total_tokens|schema_version)\b/i

export function definitionBoundaryViolations(path: string, text: string): readonly string[] {
  if (
    path === writer ||
    path === creator ||
    path === 'modules/task-execution/domain/taskCreation.ts' ||
    path.endsWith('/persistence/schema.ts')
  )
    return []
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const violations: string[] = []
  const values = new Map<string, ts.Expression>()
  const taskAliases = new Set(['tasks'])
  const collect = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'tasks')
      taskAliases.add(node.name.text)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      values.set(node.name.text, node.initializer)
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      (node.propertyName?.getText(file) ?? node.name.text) === 'tasks'
    )
      taskAliases.add(node.name.text)
    ts.forEachChild(node, collect)
  }
  collect(file)
  function unwrap(expression: ts.Expression): ts.Expression {
    return ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression)
      ? unwrap(expression.expression)
      : expression
  }
  function taskTable(expression: ts.Expression, seen = new Set<string>()): boolean {
    const node = unwrap(expression)
    if (ts.isPropertyAccessExpression(node)) return node.name.text === 'tasks'
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression))
      return node.argumentExpression.text === 'tasks'
    if (!ts.isIdentifier(node) || seen.has(node.text)) return false
    if (taskAliases.has(node.text)) return true
    seen.add(node.text)
    const value = values.get(node.text)
    return value !== undefined && taskTable(value, seen)
  }
  function updatesTask(expression: ts.Expression, seen = new Set<string>()): boolean {
    const node = unwrap(expression)
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      seen.add(node.text)
      const value = values.get(node.text)
      return value !== undefined && updatesTask(value, seen)
    }
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false
    if (node.expression.name.text === 'update')
      return node.arguments[0] !== undefined && taskTable(node.arguments[0])
    return updatesTask(node.expression.expression, seen)
  }
  function configReadAdapter(node: ts.Node): boolean {
    if (path === reader || path === 'modules/task-execution/infrastructure/taskRepositorySql.ts')
      return true
    if (path !== sharedReader) return false
    // Only this shared epoch-1 row adapter may read the physical key. Other shared helpers
    // stay in the corpus, including helpers handed a whole tasks row by a backend query.
    let parent: ts.Node | undefined = node
    while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent
    return (
      parent !== undefined &&
      ts.isFunctionDeclaration(parent) &&
      parent.name?.text === 'taskWorkgroupConfigFromRow'
    )
  }
  function propertyName(node: ts.PropertyName): string {
    if (ts.isComputedPropertyName(node)) return propertyName(node.expression as ts.PropertyName)
    return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : node.getText(file)
  }
  function fields(expression: ts.Expression, seen = new Set<string>(), spread = false): string[] {
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) return spread ? ['unknown-spread'] : []
      seen.add(expression.text)
      const value = values.get(expression.text)
      return value === undefined ? (spread ? ['unknown-spread'] : []) : fields(value, seen, spread)
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      return fields(expression.expression, seen, spread)
    if (ts.isConditionalExpression(expression))
      return [
        ...fields(expression.whenTrue, new Set(seen), spread),
        ...fields(expression.whenFalse, new Set(seen), spread),
      ]
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    )
      return fields(expression.right, new Set(seen), spread)
    if (
      ts.isBinaryExpression(expression) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
        expression.operatorToken.kind,
      )
    )
      return [
        ...fields(expression.left, new Set(seen), spread),
        ...fields(expression.right, new Set(seen), spread),
      ]
    if (!ts.isObjectLiteralExpression(expression)) return spread ? ['unknown-spread'] : []
    return expression.properties.flatMap((property) =>
      ts.isSpreadAssignment(property)
        ? fields(property.expression, new Set(seen), true)
        : [propertyName(property.name)],
    )
  }
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'set'
    ) {
      if (updatesTask(node.expression.expression)) {
        for (const argument of node.arguments)
          for (const key of fields(argument)) {
            if (frozen.has(key) || key === 'unknown-spread') violations.push(`write:${key}`)
          }
      }
    }
    if (!configReadAdapter(node)) {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'workgroupConfigJson')
        violations.push('read:workgroupConfigJson')
      if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === 'workgroupConfigJson'
      )
        violations.push('read:workgroupConfigJson')
      if (
        ts.isBindingElement(node) &&
        propertyName(node.propertyName ?? (node.name as ts.PropertyName)) === 'workgroupConfigJson'
      )
        violations.push('read:workgroupConfigJson')
    }
    if (ts.isTaggedTemplateExpression(node) && /^sql(?:\.|$)/.test(node.tag.getText(file))) {
      const raw = node.template.getText(file)
      if (/\bUPDATE\s+["\w.]*tasks["\s]/i.test(raw) && physical.test(raw))
        violations.push('write:sql-definition')
      if (!configReadAdapter(node) && /\bworkgroup_config_json\b/.test(raw))
        violations.push('read:sql-config')
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'sql.raw') {
      const raw = node.arguments[0]?.getText(file) ?? ''
      if (/\bUPDATE\s+["\w.]*tasks["\s]/i.test(raw) && physical.test(raw))
        violations.push('write:sql-definition')
      if (!configReadAdapter(node) && /\bworkgroup_config_json\b/.test(raw))
        violations.push('read:sql-config')
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return violations
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : []
  })
}

test('all backend and shared sources keep definition writes and configuration reads inside the adapters', () => {
  const sharedRoot = resolve(root, '../../shared/src')
  const backend = sources(root)
  const shared = sources(sharedRoot)
  expect(backend.length).toBeGreaterThan(1000)
  expect(shared.length).toBeGreaterThan(100)
  const files = [...backend, ...shared]
  expect(files.length).toBeGreaterThan(1000)
  expect(
    files.flatMap((file) => {
      const path = shared.includes(file)
        ? `shared/${relative(sharedRoot, file).replaceAll('\\', '/')}`
        : relative(root, file).replaceAll('\\', '/')
      return definitionBoundaryViolations(path, readFileSync(file, 'utf8')).map(
        (finding) => `${path}: ${finding}`,
      )
    }),
  ).toEqual([])
})

test('negative fixture catches inline, aliased, spread, computed and raw SQL writes plus config reads', () => {
  expect(
    definitionBoundaryViolations(
      'modules/example/infrastructure/store.ts',
      `
    const snapshot = { workflowSnapshot: 'next' };
    const patch = { ...snapshot, ['workflowVersion']: 2 };
    db.update(tasks).set(patch);
    const config = row.workgroupConfigJson;
    const config2 = row['workgroupConfigJson'];
    const { workgroupConfigJson: config3 } = row;
  `,
    ),
  ).toEqual([
    'write:workflowSnapshot',
    'write:workflowVersion',
    'read:workgroupConfigJson',
    'read:workgroupConfigJson',
    'read:workgroupConfigJson',
  ])
  expect(
    definitionBoundaryViolations(
      'store.ts',
      'db.execute(sql`UPDATE tasks SET workflow_snapshot = value`)',
    ),
  ).toEqual(['write:sql-definition'])
  expect(
    definitionBoundaryViolations(
      'store.ts',
      'db.execute(sql`SELECT workgroup_config_json FROM tasks`)',
    ),
  ).toEqual(['read:sql-config'])
  expect(
    definitionBoundaryViolations('store.ts', 'db.update(tasks).set({ workgroupConfigJson: next })'),
  ).toEqual(['write:workgroupConfigJson'])
  expect(definitionBoundaryViolations('store.ts', 'db.update(tasks).set({ name: next })')).toEqual(
    [],
  )
})

test('negative fixtures catch opaque lifecycle spreads and all task-table receiver forms', () => {
  for (const patch of [
    '{ ...(input.extra ?? {}) }',
    '{ ...input.extra }',
    '{ ...(ok ? input.extra : {}) }',
  ])
    expect(definitionBoundaryViolations('store.ts', `db.update(tasks).set(${patch})`)).toContain(
      'write:unknown-spread',
    )
  for (const [setup, receiver] of [
    ['', 'tablesOf(tx).tasks'],
    ['const table = tablesOf(tx).tasks;', 'table'],
    ['const { tasks: taskTable } = tablesOf(tx);', 'taskTable'],
    ['const table = tasks; const alias = table;', 'alias'],
    ["import { tasks as taskRows } from './schema';", 'taskRows'],
    ['', "tablesOf(tx)['tasks']"],
  ])
    expect(
      definitionBoundaryViolations(
        'store.ts',
        `${setup} db.update(${receiver}).set({ workflowSnapshot: next })`,
      ),
    ).toEqual(['write:workflowSnapshot'])
  expect(
    definitionBoundaryViolations(
      'store.ts',
      'const query = db.update(tablesOf(tx).tasks); query.set({ workflowSnapshot: next })',
    ),
  ).toEqual(['write:workflowSnapshot'])
  expect(
    definitionBoundaryViolations(
      'store.ts',
      'db.update(tasks).set({ ...(ok ? { workflowVersion: 2 } : {}) })',
    ),
  ).toEqual(['write:workflowVersion'])
  expect(
    definitionBoundaryViolations(
      'store.ts',
      'db.update(tasks).set({ ...(ok ? { name: next } : {}) })',
    ),
  ).toEqual([])
})

test('negative fixtures cover raw SQL calls and whole-row reads hidden in shared helpers', () => {
  expect(
    definitionBoundaryViolations('store.ts', "sql.raw('SELECT workgroup_config_json FROM tasks')"),
  ).toEqual(['read:sql-config'])
  const query = 'const [row] = await db.select().from(tasks); return sharedHelper(row)'
  const helper = 'export function sharedHelper(row) { return JSON.parse(row.workgroupConfigJson) }'
  expect([
    ...definitionBoundaryViolations('store.ts', query),
    ...definitionBoundaryViolations('shared/hiddenConfig.ts', helper),
  ]).toEqual(['read:workgroupConfigJson'])
  // Even a new helper in the canonical shared file cannot borrow the row adapter exception.
  expect(definitionBoundaryViolations(sharedReader, helper)).toEqual(['read:workgroupConfigJson'])
  expect(
    definitionBoundaryViolations(
      sharedReader,
      'export function taskWorkgroupConfigFromRow(row) { return decodeTaskWorkgroupConfig(row.workgroupConfigJson) }',
    ),
  ).toEqual([])
})

test('the three existing command sites and legacy lifecycle companion use the one writer', () => {
  const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
  const sync = read('modules/task-execution/infrastructure/taskRouteOperations.ts')
  expect(sync).toContain('createTaskDefinitionWriteParticipantInTx(tx).syncWorkflow(')
  expect(sync).toContain("'task-not-syncable'")
  const room = read('modules/task-execution/infrastructure/workgroupTaskRoomTaskParticipant.ts')
  expect(room).toContain('.replaceWorkgroupRuntimeConfig(')
  expect(room).toContain('.continueWorkgroupTask(')
  expect(room).toContain('if (!changed) return false')
  expect(room).toContain('if (!changed) return null')
  expect(read('modules/task-execution/infrastructure/taskLifecycleWriteSequence.ts')).toContain(
    '.transitionLifecycle(input)',
  )
})

// Reader-side routing is deliberate: launch identity/mode and current editable roster differ.
test('each reader uses its launch or runtime side', () => {
  const sites: ReadonlyArray<readonly [string, string]> = [
    // RFC-395 II-a A7: rowToTask and its launch projection moved to the owner query.
    ['modules/task-execution/infrastructure/taskDetailQueries.ts', '.launch.workgroupName'],
    ['modules/task-execution/infrastructure/taskDetailQueries.ts', '.launch.goal'],
    ['services/execution/outcome.ts', 'workgroupLaunchMode(task.workgroupConfig?.launch)'],
    ['services/dynamicWorkflowRunner.ts', 'row.workgroupConfig?.runtime.config'],
    [
      'modules/task-execution/engine/task/taskEngineRegistry.ts',
      'workgroupLaunchMode(task.workgroupConfig?.launch)',
    ],
    [
      'modules/task-execution/infrastructure/taskRouteOperations.ts',
      'row.workgroupLaunch?.workgroupName',
    ],
    [
      'modules/task-execution/infrastructure/taskRouteOperations.ts',
      'taskWorkgroupConfigFromRow(row).launch.workgroupName',
    ],
    ['modules/task-execution/infrastructure/taskRouteOperations.ts', '.launch.goal'],
    ['modules/task-execution/infrastructure/taskRouteOperations.ts', '.launch.mode'],
    [
      'modules/task-execution/infrastructure/taskRouteRepairOperations.ts',
      'ctx.task.workgroupConfig?.launch.mode',
    ],
    [
      'modules/task-execution/infrastructure/taskListPage/filters.ts',
      'taskWorkgroupNameExpression(db, alias)',
    ],
    ['modules/collaboration/infrastructure/taskQuestions.ts', 't.workgroupConfig?.launch.mode'],
    [
      'modules/collaboration/infrastructure/taskQuestionDispatch.ts',
      'taskRow.workgroupConfig?.launch.mode',
    ],
    [
      'modules/collaboration/infrastructure/collaborationWorkgroupClarify.ts',
      'row.config.runtime.raw',
    ],
    [
      'modules/collaboration/infrastructure/collaborationWorkgroupClarify.ts',
      'row.config.launch.mode',
    ],
    ['modules/memory/application/distill/schedule.ts', 'taskRow.workgroupConfig?.runtime.config'],
    [
      'modules/resource-catalog/infrastructure/workgroupTaskRoom.ts',
      'parseConfig(task?.workgroupConfig?.runtime)',
    ],
    [
      'modules/resource-catalog/infrastructure/workgroupTaskRoomQueries.ts',
      'parseConfig(task.workgroupConfig?.runtime)',
    ],
    [
      'modules/resource-catalog/infrastructure/workgroupTaskRoomCommands.ts',
      'loaded.task.workgroupConfig?.runtime.revision',
    ],
    [
      'modules/resource-catalog/infrastructure/workgroupTurnsOperations.ts',
      'hostSnapshot.workgroupConfig?.runtime.config',
    ],
    [
      'modules/task-execution/infrastructure/taskEngineApplicationPersistence.ts',
      'workgroupConfig: taskWorkgroupConfigFromRow(task)',
    ],
  ]
  for (const [path, expression] of sites)
    expect(readFileSync(resolve(root, path), 'utf8')).toContain(expression)
  const commands = readFileSync(
    resolve(root, 'modules/resource-catalog/infrastructure/workgroupTaskRoomCommands.ts'),
    'utf8',
  )
  expect(commands).toContain("'workgroup-config-conflict'")
  expect(commands).toContain("'workgroup-dw-gate-not-open'")
})

test('both workgroup contexts import the shared decoder and types without adding a TaskExecution edge', () => {
  const state = readFileSync(
    resolve(root, 'modules/resource-catalog/infrastructure/legacy/workgroup/state.ts'),
    'utf8',
  )
  const room = readFileSync(
    resolve(root, 'modules/resource-catalog/infrastructure/workgroupTaskRoom.ts'),
    'utf8',
  )
  const adapter = readFileSync(
    resolve(root, 'modules/task-execution/infrastructure/taskWorkgroupConfig.ts'),
    'utf8',
  )
  const decoder = readFileSync(
    resolve(root, 'modules/task-execution/domain/taskWorkgroupConfig.ts'),
    'utf8',
  )
  expect(decoder).toMatch(
    /export\s*\{[^}]*decodeTaskWorkgroupConfig[^}]*\}\s*from '@agent-workflow\/shared'/,
  )
  expect(adapter).toMatch(
    /import\s*\{[^}]*decodeTaskWorkgroupConfig[^}]*\}\s*from '\.\.\/domain\/taskWorkgroupConfig'/,
  )
  expect(adapter).toContain('taskWorkgroupConfigFromRow({')
  expect(adapter).toContain('columns.workgroupLaunchConfigJson')
  expect(adapter).toContain('columns.workgroupConfigJson')
  expect(state).not.toContain('loadDbState')
  expect(state).not.toContain('EngineDbState')
  expect(room).toMatch(
    /import\s*\{[^}]*type TaskWorkgroupRuntimeConfig[^}]*\}\s*from '@agent-workflow\/shared'/,
  )
  expect(state).not.toContain("from '@/modules/task-execution/public/queries'")
  expect(room).not.toContain("from '@/modules/task-execution/public/types'")
})

const subordinateWriters: Readonly<Record<string, readonly string[]>> = {
  taskDefinitions: [writer],
  taskLaunchContexts: [],
  taskWorkspaces: [
    'modules/task-execution/infrastructure/taskPreparationParticipant.ts',
    'modules/task-execution/infrastructure/taskRepositoryUsage.ts',
  ],
  taskRepositoryMounts: [
    'modules/task-execution/infrastructure/taskRepositoryUsage.ts',
    'modules/task-execution/infrastructure/taskEngineApplicationPersistence.ts',
  ],
}
function subordinateUpdateViolations(path: string, text: string): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const aliases = new Map<string, string>(Object.keys(subordinateWriters).map((key) => [key, key]))
  const visit = (node: ts.Node, fn: (node: ts.Node) => void) => {
    fn(node)
    ts.forEachChild(node, (child) => visit(child, fn))
  }
  visit(file, (node) => {
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const original = (node.propertyName ?? node.name).getText(file)
      if (original in subordinateWriters) aliases.set(node.name.text, original)
    }
  })
  const violations: string[] = []
  visit(file, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== 'update'
    )
      return
    const receiver = node.arguments[0]
    const name =
      receiver &&
      (ts.isPropertyAccessExpression(receiver) ? receiver.name.text : receiver.getText(file))
    const table = name === undefined ? undefined : aliases.get(name)
    if (table && !subordinateWriters[table]!.includes(path)) violations.push(table)
  })
  return violations
}
test('Task subordinate UPDATEs have explicit owner writers', () => {
  expect(
    sources(root).flatMap((file) =>
      subordinateUpdateViolations(
        relative(root, file).replaceAll('\\', '/'),
        readFileSync(file, 'utf8'),
      ),
    ),
  ).toEqual([])
  expect(
    subordinateUpdateViolations(
      'unknown.ts',
      'const { taskDefinitions: d } = tablesOf(tx); tx.update(d).set({ inputs: value })',
    ),
  ).toEqual(['taskDefinitions'])
  expect(
    subordinateUpdateViolations('unknown.ts', 'tx.update(tablesOf(tx).taskWorkspaces).set(patch)'),
  ).toEqual(['taskWorkspaces'])
})
test('aggregate lock adapter follows the exported W0 lock order and preserves final-CAS rollback', () => {
  expect(TASK_AGGREGATE_LOCK_ORDER).toEqual([
    'task_execution_owners',
    'tasks',
    'task-subordinate-rows',
    'node_runs',
    'node_run_selections',
  ])
  const text = readFileSync(resolve(root, writer), 'utf8')
  expect(text).toContain('engineOf(tx).lockAggregateRoot(tx, tasks, tasks.id, taskId)')
  const file = ts.createSourceFile(writer, text, ts.ScriptTarget.Latest, true)
  const rootStage = TASK_AGGREGATE_LOCK_ORDER[1]
  const roots: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'lockAggregateRoot'
    )
      roots.push(node.arguments[1]!.getText(file))
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(roots).toEqual([rootStage])
  expect(text).toContain('throw new TaskAggregateCasMiss(input.taskId)')
  expect(text).toContain('[...new Set(taskIds)].sort()')
})

// W1 fix: fence/root ordering and delegation must remain visible in the actual writers.
test('owned Task writers fence before roots and child launch locks every ancestor before writes', () => {
  for (const [path, fence, rootLock] of [
    [
      'taskEngineApplicationPersistence.ts',
      'await fenceTaskWrite(transaction,',
      'await taskAggregateWrite.lockTaskAggregateRoot(transaction,',
    ],
    [
      'taskRuntimeLifecyclePersistence.ts',
      'await this.fence(tx, input)\n      await taskAggregateWrite',
      'await guard?.(tx)',
    ],
  ]) {
    const source = readFileSync(
      resolve(root, 'modules/task-execution/infrastructure', path!),
      'utf8',
    )
    expect(source.indexOf(fence!)).toBeGreaterThanOrEqual(0)
    expect(source.indexOf(rootLock!)).toBeGreaterThan(source.indexOf(fence!))
  }
  const child = readFileSync(
    resolve(root, 'modules/task-execution/infrastructure/childExecutionLaunchOperations.ts'),
    'utf8',
  )
  const locks = child.indexOf('await lockTaskAggregateRoots(tx, ancestorIds)')
  expect(locks).toBeGreaterThanOrEqual(0)
  expect(locks).toBeLessThan(child.indexOf('await admitTransferredWorkspace(tx,'))
  expect(child).toContain('[...ancestorIds].sort()')
  expect(child).not.toContain('insertOne(tx, workgroupTaskState')
  const scheduler = readFileSync(
    resolve(root, 'modules/task-execution/infrastructure/schedulerCompletionPersistence.ts'),
    'utf8',
  )
  expect(scheduler).toContain('await fenceTaskWrite(tx,')
  expect(scheduler).toContain('createTaskRepositorySourceStore(tx)')
  expect(scheduler).toContain('.updateMount(')
  expect(scheduler).not.toContain('.update(taskRepos)')
})

test('human gate lifecycle owns an injected journal and forwards the same restriction port', () => {
  const source = readFileSync(
    resolve(root, 'modules/task-execution/infrastructure/humanGateTaskLifecyclePersistence.ts'),
    'utf8',
  )
  expect(source).not.toMatch(/^const journal =/m)
  expect(source).toContain('this.journal = new DatabaseHumanGateOperationJournal(')
  expect(source).toContain(
    'private readonly options: { readonly historyRestrictions: HistoryRestrictionPort }',
  )
  expect(source).toMatch(
    /createHumanGatePersistenceParticipantInTx,\s*options\??\.historyRestrictions,/,
  )
  expect(source).toMatch(
    /createConsumedInputsParticipantInTx\(\),\s*this\.options\??\.historyRestrictions,/,
  )
  const fenceStart = source.indexOf('async function fence(')
  const fenceEnd = source.indexOf('async function parkRevision(')
  const fence = source.slice(fenceStart, fenceEnd)
  expect(fence.indexOf('await assertTaskOwnerTx(')).toBeGreaterThanOrEqual(0)
  expect(fence.indexOf('await taskAggregateWrite.lockTaskAggregateRoot(')).toBeGreaterThan(
    fence.indexOf('await assertTaskOwnerTx('),
  )
})

test('node mint explicitly distinguishes unrecorded from recorded-empty inputs', () => {
  const source = readFileSync(
    new URL(
      '../../src/modules/task-execution/infrastructure/nodeRunMintParticipant.ts',
      import.meta.url,
    ),
    'utf8',
  )
  expect(source).toContain('inputsRecorded: record.recordedInputs !== null')
})
