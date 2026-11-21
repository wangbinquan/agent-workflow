// RFC-528 — 维护 worker 的单机效果收进单机 profile（RFC-294 S12 第九步）。
//
// 单机 worker 没有效果描述符，此前由 `bootstrap/maintenanceWorkerGraph.ts` 逐项回落到本机实现（7 族 9 处构造）。现在单机 profile 的
// worker 部分 `bootstrap/standaloneMaintenanceWorker.ts` 按族给出这些构造，worker 打开数据库之后在 `selectWorkerEffects` 里选一次，
// 装配图只读选好的效果。锁四件事（design §3 的清单即退出门）：
// ① 装配图不构造本机效果；对描述符原样选择的读取只剩选择本身与 PostgreSQL 客户端的写屏障。
// ② 单机 worker 部分每族恰好构造一次，实参与此前的回落相同（语法树）。
// ③ 选择逐族惰性、覆盖全部族（托管独有的 4 族原样转交）；生产的托管描述符列全 7 族；worker 线程不加载 `bootstrap/standalone.ts`。
// ④ 负对照。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, importEdges, sourceUnit, type SourceUnit } from './architecture/census'
import { resolveImport } from './architecture/rfc294Gates'
import { composeCrewStationMaintenanceDescriptor } from '@/bootstrap/crewstationMaintenance'
import { standaloneMaintenanceWorkerEffects } from '@/bootstrap/standaloneMaintenanceWorker'

const REPO = resolve(import.meta.dir, '../../..')
const PREFIX = 'packages/backend/src/'
const GRAPH = PREFIX + 'bootstrap/maintenanceWorkerGraph.ts'
const STANDALONE_WORKER = PREFIX + 'bootstrap/standaloneMaintenanceWorker.ts'
const STANDALONE_PROFILE = PREFIX + 'bootstrap/standalone.ts'
/** The worker thread's entry roots: the platform-started worker and the hosted entry. */
const WORKER_ENTRIES = [
  PREFIX + 'bootstrap/maintenanceWorker.ts',
  PREFIX + 'bootstrap/maintenanceWorkerEntry.ts',
]
const CORPUS_TIMEOUT = 30_000

/** The families a standalone worker builds itself. */
const FAMILIES = [
  'contentStore',
  'taskArchive',
  'resourcePackageRecovery',
  'workspaceMaintenance',
  'pluginGenerationGc',
  'intentScratch',
  'intentArtifactContent',
] as const
/** Hosted-only: no standalone counterpart, not given means none. */
const HOSTED_ONLY = [
  'databaseWrites',
  'eventsArchive',
  'databaseBackups',
  'objectPublications',
] as const

/** The 9 local constructions the graph used to fall back to, with the arguments it passed (whitespace removed). */
const LOCAL_CONSTRUCTIONS: Readonly<Record<string, readonly string[]>> = {
  createLocalRuntimeContent: ['db', 'appHome'],
  createFileTaskArchiveContent: [],
  composeLocalResourcePackageArtifactRecovery: [
    "{db,appHome,pluginsDir:join(appHome,'plugins'),recoveryEffectsFactory,log}",
  ],
  composeLocalScratchWorkspaceEffects: ['preparationInput'],
  composeLocalRepositoryPreparationEffects: ['preparationInput'],
  createNodeWorkspaceMaintenanceFilesystem: [
    '{appHome,isMaterializingTask,invalidateWorkspacePath:invalidateCallGraphIndex}',
  ],
  createPluginGenerationFilesystemGcPort: ["join(appHome,'plugins')"],
  composeLocalIntentScratch: ['{appHome}'],
  composeLocalIntentArtifactContent: ["{appHome,pluginsDir:join(appHome,'plugins')}"],
}

const squash = (value: string) => value.replace(/\s+/g, '').replace(/,(?=[)\]}])/g, '')

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

/** Every call of the identifier `name`, as its argument texts. */
function callArguments(unit: SourceUnit, name: string): string[][] {
  const found: string[][] = []
  walk(unit.source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      found.push(node.arguments.map((argument) => squash(argument.getText(unit.source))))
  })
  return found
}

/** The members read off the descriptor's raw selection (`workerEffects?.member`). */
function rawSelectionReads(unit: SourceUnit): string[] {
  const found: string[] = []
  walk(unit.source, (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'workerEffects'
    )
      found.push(node.name.text)
  })
  return found
}

function functionText(unit: SourceUnit, name: string): string | undefined {
  let found: string | undefined
  walk(unit.source, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      found = squash(node.getText(unit.source))
  })
  return found
}

/** Every production file a root loads, following value imports (static, dynamic and re-exports). */
function loadedFrom(units: readonly SourceUnit[], root: string): Set<string> {
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const paths = new Set(byPath.keys())
  const seen = new Set<string>([root])
  const queue = [root]
  while (queue.length > 0) {
    const unit = byPath.get(queue.pop()!)
    if (unit === undefined) continue
    for (const edge of importEdges(unit)) {
      if (edge.kind === 'type') continue
      const target = resolveImport(unit.path, edge.specifier, paths)
      if (!paths.has(target) || seen.has(target)) continue
      seen.add(target)
      queue.push(target)
    }
  }
  return seen
}

export function workerEffectViolations(units: readonly SourceUnit[]): string[] {
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const graph = byPath.get(GRAPH)
  const standalone = byPath.get(STANDALONE_WORKER)
  if (graph === undefined || standalone === undefined) return ['missing worker files']
  const errors: string[] = []
  // ① The graph builds no local effect; it reads the raw selection only to select and to fence PostgreSQL writes.
  for (const name of Object.keys(LOCAL_CONSTRUCTIONS))
    if (callArguments(graph, name).length > 0) errors.push(`graph builds:${name}`)
  for (const member of rawSelectionReads(graph))
    if (member !== 'databaseWrites') errors.push(`raw selection read:${member}`)
  // ② The standalone part builds each family once, with the arguments the graph used to pass.
  for (const [name, expected] of Object.entries(LOCAL_CONSTRUCTIONS)) {
    const found = callArguments(standalone, name)
    if (JSON.stringify(found) !== JSON.stringify([expected]))
      errors.push(`standalone construction:${name}:${JSON.stringify(found)}`)
  }
  // ③ One lazy selection covering every family; the hosted-only families pass through.
  const selection = functionText(graph, 'selectWorkerEffects')
  if (selection === undefined) errors.push('missing selection')
  else {
    for (const family of FAMILIES)
      if (!selection.includes(`${family}:selected?.${family}??standalone.${family}(scope`))
        errors.push(`selection:${family}`)
    for (const family of HOSTED_ONLY)
      // Passed through as selected (the last member has no trailing comma once squashed).
      if (!new RegExp(`${family}:selected\\?\\.${family}[,}]`).test(selection))
        errors.push(`hosted-only:${family}`)
  }
  if (callArguments(graph, 'selectWorkerEffects').length !== 2) errors.push('selection per adapter')
  for (const entry of WORKER_ENTRIES)
    if (loadedFrom(units, entry).has(STANDALONE_PROFILE))
      errors.push(`worker loads standalone profile:${entry}`)
  return errors.sort()
}

const UNITS = backendUnits(REPO)

function changed(path: string, change: (text: string) => string): SourceUnit[] {
  return UNITS.map((unit) => (unit.path === path ? sourceUnit(path, change(unit.text)) : unit))
}

describe('RFC-528 ① ② ③ 单机 worker 部分与一次选择', () => {
  test(
    '装配图不构造本机效果；单机 worker 部分每族构造一次、实参与此前回落相同；选择逐族惰性；worker 线程不加载单机 profile',
    () => {
      expect(UNITS.length).toBeGreaterThanOrEqual(2000)
      expect(workerEffectViolations(UNITS)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('单机 worker 部分恰好给出 7 族的构造函数', () => {
    expect(Object.keys(standaloneMaintenanceWorkerEffects).sort()).toEqual([...FAMILIES].sort())
    for (const family of FAMILIES)
      expect(typeof standaloneMaintenanceWorkerEffects[family]).toBe('function')
  })

  test('生产的托管描述符列全有单机对应的 7 族', () => {
    const descriptor = composeCrewStationMaintenanceDescriptor({
      database: {} as never,
      generationId: 'g',
      fence: {} as never,
    })
    for (const family of FAMILIES) expect(descriptor.capabilities).toContain(family)
  })
})

describe('RFC-528 ④ 负对照', () => {
  test(
    '装配图里的本机构造、对原样选择的读取、单机构造的实参漂移、漏掉的族与 worker 线程加载单机 profile 都会被认出',
    () => {
      expect(
        workerEffectViolations(
          changed(GRAPH, (text) =>
            text.replace(
              '    effects.taskArchive,\n',
              '    workerEffects?.taskArchive ?? { content: createFileTaskArchiveContent() },\n',
            ),
          ),
        ),
      ).toEqual(['graph builds:createFileTaskArchiveContent', 'raw selection read:taskArchive'])
      expect(
        workerEffectViolations(
          changed(STANDALONE_WORKER, (text) =>
            text.replace(
              "createPluginGenerationFilesystemGcPort(join(appHome, 'plugins'))",
              "createPluginGenerationFilesystemGcPort(join(appHome, 'plugin'))",
            ),
          ),
        ),
      ).toEqual([
        'standalone construction:createPluginGenerationFilesystemGcPort:[["join(appHome,\'plugin\')"]]',
      ])
      expect(
        workerEffectViolations(
          changed(GRAPH, (text) =>
            text.replace(
              'intentScratch: selected?.intentScratch ?? standalone.intentScratch(scope),',
              'intentScratch: selected?.intentScratch,',
            ),
          ),
        ),
      ).toEqual(['selection:intentScratch'])
      expect(
        workerEffectViolations(
          changed(STANDALONE_WORKER, (text) => `import './standalone'\n${text}`),
        ),
      ).toEqual([
        `worker loads standalone profile:${WORKER_ENTRIES[0]}`,
        `worker loads standalone profile:${WORKER_ENTRIES[1]}`,
      ])
    },
    CORPUS_TIMEOUT,
  )
})
