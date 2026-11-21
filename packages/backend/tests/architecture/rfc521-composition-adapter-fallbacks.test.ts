// RFC-521 — 组合层适配器回落的全模块门与清单（RFC-294 S12 第二步）。
//
// RFC-294 plan §3 S12 第 1 项：模块 composition 的适配器回退改为必填注入，单机默认值只留在 standalone profile；日志器一类中性默认登记在案。
// 本门覆盖全部模块的组合层（每个模块的 `composition/` 目录与模块根 `composition.ts`，判定与 RFC-515 门相同），按语法树找“回落时构造”：
// `??` / `??=` / `||` / `||=` 的右侧，以 `=== undefined` / `== null` 一类为条件的条件表达式的回落分支，`if (x === undefined) { … }` 里的赋值，
// 守卫返回（`if (x === undefined) return …`；`if (x !== undefined) return x` 之后同一块里的下一个 `return`），参数与解构元素的缺省值——回落
// 一侧是调用或 `new`（含挂在它们上的属性读取与调用链；回落本身是条件表达式时看它的两个分支）。每个文件实测的被调用者与登记表逐条相等：中性默认带类别，
// 适配器回落由 S12 第 1 项按模块的后继清偿；清单外的回落与清单里已不存在的条目都报红。适配器回落的总数钉为实测，只减不增。
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const ROOT = resolve(import.meta.dir, '../../../..')
const MODULES = 'packages/backend/src/modules/'

/** design D2: a neutral default stays and names one of these categories. */
const NEUTRAL = {
  logger: 'a logger for the composed object',
  clock: 'the current time when no clock was given',
  id: 'a fresh id when none was given',
  path: 'a path derived from an injected root',
  memo: 'memoised construction of an object this composition owns',
  injected: 'calls an injected factory, or picks between two injected shapes',
  option: 'an option decides which path runs; the absent branch is the main path, not a stand-in',
  pure: 'a pure computation over the injected inputs',
  'process-local': 'an in-process push or limiter, the same in every profile',
} as const
type Kind = keyof typeof NEUTRAL | 'adapter'
type Entry = readonly [callee: string, kind: Kind]

/** design §3: every construction in a fallback position, per composition file (paths under `src/modules/`), sorted. */
const REGISTERED: Readonly<Record<string, readonly Entry[]>> = {
  'digital-employee/composition.ts': [
    ['Date.now', 'clock'],
    ['Date.now', 'clock'],
    ['service.getExecutionPolicy', 'option'],
    ['service.getExecutionPolicy', 'option'],
  ],
  'event-center/composition.ts': [['service.initialize', 'memo']],
  'integration/composition/webhookIngress.ts': [['createWebhookRateLimiters', 'process-local']],
  'intent/composition/apply.ts': [['join', 'path']],
  'intent/composition/applyMaintenance.ts': [['createLogger', 'logger']],
  'intent/composition/maintenance.ts': [['createLogger', 'logger']],
  'resource-catalog/composition/resourcePackageMaintenance.ts': [
    ['createLogger', 'logger'],
    ['createLogger', 'logger'],
  ],
  'resource-catalog/composition/workgroupOperations.ts': [
    ['createWorkgroupEvents', 'process-local'],
    ['createWorkgroupEvents', 'process-local'],
  ],
  'source-control/composition.ts': [
    ['createFileEmployeeCaseWorkspaceEffectsFactory', 'adapter'],
    ['new WeakMap', 'memo'],
  ],
  'source-control/composition/cachedRepositoryOperations.ts': [['refreshCachedRepo', 'adapter']],
  'source-control/composition/conflictMerge.ts': [
    ['createFileConflictMergeWorkspaceEffects', 'adapter'],
    ['createFileConflictMergeWorkspaceEffects', 'adapter'],
  ],
  'source-control/composition/isolationWorkspaces.ts': [
    ['createLocalIsolationWorkspaceFactory', 'adapter'],
  ],
  'source-control/composition/repositoryCandidate.ts': [
    ['commitCandidate', 'injected'],
    ['createFileRepositoryCandidateEffectsFactory', 'adapter'],
    ['deriveChangeCandidate', 'injected'],
    ['pushCandidate', 'adapter'],
    ['pushCandidate', 'injected'],
    ['stageCandidateTree', 'injected'],
  ],
  'source-control/composition/repositoryCommit.ts': [
    ['commitPreparedRepository', 'adapter'],
    ['createFileRepositoryPreviewIndexPort', 'adapter'],
    ['prepareRepositoryCommit', 'adapter'],
    ['readRepositoryCommitPreview', 'adapter'],
  ],
  'source-control/composition/repositoryGitWorkspaces.ts': [
    ['createFileRepositoryGitWorkspaceFactory', 'adapter'],
  ],
  'source-control/composition/repositoryMirrors.ts': [['createLocalRepositoryMirrors', 'adapter']],
  'source-control/composition/repositoryPreparation.ts': [
    ['composeLocalRepositoryPreparationEffects', 'adapter'],
    ['composeLocalScratchWorkspaceEffects', 'adapter'],
  ],
  'source-control/composition/repositoryWorkspaceReadQueries.ts': [
    ['createFileRepositoryWorkspaceReadQueries', 'adapter'],
  ],
  'source-control/composition/workspaceExcludeProfiles.ts': [['Object.freeze', 'adapter']],
  'source-control/composition/workspaceMaintenance.ts': [
    ['createNodeWorkspaceMaintenanceFilesystem', 'adapter'],
  ],
  'source-control/composition/workspaceUploads.ts': [
    ['createFileWorkspaceUploadContentFactory', 'adapter'],
  ],
  'system-operations/composition.ts': [
    ['Object.freeze', 'injected'],
    ['buildPostgresqlSchemaPlan', 'pure'],
    ['join', 'path'],
    ['join', 'path'],
    ['join', 'path'],
    ['repositoryBackupPreparationFactory', 'injected'],
    ['sqliteRuntime.openClient', 'memo'],
  ],
  'task-execution/composition/bootRecovery.ts': [
    ['Date.now', 'clock'],
    ['createLocalBootExecutionRecoveryFactory', 'adapter'],
  ],
  'task-execution/composition/commitPushBinding.ts': [
    ['createFileTaskOperationConfiguration', 'adapter'],
  ],
  'task-execution/composition/crewstationSystemAgentRunFamily.ts': [['Object.freeze', 'option']],
  'task-execution/composition/digitalEmployeeExecution.ts': [
    ['createFileProgramToolSource', 'adapter'],
  ],
  'task-execution/composition/executionWorkspaceBinding.ts': [
    ['createTaskWorkspaceSession', 'memo'],
  ],
  'task-execution/composition/launchConfiguration.ts': [
    ['localRuntime', 'adapter'],
    ['localRuntime', 'adapter'],
    ['localStart', 'adapter'],
  ],
  'task-execution/composition/nodeRunPrompts.ts': [
    ['composeNodeRunPromptOperations', 'adapter'],
    ['createFileNodeRunPromptContent', 'adapter'],
  ],
  'task-execution/composition/portArtifacts.ts': [
    ['composePortArtifactOperations', 'adapter'],
    ['composePortArtifactOperations', 'adapter'],
    ['createFilePortArtifactContent', 'adapter'],
  ],
  'task-execution/composition/providerRuntime.ts': [
    ['composeTaskWorkspaceExcludeProfilesFor', 'adapter'],
  ],
  'task-execution/composition/runtimeConfigFreeze.ts': [
    ['createFileTaskOperationConfiguration', 'adapter'],
  ],
  'task-execution/composition/systemAgentObservations.ts': [['ulid', 'id']],
  'task-execution/composition/systemAgentRun.ts': [['createLogger', 'logger']],
  'task-execution/composition/taskArchiveMaintenance.ts': [
    ['createFileTaskArchiveContent', 'adapter'],
  ],
  'task-execution/composition/taskDeletionEffects.ts': [
    ['composeLocalTaskDeletionEffects', 'adapter'],
  ],
  'task-execution/composition/taskEngineApplication.ts': [['createLogger', 'logger']],
  'task-execution/composition/taskExecutionPersistence.ts': [
    ['createFileWorkspacePresenceQueries', 'adapter'],
  ],
}

/** design D3 (reordered by RFC-522 design D4): the S12 item 1 step that clears each module's adapter fallbacks. */
const SUCCESSORS: Readonly<Record<string, string>> = {
  'task-execution': 'S12 item 1, step 6',
  'source-control': 'S12 item 1, step 7',
}
/**
 * Adapter fallbacks measured at RFC-521 (83); each successor lowers it — RFC-522 cleared digital-employee and event-center,
 * RFC-523 intent, code-capability and memory, RFC-524 system-operations and development-automation, RFC-525 resource-catalog.
 */
const ADAPTER_FALLBACKS = 35
const UNITS = backendUnits(ROOT)

/** A `composition/` file or a module root `composition.ts` (the RFC-515 gate's rule). */
function isComposition(path: string): boolean {
  if (!path.startsWith(MODULES) || !path.endsWith('.ts')) return false
  const parts = path.slice(MODULES.length).split('/')
  return parts.length === 2 ? parts[1] === 'composition.ts' : parts[1] === 'composition'
}

const FALLBACK_OPERATORS = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.BarBarEqualsToken,
])

const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAwaitExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = current.expression
  return current
}

/** A callee as text, argument lists inside the chain written `()`: `createFileDatabaseConfiguration().read`. */
function calleeText(node: ts.Expression): string {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return `${calleeText(node.expression)}.${node.name.text}`
  if (ts.isCallExpression(node)) return `${calleeText(node.expression)}()`
  return node.getText().replace(/\s+/g, '')
}

/** The callee when the expression constructs (a call, `new`, or a property read off one), otherwise null. */
function construction(node: ts.Expression): string | null {
  const expression = unwrap(node)
  if (ts.isNewExpression(expression)) return `new ${calleeText(expression.expression)}`
  if (ts.isCallExpression(expression)) return calleeText(expression.expression)
  if (ts.isPropertyAccessExpression(expression)) {
    const inner = construction(expression.expression)
    return inner === null ? null : `${inner}().${expression.name.text}`
  }
  return null
}

/** The constructions a fallback makes: itself, or either branch of a conditional fallback (`x ?? (p ? undefined : create…())`). */
function constructions(node: ts.Expression): string[] {
  const expression = unwrap(node)
  if (ts.isConditionalExpression(expression))
    return [...constructions(expression.whenTrue), ...constructions(expression.whenFalse)]
  const callee = construction(expression)
  return callee === null ? [] : [callee]
}

const absent = (node: ts.Expression) =>
  (ts.isIdentifier(node) && node.text === 'undefined') || node.kind === ts.SyntaxKind.NullKeyword

/** true when the condition holds for an absent subject (`x === undefined`), false for its negation, null otherwise. */
function absenceCheck(condition: ts.Expression): boolean | null {
  const expression = unwrap(condition)
  if (!ts.isBinaryExpression(expression)) return null
  if (!absent(expression.left) && !absent(expression.right)) return null
  const operator = expression.operatorToken.kind
  if (
    operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    operator === ts.SyntaxKind.EqualsEqualsToken
  )
    return true
  if (
    operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    operator === ts.SyntaxKind.ExclamationEqualsToken
  )
    return false
  return null
}

/** The statement an `if` branch reduces to when it holds a single statement. */
const single = (body: ts.Statement): ts.Statement =>
  ts.isBlock(body) && body.statements.length === 1 ? body.statements[0]! : body

/**
 * Guard returns: `if (x === undefined) return …` falls back in its own return; `if (x !== undefined) return x` falls back in the
 * next `return` of the same block.
 */
function guardReturn(node: ts.IfStatement): ts.Expression | undefined {
  const check = absenceCheck(node.expression)
  if (check === null || node.elseStatement !== undefined) return undefined
  const then = single(node.thenStatement)
  if (!ts.isReturnStatement(then)) return undefined
  if (check) return then.expression
  const block = node.parent
  if (!ts.isBlock(block) && !ts.isSourceFile(block)) return undefined
  const after = block.statements.slice(block.statements.indexOf(node) + 1)
  const next = after.find((statement) => ts.isReturnStatement(statement))
  return next !== undefined && ts.isReturnStatement(next) ? next.expression : undefined
}

/** The values `if (x === undefined) { … }` assigns in its own statements (`x = …`). */
function absentAssignments(node: ts.IfStatement): ts.Expression[] {
  if (absenceCheck(node.expression) !== true) return []
  const body = node.thenStatement
  const statements = ts.isBlock(body) ? body.statements : [body]
  return statements.flatMap((statement) =>
    ts.isExpressionStatement(statement) &&
    ts.isBinaryExpression(statement.expression) &&
    statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? [statement.expression.right]
      : [],
  )
}

/** Every construction in a fallback position, as sorted callees. */
function fallbacks(unit: SourceUnit): string[] {
  const found: string[] = []
  const record = (node: ts.Expression | undefined) => {
    if (node !== undefined) found.push(...constructions(node))
  }
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && FALLBACK_OPERATORS.has(node.operatorToken.kind))
      record(node.right)
    if (ts.isConditionalExpression(node)) {
      const check = absenceCheck(node.condition)
      if (check !== null) record(check ? node.whenTrue : node.whenFalse)
    }
    if (ts.isIfStatement(node)) {
      for (const value of absentAssignments(node)) record(value)
      record(guardReturn(node))
    }
    if ((ts.isParameter(node) || ts.isBindingElement(node)) && node.initializer !== undefined)
      record(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return found.sort()
}

/** Fallback constructions outside the registry, and registered entries no longer found (each entry counts once). */
function gate(
  units: readonly SourceUnit[],
  registered: Readonly<Record<string, readonly Entry[]>> = REGISTERED,
): { unregistered: string[]; stale: string[] } {
  const unregistered: string[] = []
  const stale: string[] = []
  for (const unit of units) {
    if (!isComposition(unit.path)) continue
    const file = unit.path.slice(MODULES.length)
    const expected = (registered[file] ?? []).map(([callee]) => callee)
    for (const callee of fallbacks(unit)) {
      const index = expected.indexOf(callee)
      if (index === -1) unregistered.push(`${file}: ${callee}`)
      else expected.splice(index, 1)
    }
    for (const callee of expected) stale.push(`${file}: ${callee}`)
  }
  return { unregistered: unregistered.sort(), stale: stale.sort() }
}

test('live corpus: every construction in a fallback position in module composition is registered', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  expect(UNITS.filter((unit) => isComposition(unit.path)).length).toBeGreaterThanOrEqual(330)
  expect(gate(UNITS)).toEqual({ unregistered: [], stale: [] })
  const files = Object.keys(REGISTERED)
  expect(files.filter((file) => !existsSync(resolve(ROOT, MODULES, file)))).toEqual([])
  expect(files.filter((file) => !isComposition(MODULES + file))).toEqual([])
  expect([...files].sort()).toEqual(files)
  for (const [file, entries] of Object.entries(REGISTERED)) {
    const keys = entries.map((entry) => entry.join('\u0000'))
    expect([file, [...keys].sort()]).toEqual([file, keys])
  }
  const entries = Object.entries(REGISTERED).flatMap(([file, list]) =>
    list.map(([callee, kind]) => ({ file, callee, kind })),
  )
  expect(entries.filter(({ kind }) => kind !== 'adapter' && !(kind in NEUTRAL))).toEqual([])
  const adapters = entries.filter(({ kind }) => kind === 'adapter')
  expect(adapters).toHaveLength(ADAPTER_FALLBACKS)
  const modules = [...new Set(adapters.map(({ file }) => file.split('/')[0]!))].sort()
  expect(modules).toEqual(Object.keys(SUCCESSORS).sort())
})

test('negative fixtures: every fallback form is caught; fallbacks that do not construct are not', () => {
  const file = MODULES + 'probe/composition/fabricated.ts'
  const found = (body: string) => fallbacks(sourceUnit(file, body))
  for (const [body, callee] of [
    ['export const f = (x?: object) => x ?? createLocalThing()', 'createLocalThing'],
    ['export function f(o: { x?: object }) { o.x ??= createLocalThing() }', 'createLocalThing'],
    ["export const f = (x?: object) => x || createFileThing({ root: '/' })", 'createFileThing'],
    ['export function f(o: { x?: object }) { o.x ||= createFileThing() }', 'createFileThing'],
    [
      'export const f = (x?: object) => (x === undefined ? composeLocalThing() : x)',
      'composeLocalThing',
    ],
    [
      'export const f = (x?: object) => (undefined === x ? composeLocalThing() : x)',
      'composeLocalThing',
    ],
    ['export const f = (x?: object | null) => (x == null ? localThing() : x)', 'localThing'],
    [
      "export const f = (x?: object) => (x !== undefined ? x : new FileStore('/'))",
      'new FileStore',
    ],
    [
      'export function f(x?: object) { if (x === undefined) x = createLocalThing(); return x }',
      'createLocalThing',
    ],
    ['export function f(x = createLocalThing()) { return x }', 'createLocalThing'],
    [
      'export function f({ x = createLocalThing() }: { x?: object }) { return x }',
      'createLocalThing',
    ],
    [
      "export const f = (x?: object) => x ?? createFileConfiguration('/c').read()",
      'createFileConfiguration().read',
    ],
    ['export const f = async (x?: object) => x ?? (await createLocalThing())', 'createLocalThing'],
    ['export const f = (x?: object) => x ?? (createLocalThing() as object)', 'createLocalThing'],
    ['export const f = (o: { now?: () => number }) => o.now?.() ?? Date.now()', 'Date.now'],
    [
      'export function f(x?: object) { if (x === undefined) return createLocalThing(); return x }',
      'createLocalThing',
    ],
    [
      "export function f(x?: object) { if (x !== undefined) return x; const root = '/'; return createFileThing(root) }",
      'createFileThing',
    ],
    [
      'export const f = (x?: object, p?: string) => x ?? (p === undefined ? undefined : createFileThing(p))',
      'createFileThing',
    ],
    [
      "export function f(o: { x?: object }) { if (o.x === undefined) { const root = '/'; o.x = createFileThing(root) } return o.x }",
      'createFileThing',
    ],
  ] as const)
    expect(found(body), body).toEqual([callee])
  for (const body of [
    'export const f = (x?: object) => x ?? {}',
    'export const f = (x?: readonly string[]) => x ?? []',
    'export const f = (x?: object, fallback: object = {}) => x ?? fallback',
    'export const f = (x?: () => object) => x ?? (() => createLocalThing())',
    'export const f = (x?: object) => (x === undefined ? undefined : createLocalThing())',
    'export const f = (x?: number) => (x === 1 ? createLocalThing() : x)',
    'export const f = (x?: object) => (x ? x : createLocalThing())',
    'export function f(x?: object) { if (x !== undefined) return x; return undefined }',
    "export function f(x?: object) { if (x === undefined) throw new Error('missing'); return x }",
    'export const f = (x: object) => createLocalThing(x)',
  ])
    expect(found(body), body).toEqual([])
  const fallback = 'export const f = (x?: object) => x ?? createLocalThing()'
  expect(gate([sourceUnit(file, fallback)]).unregistered).toEqual([
    'probe/composition/fabricated.ts: createLocalThing',
  ])
  expect(gate([sourceUnit(MODULES + 'probe/composition.ts', fallback)]).unregistered).toEqual([
    'probe/composition.ts: createLocalThing',
  ])
  for (const outside of [
    MODULES + 'probe/application/x.ts',
    MODULES + 'probe/infrastructure/composition.ts',
    'packages/backend/src/bootstrap/standalone.ts',
  ])
    expect(gate([sourceUnit(outside, fallback)]).unregistered, outside).toEqual([])
  // A registered entry counts once: a second identical fallback is unregistered, a missing one is stale.
  const listed = 'probe/composition/listed.ts'
  const fabricated: Readonly<Record<string, readonly Entry[]>> = {
    [listed]: [['createLocalThing', 'adapter']],
  }
  const twice =
    'export const f = (x?: object, y?: object) => [x ?? createLocalThing(), y ?? createLocalThing()]'
  expect(gate([sourceUnit(MODULES + listed, twice)], fabricated)).toEqual({
    unregistered: [`${listed}: createLocalThing`],
    stale: [],
  })
  expect(gate([sourceUnit(MODULES + listed, 'export const f = 1')], fabricated)).toEqual({
    unregistered: [],
    stale: [`${listed}: createLocalThing`],
  })
})
