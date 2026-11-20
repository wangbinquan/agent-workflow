// RFC-521 — 组合层适配器回落的全模块门与清单（RFC-294 S12 第二步）。
//
// RFC-294 plan §3 S12 第 1 项：模块 composition 的适配器回退改为必填注入，单机默认值只留在 standalone profile；日志器一类中性默认登记在案。
// 本门覆盖全部模块的组合层（每个模块的 `composition/` 目录与模块根 `composition.ts`，判定与 RFC-515 门相同），按语法树找“回落时构造”：
// `??` / `??=` / `||` / `||=` 的右侧，以 `=== undefined` / `== null` 一类为条件的条件表达式的回落分支，`if (x === undefined) x = …` 的赋值，
// 参数与解构元素的缺省值——回落一侧是调用或 `new`（含挂在它们上的属性读取与调用链）。每个文件实测的被调用者与登记表逐条相等：中性默认带类别，
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
  option: 'a business option decides which use case runs',
  pure: 'a pure computation over the injected inputs',
  'process-local': 'an in-process push or limiter, the same in every profile',
} as const
type Kind = keyof typeof NEUTRAL | 'adapter'
type Entry = readonly [callee: string, kind: Kind]

/** design §3: every construction in a fallback position, per composition file (paths under `src/modules/`), sorted. */
const REGISTERED: Readonly<Record<string, readonly Entry[]>> = {
  'code-capability/composition/historyQueries.ts': [['createUnboundCodeHistoryReader', 'adapter']],
  'development-automation/composition.ts': [
    ['createAdmissionLookup', 'adapter'],
    ['new EvidenceStore', 'adapter'],
  ],
  'development-automation/composition/developmentDelivery.ts': [
    ['composeLegacyDevelopmentPipelineEvidence', 'adapter'],
  ],
  'development-automation/composition/digitalEmployeePlatformWorkItems.ts': [
    ['new EvidenceStore', 'adapter'],
  ],
  'development-automation/composition/evidenceStaging.ts': [
    ['createFileEvidenceDocumentCommands', 'adapter'],
  ],
  'development-automation/composition/missionInputUploads.ts': [
    ['lazyEvidenceBlobs', 'adapter'],
    ['new EvidenceStore', 'adapter'],
  ],
  'digital-employee/composition.ts': [
    ['Date.now', 'clock'],
    ['Date.now', 'clock'],
    ['composeDigitalEmployeeWriterCutoverFor', 'adapter'],
    ['createEmployeeInputArtifactStore', 'adapter'],
    ['createProgramArtifactStore', 'adapter'],
    ['service.getExecutionPolicy', 'option'],
    ['service.getExecutionPolicy', 'option'],
  ],
  'event-center/composition.ts': [
    ['createUnavailableEventObserverProgram', 'adapter'],
    ['service.initialize', 'memo'],
  ],
  'event-center/composition/localCustomObserverProgram.ts': [
    ['createLocalCustomObserverProgramFactory', 'adapter'],
  ],
  'integration/composition/webhookIngress.ts': [['createWebhookRateLimiters', 'process-local']],
  'intent/composition/apply.ts': [
    ['composeIntentApplyArtifactLifecycle', 'adapter'],
    ['composeIntentApplyResourceBinding', 'adapter'],
    ['composeLegacyIntentSkillArtifactCompat', 'adapter'],
    ['createFileIntentArtifactContent', 'adapter'],
    ['createFileIntentPluginArtifactOwner', 'adapter'],
    ['createFileIntentSkillArtifactOwner', 'adapter'],
    ['createResourceCatalogAclIdentityReadPort', 'adapter'],
    ['join', 'path'],
  ],
  'intent/composition/applyMaintenance.ts': [
    ['composeIntentApplyArtifactLifecycle', 'adapter'],
    ['createLogger', 'logger'],
  ],
  'intent/composition/maintenance.ts': [
    ['createFileIntentScratchStore', 'adapter'],
    ['createLogger', 'logger'],
  ],
  'memory/composition.ts': [['composeMemoryInjectionQueriesFor', 'adapter']],
  'resource-catalog/composition/mcpProbeOperations.ts': [['probeMcp', 'adapter']],
  'resource-catalog/composition/pluginOperations.ts': [['createLocalPluginInstaller', 'adapter']],
  'resource-catalog/composition/postgresqlResourcePackageCatalog.ts': [
    ['createFileResourcePackagePluginArtifactOwner', 'adapter'],
    ['createFileResourcePackageSkillArtifactOwner', 'adapter'],
    ['join', 'path'],
  ],
  'resource-catalog/composition/resourcePackageMaintenance.ts': [
    ['createLogger', 'logger'],
    ['createVersionedResourcePackageArtifactRecovery', 'adapter'],
  ],
  'resource-catalog/composition/resourcePackageProvider.ts': [
    ['createFileSkillPackageContentReader', 'adapter'],
  ],
  'resource-catalog/composition/skillOperations.ts': [
    ['createFileSkillContentReader', 'adapter'],
    ['createFileSkillCreationContentStore', 'adapter'],
    ['createFileSkillDeletionContentStore', 'adapter'],
    ['createFileSkillLifecycleContentStore', 'adapter'],
    ['createFileSkillVersionContentReader', 'adapter'],
    ['createFileSkillVersionContentStore', 'adapter'],
  ],
  'resource-catalog/composition/skillVersionCommit.ts': [
    ['createFileSkillTreeContentStore', 'adapter'],
  ],
  'resource-catalog/composition/workflowOperations.ts': [
    ['createFileSkillVersionPresenceQueries', 'adapter'],
  ],
  'resource-catalog/composition/workgroupOperations.ts': [
    ['createWorkgroupEvents', 'process-local'],
    ['createWorkgroupEvents', 'process-local'],
  ],
  'source-control/composition.ts': [['createFileEmployeeCaseWorkspaceEffectsFactory', 'adapter']],
  'source-control/composition/conflictMerge.ts': [
    ['createFileConflictMergeWorkspaceEffects', 'adapter'],
  ],
  'source-control/composition/isolationWorkspaces.ts': [
    ['createLocalIsolationWorkspaceFactory', 'adapter'],
  ],
  'source-control/composition/repositoryCandidate.ts': [
    ['commitCandidate', 'injected'],
    ['deriveChangeCandidate', 'injected'],
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
    ['createFileDatabaseConfiguration().read', 'adapter'],
    ['join', 'path'],
    ['join', 'path'],
    ['join', 'path'],
    ['repositoryBackupPreparationFactory', 'injected'],
    ['resolveDatabaseProviderRuntimeForRestore', 'adapter'],
    ['sqliteRuntime.openClient', 'memo'],
  ],
  'system-operations/composition/daemonHostLifecycle.ts': [
    ['createFileDaemonRuntimeQueries', 'adapter'],
    ['createNativeDaemonHostLifecycle', 'adapter'],
  ],
  'system-operations/composition/databaseMigration.ts': [
    ['createFileDatabaseConfiguration', 'adapter'],
  ],
  'system-operations/composition/installationSeedCompletion.ts': [
    ['createFileInstallationSeedCompletion', 'adapter'],
  ],
  'system-operations/composition/manualDatabaseMigration.ts': [
    ['createFileDatabaseConfiguration', 'adapter'],
  ],
  'task-execution/composition/bootRecovery.ts': [
    ['Date.now', 'clock'],
    ['createLocalBootExecutionRecoveryFactory', 'adapter'],
  ],
  'task-execution/composition/digitalEmployeeExecution.ts': [
    ['createFileProgramToolSource', 'adapter'],
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

/** design D3: the S12 item 1 step that clears each module's adapter fallbacks. */
const SUCCESSORS: Readonly<Record<string, string>> = {
  'source-control': 'S12 item 1, step 2',
  'resource-catalog': 'S12 item 1, step 3',
  'task-execution': 'S12 item 1, step 4',
  intent: 'S12 item 1, step 5',
  'code-capability': 'S12 item 1, step 5',
  memory: 'S12 item 1, step 5',
  'system-operations': 'S12 item 1, step 6',
  'development-automation': 'S12 item 1, step 6',
  'digital-employee': 'S12 item 1, step 7',
  'event-center': 'S12 item 1, step 7',
}
/** Adapter fallbacks measured at RFC-521; each successor lowers it. */
const ADAPTER_FALLBACKS = 72
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

/** The callee when the fallback constructs (a call, `new`, or a property read off one), otherwise null. */
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

/** The single assignment `x = …` an `if (x === undefined)` makes, if that is all it does. */
function absentAssignment(node: ts.IfStatement): ts.Expression | undefined {
  if (absenceCheck(node.expression) !== true) return undefined
  const body = node.thenStatement
  const statement = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0]! : body
  if (!ts.isExpressionStatement(statement)) return undefined
  const assignment = statement.expression
  return ts.isBinaryExpression(assignment) &&
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ? assignment.right
    : undefined
}

/** Every construction in a fallback position, as sorted callees. */
function fallbacks(unit: SourceUnit): string[] {
  const found: string[] = []
  const record = (node: ts.Expression | undefined) => {
    const callee = node === undefined ? null : construction(node)
    if (callee !== null) found.push(callee)
  }
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && FALLBACK_OPERATORS.has(node.operatorToken.kind))
      record(node.right)
    if (ts.isConditionalExpression(node)) {
      const check = absenceCheck(node.condition)
      if (check !== null) record(check ? node.whenTrue : node.whenFalse)
    }
    if (ts.isIfStatement(node)) record(absentAssignment(node))
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
