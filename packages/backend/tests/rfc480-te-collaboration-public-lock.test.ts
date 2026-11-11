// RFC-480 — task-execution 与 collaboration 的 public 收口：未消费符号清零与 public/operations 退役（RFC-294 S9 第一步）。
//
// 锁五件事：
// ① task-execution `public/operations.ts` 不在；backend 的 src / 用例 / 脚本与仓根脚本零 import 它（`preProcessFile` 取全部模块引用：静态、
//    re-export、type、动态 import 与 require；别名与相对路径都认，带负对照）。
// ② 被撤出的符号（`tests/fixtures/rfc480-withdrawn-public-symbols.json`：673b1b53b 时两个模块 public 文件的导出里、撤出后不在的
//    逐名清单）不在原 public 文件的导出里，值也不在运行时命名空间里（每个 public 文件带一个仍在的正对照）。
// ③ 直接声明在 public、只有本模块或用例在用的声明按内容落进模块内部（design §2 落位表）：在新位置导出，不在本模块任一 public 文件里。
// ④ 三处模块外使用取新位置：collaboration 的 review 从 platform 取终止准入；integration 从 task-execution `public/types` 取清理
//    策略类型；bootstrap 从 task-execution 的 `composition` 取策略注册（带负对照）。
// ⑤ 减速带的未消费符号按 context 分项登记，两个模块的上限为 0（实测由 rfc376-structural-guards 的计数门做，全仓每个 context）。
// ⑥ 回归（design §2「实施中纠正的一处误判」）：架构报告的类型形状遍历走进 `readonly X[]`、元组、泛型实参与索引访问——public 合同
//    只经这些形式引用的类型算作被消费；修正前它们被误报为未消费（fixture，带「真正没人取用的仍计入」的负对照）。
//
// 覆盖范围（C12）：① 覆盖 backend 的 src / 用例 / 脚本与仓根脚本；② ③ 覆盖两个模块的全部 public 文件；⑤ 的分项计数覆盖全部 context；
// ⑥ 只在 fixture 上判定（真实语料的计数由 ⑤ 与 rfc376-report 的分项断言守住）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import * as collaborationCommands from '@/modules/collaboration/public/commands'
import * as collaborationEvents from '@/modules/collaboration/public/events'
import * as collaborationParticipants from '@/modules/collaboration/public/participants'
import * as collaborationQueries from '@/modules/collaboration/public/queries'
import * as collaborationTypes from '@/modules/collaboration/public/types'
import * as taskExecutionCommands from '@/modules/task-execution/public/commands'
import * as taskExecutionEvents from '@/modules/task-execution/public/events'
import * as taskExecutionParticipants from '@/modules/task-execution/public/participants'
import * as taskExecutionQueries from '@/modules/task-execution/public/queries'
import * as taskExecutionTypes from '@/modules/task-execution/public/types'
import { corpusPublicContract, unconsumedPublicSymbols } from './architecture/architectureReport'
import { sourceUnit } from './architecture/census'
import { createGateCorpus } from './architecture/rfc294Gates'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RETIRED = 'modules/task-execution/public/operations'
const TE = 'modules/task-execution/'
const CO = 'modules/collaboration/'
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

type Context = 'task-execution' | 'collaboration'
type Entry = 'commands' | 'queries' | 'participants' | 'types' | 'events'
const ENTRIES: readonly Entry[] = ['commands', 'queries', 'participants', 'types', 'events']
const NAMESPACES: Readonly<Record<Context, Readonly<Record<Entry, Record<string, unknown>>>>> = {
  'task-execution': {
    commands: taskExecutionCommands,
    queries: taskExecutionQueries,
    participants: taskExecutionParticipants,
    types: taskExecutionTypes,
    events: taskExecutionEvents,
  },
  collaboration: {
    commands: collaborationCommands,
    queries: collaborationQueries,
    participants: collaborationParticipants,
    types: collaborationTypes,
    events: collaborationEvents,
  },
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return []
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
      .filter((specifier) => targetOf(path, specifier) === RETIRED)
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

/** Module specifiers of the import declarations that bind `name` (named imports only). */
function importSourcesOf(path: string, text: string, name: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      return []
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) return []
    return bindings.elements.some((element) => element.name.text === name)
      ? [statement.moduleSpecifier.text]
      : []
  })
}

const publicFile = (context: Context, entry: Entry) => `modules/${context}/public/${entry}.ts`

const WITHDRAWN = (
  JSON.parse(
    readFileSync(join(TESTS, 'fixtures', 'rfc480-withdrawn-public-symbols.json'), 'utf8'),
  ) as { withdrawn: Record<Context, Partial<Record<Entry, string[]>>> }
).withdrawn

/** design §2: declarations that lived in a public file and moved into the module by content. */
const MOVED: Readonly<Record<string, readonly string[]>> = {
  [TE + 'application/ports/workgroupTurnsOperations.ts']: [
    'WorkgroupHostLedgerFailRunOperation',
    'WorkgroupHostLedgerMintOperation',
    'WorkgroupHostLedgerMintReceipt',
    'WorkgroupHostLedgerOperation',
    'WorkgroupHostLedgerParticipantInTx',
    'WorkgroupHostLedgerRun',
    'WorkgroupHostLedgerSnapshot',
    'WorkgroupHostLedgerStampOperation',
    'WorkgroupTurnHostOperations',
    'WorkgroupTurnHostRequest',
    'WorkgroupTurnHostResult',
    'WorkgroupTurnLogFields',
    'WorkgroupTurnLogger',
    'WorkgroupTurnsOperations',
    'WorkgroupTurnsOutcome',
  ],
  [TE + 'application/ports/taskCancellationCommand.ts']: ['TaskCancellationCommand'],
  [TE + 'application/ports/taskExecutionTopology.ts']: ['SchedulerRuntimeTopology'],
  [TE + 'application/ports/employeeExecutionArtifactQueries.ts']: [
    'EmployeeExecutionArtifactQueries',
  ],
  [TE + 'application/taskLifecycleEvents.ts']: [
    'TASK_LIFECYCLE_SOURCE_REF',
    'TASK_STATUS_CHANGED_EVENT_REF',
    'taskLifecycleObservation',
  ],
  [TE + 'application/taskExecutionError.ts']: ['TaskExecutionCommandErrorCode'],
  [TE + 'domain/ownership.ts']: ['OwnedTaskTx', 'WorkerIdentity'],
  [TE + 'engine/node/wrapperDelegatingNodeExecutors.ts']: ['WrapperScopeReadModel'],
  [CO + 'application/commandEntries.ts']: [
    'ClarifyGateOpenReceipt',
    'ManualQuestionOpenReceipt',
    'ReviewGateOpenReceipt',
    'createManualQuestionOpen',
    'dispatchTaskQuestions',
    'finalizeCommittedHumanGate',
    'prepareClarifyGateOpen',
    'prepareReviewGateOpen',
    'setCollaborationClarifyDirective',
    'submitClarifyDecision',
    'submitReviewDecision',
  ],
  [CO + 'application/queryEntries.ts']: [
    'collaborationQuestionTaskId',
    'listCollaborationClarifyDirectives',
    'resolveCollaborationClarifyTaskAccess',
    'resolveCollaborationNodeRunTaskAccess',
    'visibleCollaborationTaskIds',
  ],
  [CO + 'application/reviewNodeReviewerEntries.ts']: [
    'filterReviewSummariesForActor',
    'getReviewNodeReviewerConfig',
    'replaceReviewNodeReviewers',
    'resolveReviewAccess',
    'reviewNodeReviewerDependencies',
  ],
  [CO + 'application/ports/humanInputQueries.ts']: ['CollaborationHumanInputQueries'],
}

describe('RFC-480 —— task-execution public/operations 退役', () => {
  test('public/operations.ts 不在', () => {
    expect(existsSync(join(SRC, `${RETIRED}.ts`))).toBe(false)
  })

  test('backend 的 src、用例与脚本零 import 它', () => {
    const sources = walk(SRC)
    expect(sources.length).toBeGreaterThanOrEqual(1500)
    expect(importsOf(sources)).toEqual([])
    expect(importsOf(walk(TESTS))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'packages', 'backend', 'scripts')))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'scripts')))).toEqual([])
    // 逐个解析 backend src、用例与两处脚本目录的全部源码。60 s 是负载下的墙钟允许量，不是对扫描变慢的容忍
    // （本机 1 分钟负载 30～40 时 5.8 s）。
  }, 60_000)

  test('负对照：判据认得出别名、相对路径、type 与动态 import', () => {
    const probe = join(TESTS, 'probe.test.ts')
    expect(targetOf(probe, '../src/modules/task-execution/public/operations')).toBe(RETIRED)
    expect(targetOf(join(SRC, TE, 'public', 'probe.ts'), './operations')).toBe(RETIRED)
    expect(targetOf(probe, '@/modules/task-execution/public/operations')).toBe(RETIRED)
    expect(targetOf(probe, '@/modules/task-execution/public/operationsExtra')).not.toBe(RETIRED)
    expect(
      specifiersIn(
        "const { setTaskStatus } = await import('../src/modules/task-execution/public/operations')\n" +
          "import type { TerminalWorkspacePrunePolicy } from '@/modules/task-execution/public/operations'\n" +
          "export { trySetTaskStatus } from './operations'\n",
      ).sort(),
    ).toEqual([
      '../src/modules/task-execution/public/operations',
      './operations',
      '@/modules/task-execution/public/operations',
    ])
  })
})

describe('RFC-480 —— 未消费符号撤出两个模块的 public', () => {
  test('清单逐名不在原 public 文件的导出里，值也不在运行时命名空间里', () => {
    let listed = 0
    for (const context of ['task-execution', 'collaboration'] as const) {
      for (const entry of ENTRIES) {
        const names = WITHDRAWN[context][entry] ?? []
        listed += names.length
        if (names.length === 0) continue
        const path = publicFile(context, entry)
        const exported = exportedNames(path, read(path))
        const namespace = NAMESPACES[context][entry]
        for (const name of names) {
          expect([path, name, exported.includes(name)]).toEqual([path, name, false])
          expect([path, name, name in namespace]).toEqual([path, name, false])
        }
      }
    }
    // The fixture is the whole sweep (673b1b53b: task-execution 181 / collaboration 24 unconsumed, plus the cascades).
    expect(listed).toBeGreaterThanOrEqual(205)
  })

  test('正对照：同一读法看得见每个 public 文件仍交出的符号', () => {
    const kept: ReadonlyArray<readonly [Context, Entry, string, boolean]> = [
      ['task-execution', 'commands', 'WORKGROUP_TURN_LEADER_NODE_ID', true],
      ['task-execution', 'queries', 'nodeOutputSlot', true],
      ['task-execution', 'participants', 'currentTaskExecutionContext', true],
      ['task-execution', 'types', 'TerminalWorkspacePrunePolicy', false],
      ['task-execution', 'events', 'taskLifecycleEventCatalogJson', true],
      ['collaboration', 'commands', 'createTaskFeedback', true],
      ['collaboration', 'queries', 'resolveCollaborationTaskAccess', true],
      ['collaboration', 'participants', 'createWorkgroupClarifyAskGate', true],
      ['collaboration', 'types', 'CollaborationCommandContext', false],
      ['collaboration', 'events', 'collaborationCommittedEventCatalogJson', true],
    ]
    for (const [context, entry, name, value] of kept) {
      const path = publicFile(context, entry)
      expect([path, name, exportedNames(path, read(path)).includes(name)]).toEqual([
        path,
        name,
        true,
      ])
      expect([path, name, name in NAMESPACES[context][entry]]).toEqual([path, name, value])
    }
  })
})

describe('RFC-480 —— public 里的声明按内容落进模块内部（design §2）', () => {
  test('在新位置导出，不在本模块任一 public 文件里', () => {
    for (const [path, names] of Object.entries(MOVED)) {
      const context: Context = path.startsWith(TE) ? 'task-execution' : 'collaboration'
      const exported = exportedNames(path, read(path))
      const publicExports = ENTRIES.flatMap((entry) => {
        const file = publicFile(context, entry)
        return existsSync(join(SRC, file)) ? exportedNames(file, read(file)) : []
      })
      for (const name of names) {
        expect([path, name, exported.includes(name)]).toEqual([path, name, true])
        expect([context, name, publicExports.includes(name)]).toEqual([context, name, false])
      }
    }
  })

  test('collaboration 的审阅人依赖装配不再留在 composition（随审阅人入口进 application）', () => {
    expect(existsSync(join(SRC, CO + 'composition/reviewNodeReviewerDependencies.ts'))).toBe(false)
  })

  test('只剩用例在用的本地进程观察器装配挪到 tests/helpers（生产 src 不再有它）', () => {
    expect(existsSync(join(SRC, TE + 'composition/processEffectObserver.ts'))).toBe(false)
    const helper = join(TESTS, 'helpers', 'localProcessEffectObserver.ts')
    expect(exportedNames(helper, readFileSync(helper, 'utf8'))).toContain(
      'createProcessEffectAttemptObserver',
    )
  })
})

describe('RFC-480 —— 三处模块外使用取新位置', () => {
  test('collaboration review、integration 的清理策略与 bootstrap 的注册各取新位置', () => {
    const sites: ReadonlyArray<readonly [string, string, string]> = [
      [
        CO + 'infrastructure/review.ts',
        'assertNodeRunSourceTerminationAdmission',
        '@/platform/persistence/nodeRunLifecycleCore',
      ],
      [
        'modules/integration/application/terminalWorkspaceCleanup.ts',
        'TerminalWorkspacePrunePolicy',
        '@/modules/task-execution/public/types',
      ],
      [
        'modules/integration/composition/terminalWorkspaceCleanup.ts',
        'TerminalWorkspacePrunePolicy',
        '@/modules/task-execution/public/types',
      ],
      [
        'bootstrap/daemonApplication.ts',
        'registerTerminalWorkspacePrunePolicy',
        '@/modules/task-execution/composition',
      ],
    ]
    for (const [path, name, specifier] of sites)
      expect([path, name, importSourcesOf(path, read(path), name)]).toEqual([
        path,
        name,
        [specifier],
      ])
    expect(exportedNames(TE + 'public/types.ts', read(TE + 'public/types.ts'))).toEqual(
      expect.arrayContaining(['TerminalWorkspacePruneDecision', 'TerminalWorkspacePrunePolicy']),
    )
    expect(exportedNames(TE + 'composition.ts', read(TE + 'composition.ts'))).toContain(
      'registerTerminalWorkspacePrunePolicy',
    )
  })

  test('负对照：import 读法只认绑定该名字的那条声明', () => {
    const text =
      "import { other } from '@/modules/task-execution/public/types'\n" +
      "import type { TerminalWorkspacePrunePolicy as Policy } from './elsewhere'\n" +
      "import { type TerminalWorkspacePrunePolicy } from '@/modules/task-execution/public/types'\n"
    expect(importSourcesOf('probe.ts', text, 'TerminalWorkspacePrunePolicy')).toEqual([
      '@/modules/task-execution/public/types',
    ])
    expect(importSourcesOf('probe.ts', text, 'Policy')).toEqual(['./elsewhere'])
    expect(importSourcesOf('probe.ts', text, 'missing')).toEqual([])
  })
})

describe('RFC-480 —— 减速带按 context 分项', () => {
  test('counts.json 每个 context 一项未消费计数，两个模块上限为 0，没有总数一项', () => {
    const counts = (
      JSON.parse(readFileSync(join(REPO_ROOT, 'architecture', 'counts.json'), 'utf8')) as {
        counts: Record<string, { max: number; reason: string }>
      }
    ).counts
    expect('unconsumed-public-symbols' in counts).toBe(false)
    expect(counts['unconsumed-public-symbols-task-execution']?.max).toBe(0)
    expect(counts['unconsumed-public-symbols-collaboration']?.max).toBe(0)
    const ids = Object.keys(counts).filter((id) => id.startsWith('unconsumed-public-symbols-'))
    expect(ids.length).toBeGreaterThanOrEqual(19)
  })
})

describe('RFC-480 —— 报告的类型形状遍历走进数组、元组、泛型实参与索引访问（回归）', () => {
  const MEMORY = 'packages/backend/src/modules/memory/'
  const unconsumed = (files: Record<string, string>) =>
    unconsumedPublicSymbols(
      corpusPublicContract(
        createGateCorpus(Object.entries(files).map(([path, text]) => sourceUnit(path, text))),
      ).publicSurfaces,
    )
      .map((entry) => entry.id)
      .sort()
  // `MemoryPage` 有模块外读者；它只经下列形式引用另外五个类型，`MemoryUnused` 谁也不引用。
  const TYPES = [
    'export interface MemoryItem { readonly id: string }',
    'export interface MemoryPairHead { readonly id: string }',
    'export interface MemoryPairTail { readonly id: string }',
    'export interface MemoryValue { readonly id: string }',
    'export interface MemoryKeyed { readonly id: string }',
    'export interface MemoryUnused { readonly id: string }',
    'export interface MemoryPage {',
    '  readonly items: readonly MemoryItem[]',
    '  readonly head: [MemoryPairHead, string]',
    '  readonly tail: readonly [string, MemoryPairTail]',
    '  readonly byId: Record<string, MemoryValue>',
    "  readonly key: MemoryKeyed['id']",
    '}',
    '',
  ].join('\n')
  const CONSUMER = 'packages/backend/src/modules/intent/application/memoryPage.ts'
  const USE =
    "import type { MemoryPage } from '@/modules/memory/public/types'\n" +
    'export const pageSize = (page: MemoryPage): number => page.items.length\n'

  test('public 合同经 readonly 数组、元组、泛型实参与索引访问引用的类型算作被消费', () => {
    expect(unconsumed({ [MEMORY + 'public/types.ts']: TYPES, [CONSUMER]: USE })).toEqual([
      'public:memory:types:MemoryUnused',
    ])
  })

  test('负对照：没有 public 合同引用、只被本 context 的非 public 文件取用的类型仍计入', () => {
    const internal = MEMORY + 'application/unusedId.ts'
    expect(
      unconsumed({
        [MEMORY + 'public/types.ts']: TYPES,
        [CONSUMER]: USE,
        [internal]:
          "import type { MemoryUnused } from '../public/types'\n" +
          'export const unusedId = (value: MemoryUnused): string => value.id\n',
      }),
    ).toEqual(['public:memory:types:MemoryUnused'])
    // 去掉模块外读者，`MemoryPage` 自己也计入；被它引用的五个类型仍算被消费（public 合同之间的引用）。
    expect(unconsumed({ [MEMORY + 'public/types.ts']: TYPES })).toEqual([
      'public:memory:types:MemoryPage',
      'public:memory:types:MemoryUnused',
    ])
  })
})
