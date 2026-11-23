// RFC-550 — 十个 context 的未消费 public 符号清零（RFC-294 S9 第六步）。
//
// 锁四件事：
// ① 撤空的三个 public 文件（code-capability `public/queries`、event-center `public/commands` 与 `public/queries`）不在；backend 的
//    src / 用例 / 脚本、仓根脚本与 e2e 零 import 它们（`preProcessFile` 取全部模块引用：静态、re-export、type、动态 import 与 require；
//    别名与相对路径都认，带负对照）。
// ② 被撤出的符号（`tests/fixtures/rfc550-withdrawn-public-symbols.json`：85c36f1c0 时十个 context public 文件的导出里、撤出后不在的
//    逐名清单）不在原 public 文件的导出里，值也不在运行时命名空间里；每个仍在的 public 文件带一个仍交出的正对照；导出读法认得出
//    声明、转出、type 转出与 const（负对照）。
// ③ 直接声明在 public、只有本模块或用例在用的声明按内容落进模块内部（design §2 落位表，含集中验证里记下的偏差）：在新位置导出，
//    不在本模块任一 public 文件里；谁都不用的四个声明全仓 src 不再有定义；code-capability 的修复动作落在 domain，domain 不取
//    application。
// ④ 减速带：十个 context 的未消费计数上限为 0、source-control 为 8（实测由 rfc376-structural-guards 的计数门做，全仓每个 context）。
//
// 覆盖范围（C12）：① 覆盖 backend 的 src / 用例 / 脚本、仓根脚本与 e2e；② ③ 覆盖十个 context 的全部 public 文件；④ 的计数覆盖全部
// context。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

const CONTEXTS = [
  'code-capability',
  'development-automation',
  'digital-employee',
  'event-center',
  'execution-contract',
  'integration',
  'memory',
  'resource-catalog',
  'runtime-management',
  'system-operations',
] as const
type Context = (typeof CONTEXTS)[number]
type Entry = 'commands' | 'queries' | 'participants' | 'types' | 'events' | 'operations'
const ENTRIES: readonly Entry[] = [
  'commands',
  'queries',
  'participants',
  'types',
  'events',
  'operations',
]

const FIXTURE = JSON.parse(
  readFileSync(join(TESTS, 'fixtures', 'rfc550-withdrawn-public-symbols.json'), 'utf8'),
) as {
  readonly retired: readonly string[]
  readonly withdrawn: Readonly<Record<Context, Partial<Record<Entry, readonly string[]>>>>
}
const RETIRED = FIXTURE.retired.map((path) => path.replace(/\.ts$/, ''))

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Every module specifier a file references: static (incl. empty `import {}`), side-effect, re-export, type, dynamic, require. */
const specifiersIn = (text: string) =>
  ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName)

/** Resolve an import specifier to a `src/`-relative path stem (alias and relative forms), or null. */
function targetOf(from: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return specifier.slice(2).replace(/\.[cm]?tsx?$/, '')
  if (!specifier.startsWith('.')) return null
  const rel = slash(relative(SRC, resolve(from, '..', specifier)))
  return rel.startsWith('..') ? null : rel.replace(/\.[cm]?tsx?$/, '')
}

const importsOf = (files: readonly string[]) =>
  files.flatMap((path) =>
    specifiersIn(readFileSync(path, 'utf8'))
      .filter((specifier) => RETIRED.includes(targetOf(path, specifier) ?? ''))
      .map((specifier) => `${slash(relative(REPO_ROOT, path))} -> ${specifier}`),
  )

function exportedNames(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (ts.isNamedExports(statement.exportClause))
        names.push(...statement.exportClause.elements.map((element) => element.name.text))
      continue
    }
    const exported = ts.canHaveModifiers(statement)
      ? (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false
    if (!exported) continue
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    )
      names.push(statement.name.text)
  }
  return [...new Set(names)].sort()
}

/** A top-level or nested declaration of `name` (exported or not), by its declaring keyword. */
const declares = (text: string, name: string) =>
  new RegExp(`\\b(?:interface|type|const|let|var|function|class|enum)\\s+${name}\\b`).test(text)

const publicFile = (context: Context, entry: Entry) => `modules/${context}/public/${entry}.ts`
const publicExportsOf = (context: Context) =>
  ENTRIES.flatMap((entry) => {
    const file = publicFile(context, entry)
    return existsSync(join(SRC, file)) ? exportedNames(file, read(file)) : []
  })

const CC = 'modules/code-capability/'
const DE = 'modules/digital-employee/'
const EC = 'modules/event-center/'
const IN = 'modules/integration/'
const RC = 'modules/resource-catalog/'
const SO = 'modules/system-operations/'

/** design §2: declarations that lived in a public file and now live in the module, by content. */
const MOVED: Readonly<Record<string, readonly string[]>> = {
  [CC + 'application/ports/codeQueries.ts']: [
    'CodeAdoptionBuckets',
    'CodeAiAttemptProjection',
    'CodeMatrixQuery',
    'CodeMatrixRow',
    'CodeMetricsQuery',
    'CodeMetricsSummary',
    'CodeRoundAttemptsQuery',
    'CodeRoundProjection',
    'CodeRunCounts',
    'CodeStageProjection',
    'CodeWorkItemFilter',
    'CodeWorkItemPage',
    'CodeWorkItemProjection',
    'CodeWorkItemProjectionQuery',
  ],
  // The repair action is what the domain's repair table returns; the query ports take it from there.
  [CC + 'domain/repairActions.ts']: ['CodeRepairAction'],
  // `public/queries` carried a copy of the domain's stage graph that only a test compared; the copy is gone.
  [CC + 'domain/stageGraph.ts']: [
    'StageGraph',
    'StageGraphEdge',
    'StageGraphNode',
    'StageGraphNodeKind',
  ],
  [DE + 'application/lifecycleEvents.ts']: [
    'EMPLOYEE_CASE_STATE_CHANGED_EVENT_REF',
    'EMPLOYEE_INVOCATION_RESULT_EVENT_REF',
    'EMPLOYEE_LIFECYCLE_SOURCE_REF',
    'employeeCaseLifecycleObservation',
    'employeeInvocationResultObservation',
  ],
  [DE + 'domain/dispatchRouteDefinitions.ts']: ['normalizeDispatchRouteDefinitionsJson'],
  [EC + 'application/ports/eventCenterPorts.ts']: [
    'EventCenterCatalogQueryPort',
    'EventCenterOperationsQueryPort',
    'EventDeliveryStatusDocument',
    'EventDeliveryStatusPageDocument',
    'EventObservationCommandPort',
    'EventObserverControlParticipant',
    'EventRecordAuditDocument',
    'EventRecordAuditPageDocument',
    'ObserverHealthDocument',
  ],
  [IN + 'application/codeHostEvents.ts']: [
    'CODE_HOST_EVENT_SOURCE_REF',
    'codeHostBusinessEventObservation',
    'codeHostBusinessEventTypeRef',
    'codeHostEventObservation',
    'codeHostEventObservations',
    'codeHostEventTypeRef',
  ],
  [IN + 'application/ports/mrTerminalControl.ts']: [
    'MrTerminalControl',
    'ProtectedMrLaunchGuard',
    'ProtectedMrLaunchGuardInput',
  ],
  [IN + 'application/ports/workStartReceipt.ts']: ['WorkStartReceipt'],
  [RC + 'application/catalogModules.ts']: [
    'AgentCatalogModule',
    'PluginCatalogModule',
    'SkillCatalogModule',
    'WorkflowCatalogModule',
    'WorkgroupCatalogModule',
  ],
  [RC + 'application/mcps/ports.ts']: [
    'McpProbeMeasurement',
    'McpProbeRecord',
    'McpProbeRunner',
    'McpProbeStore',
    'McpProbeWrite',
  ],
  [RC + 'application/package/preparedMutations.ts']: [
    'AgentPackageMutation',
    'CapabilityTemplatePackageMutation',
    'McpPackageMutation',
    'PluginPackageMutation',
    'PreparedAgentPackageMutation',
    'PreparedCapabilityTemplatePackageMutation',
    'PreparedMcpPackageMutation',
    'PreparedPackageMutation',
    'PreparedPluginPackageMutation',
    'PreparedSkillPackageMutation',
    'PreparedWorkflowPackageMutation',
    'PreparedWorkgroupPackageMutation',
    'ResourcePackageMutationReceipt',
    'SkillPackageMutation',
    'WorkflowPackageMutation',
    'WorkgroupPackageMutation',
    'preparedPackageMutation',
  ],
  [SO + 'application/operationDescriptors.ts']: [
    'createDatabaseMigrationOperationDescriptors',
    'createSystemOperationDescriptors',
  ],
  [SO + 'application/systemOperationContracts.ts']: [
    'activateLocalRestoreOptionsSchema',
    'backupResultViewSchema',
    'cancelStagedRestoreResultSchema',
    'localRestoreActivationSchema',
    'recoveryStatusViewSchema',
    'requestBackupInputSchema',
    'restorePlanOptionsSchema',
    'restorePlanViewSchema',
    'stageRestoreOptionsSchema',
    'stageRestoreResultSchema',
  ],
  [SO + 'application/systemOperationPorts.ts']: [
    'CancelStagedRestoreCommand',
    'GetRecoveryStatusQuery',
    'SystemOperationCommands',
    'SystemOperationQueries',
  ],
}

/** design §1: declared in a public file and used by nobody — deleted. */
const DELETED: ReadonlyArray<readonly [Context, string]> = [
  ['digital-employee', 'EmployeeCaseProjectionInvalidated'],
  ['digital-employee', 'WORKSPACE_FAILURE_CLASSES'],
  ['resource-catalog', 'SkillIdentityMigrationReceipt'],
  ['resource-catalog', 'SkillLegacyVersionBackfillReceipt'],
]

describe('RFC-550 —— 撤空的三个 public 文件', () => {
  test('文件不在', () => {
    expect(RETIRED.sort()).toEqual([
      CC + 'public/queries',
      EC + 'public/commands',
      EC + 'public/queries',
    ])
    for (const stem of RETIRED)
      expect([stem, existsSync(join(SRC, `${stem}.ts`))]).toEqual([stem, false])
  })

  test('backend 的 src、用例与脚本、仓根脚本与 e2e 零 import 它们', () => {
    const sources = walk(SRC)
    expect(sources.length).toBeGreaterThanOrEqual(1500)
    expect(importsOf(sources)).toEqual([])
    expect(importsOf(walk(TESTS))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'packages', 'backend', 'scripts')))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'scripts')))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'e2e')))).toEqual([])
    // 逐个解析 backend src、用例、两处脚本目录与 e2e 的全部源码；60 s 是负载下的墙钟允许量，不是对扫描变慢的容忍。
  }, 60_000)

  test('负对照：判据认得出别名、相对路径、type、转出与动态 import', () => {
    const probe = join(TESTS, 'probe.test.ts')
    expect(targetOf(probe, '../src/modules/event-center/public/commands')).toBe(
      EC + 'public/commands',
    )
    expect(targetOf(join(SRC, EC, 'public', 'probe.ts'), './queries')).toBe(EC + 'public/queries')
    expect(targetOf(probe, '@/modules/code-capability/public/queries')).toBe(CC + 'public/queries')
    expect(targetOf(probe, '@/modules/code-capability/public/queriesExtra')).not.toBe(
      CC + 'public/queries',
    )
    expect(
      specifiersIn(
        "const ports = await import('../src/modules/event-center/public/queries')\n" +
          "import type { CodeMatrixQuery } from '@/modules/code-capability/public/queries'\n" +
          "export { EventObservationCommandPort } from './commands'\n",
      ).sort(),
    ).toEqual([
      '../src/modules/event-center/public/queries',
      './commands',
      '@/modules/code-capability/public/queries',
    ])
  })
})

describe('RFC-550 —— 未消费符号撤出十个 context 的 public', () => {
  test('清单逐名不在原 public 文件的导出里，值也不在运行时命名空间里', async () => {
    let listed = 0
    for (const context of CONTEXTS) {
      for (const entry of ENTRIES) {
        const names = FIXTURE.withdrawn[context]?.[entry] ?? []
        if (names.length === 0) continue
        listed += names.length
        const path = publicFile(context, entry)
        const exported = exportedNames(path, read(path))
        const namespace = (await import(join(SRC, path))) as Record<string, unknown>
        for (const name of names) {
          expect([path, name, exported.includes(name)]).toEqual([path, name, false])
          expect([path, name, name in namespace]).toEqual([path, name, false])
        }
      }
    }
    // 85c36f1c0: 71 unconsumed in the ten contexts plus the cascades, minus the names of the three retired files.
    expect(listed).toBe(96)
  })

  test('正对照：同一读法看得见每个仍在的 public 文件仍交出的符号', async () => {
    const kept: ReadonlyArray<readonly [string, string, boolean]> = [
      [
        'modules/development-automation/public/operations.ts',
        'createDevelopmentConfigResourceDescriptors',
        true,
      ],
      [
        'modules/development-automation/public/types.ts',
        'DEVELOPMENT_APPROVAL_STATUS_CHANGED_EVENT_REF',
        true,
      ],
      [DE + 'public/events.ts', 'digitalEmployeeLifecycleEventCatalogJson', true],
      [DE + 'public/types.ts', 'PLATFORM_WORK_ITEM_SLOT_REF', true],
      [EC + 'public/participants.ts', 'EventCenterParticipant', false],
      [EC + 'public/types.ts', 'EventDeliveryEnvelope', false],
      ['modules/execution-contract/public/types.ts', 'EXECUTION_CONTRACT_RESULT_PORT', true],
      [IN + 'public/events.ts', 'codeHostEventCatalogJson', true],
      [IN + 'public/participants.ts', 'AdapterConfigurationReference', false],
      ['modules/memory/public/types.ts', 'isMemoryHiddenCandidate', true],
      [RC + 'public/operations.ts', 'AgentOperationDescriptors', false],
      [RC + 'public/participants.ts', 'acquireAgentLaunch', true],
      [RC + 'public/types.ts', 'DISABLED_RESOURCE_POLICY', true],
      ['modules/runtime-management/public/participants.ts', 'objectOf', true],
      [SO + 'public/commands.ts', 'ActivateLocalRestoreCommand', false],
      [SO + 'public/operations.ts', 'SYSTEM_OPERATION_ALIASES', true],
      [SO + 'public/queries.ts', 'ApplicationConfigurationQueries', false],
      [SO + 'public/types.ts', 'ActivateLocalRestoreInput', false],
    ]
    const withNames = CONTEXTS.flatMap((context) =>
      ENTRIES.filter((entry) => (FIXTURE.withdrawn[context]?.[entry] ?? []).length > 0).map(
        (entry) => publicFile(context, entry),
      ),
    )
    // One control per public file the fixture names.
    expect(kept.map(([path]) => path).sort()).toEqual(withNames.sort())
    for (const [path, name, value] of kept) {
      expect([path, name, exportedNames(path, read(path)).includes(name)]).toEqual([
        path,
        name,
        true,
      ])
      const namespace = (await import(join(SRC, path))) as Record<string, unknown>
      expect([path, name, name in namespace]).toEqual([path, name, value])
    }
  })

  test('负对照：导出读法认得出声明、转出、type 转出与 const', () => {
    const text =
      'export interface McpProbeStore { readonly id: string }\n' +
      "export { createSystemOperationDescriptors } from '../application/operationDescriptors'\n" +
      "export type { MemoryEnvelopeFencing } from '../domain/injectionRendering'\n" +
      "export { type JsonObject as JsonObject } from '../domain/usageMeter'\n" +
      'export const requestBackupInputSchema = 1\n' +
      'export function normalizeDispatchRouteDefinitionsJson(): void {}\n' +
      'interface NotExported { readonly id: string }\n'
    expect(exportedNames('probe.ts', text)).toEqual([
      'JsonObject',
      'McpProbeStore',
      'MemoryEnvelopeFencing',
      'createSystemOperationDescriptors',
      'normalizeDispatchRouteDefinitionsJson',
      'requestBackupInputSchema',
    ])
  })
})

describe('RFC-550 —— public 里的声明按内容落进模块内部（design §2）', () => {
  test('在新位置导出，不在本模块任一 public 文件里', () => {
    let moved = 0
    for (const [path, names] of Object.entries(MOVED)) {
      const context = /^modules\/([^/]+)\//.exec(path)![1] as Context
      expect(CONTEXTS).toContain(context)
      const exported = exportedNames(path, read(path))
      const publicExports = publicExportsOf(context)
      for (const name of names) {
        moved += 1
        expect([path, name, exported.includes(name)]).toEqual([path, name, true])
        expect([context, name, publicExports.includes(name)]).toEqual([context, name, false])
      }
    }
    expect(moved).toBe(91 - DELETED.length)
  })

  test('谁都不用的声明全仓 src 不再有定义', () => {
    const sources = walk(SRC)
    expect(sources.length).toBeGreaterThanOrEqual(1500)
    for (const [context, name] of DELETED) {
      const declaring = sources
        .filter((path) => declares(readFileSync(path, 'utf8'), name))
        .map((path) => slash(relative(SRC, path)))
      expect([context, name, declaring]).toEqual([context, name, []])
    }
  }, 60_000)

  test('负对照：定义读法认得出 interface、type、const 与 function', () => {
    for (const text of [
      'export interface SkillIdentityMigrationReceipt {',
      'type SkillLegacyVersionBackfillReceipt = { readonly n: number }',
      'export const WORKSPACE_FAILURE_CLASSES = Object.freeze([])',
      'function EmployeeCaseProjectionInvalidated() {}',
    ])
      expect(
        DELETED.some(([, name]) => declares(text, name)),
        text,
      ).toBe(true)
    expect(
      declares('const SkillIdentityMigrationReceipts = 1', 'SkillIdentityMigrationReceipt'),
    ).toBe(false)
  })

  test('code-capability 的修复动作落在 domain：domain 不取 application，查询端口从 domain 取它', () => {
    const repair = CC + 'domain/repairActions.ts'
    const domainSpecifiers = specifiersIn(read(repair))
    expect(domainSpecifiers.filter((specifier) => /\/application(\/|$)/.test(specifier))).toEqual(
      [],
    )
    expect(domainSpecifiers.length).toBeGreaterThan(0)
    expect(specifiersIn(read(CC + 'application/ports/codeQueries.ts'))).toContain(
      '../../domain/repairActions',
    )
  })
})

describe('RFC-550 —— 减速带', () => {
  test('counts.json：十个 context 的未消费计数上限为 0，source-control 为 8', () => {
    const counts = (
      JSON.parse(readFileSync(join(REPO_ROOT, 'architecture', 'counts.json'), 'utf8')) as {
        counts: Record<string, { max: number; reason: string }>
      }
    ).counts
    for (const context of CONTEXTS)
      expect([context, counts[`unconsumed-public-symbols-${context}`]?.max]).toEqual([context, 0])
    expect(counts['unconsumed-public-symbols-source-control']?.max).toBe(8)
  })
})
