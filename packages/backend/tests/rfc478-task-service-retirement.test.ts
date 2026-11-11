// RFC-478 — `services/task.ts` 按内容分层归 task-execution（RFC-294 W9-D，task-execution 一族收尾）。
//
// 锁六件事：
// ① `services/task.ts` 不在：backend 的 src / 用例 / 脚本零 import（`preProcessFile` 取全部模块引用，带负对照）；各包、e2e 与仓根
//    脚本里没有指着它的路径字面量，也没有按段传给 `resolve` / `join` 的 `'services', 'task.ts'`（注释不算，带负对照；两份有意拼写
//    它的 fixture 豁免）；workflow 与 `design/`、`docs/` 的 Markdown 相对链接也不指着它（带负对照）。
// ② census 的 `R1` 里没有它（带负对照）。
// ③ 按内容分层（RFC-294 C10）：定义处的导出清单；两个 domain 文件不取 `node:` / `@/db` / `drizzle-orm`；同步预览的 application 文件
//    不取 infrastructure 与 legacy；新的延后准备 infrastructure 文件不取 source-control（只经 task 自有的准备绑定，带负对照）。
// ④ 延后准备的绑定必填；绑定的组成员解析与 `groupName` 同一段解析；空清理账本与 source-control 构造的逐字段相同。
// ⑤ 失去模块外生产消费方的 public 符号已撤出（含随工厂失去读者的返回类型与 source-control 的组布局解析，带正对照）；测试专用出口只在 `tests/helpers/`，零调用方的停机函数不在 src。
// ⑥ 同步预览读端口的行为：四个读与直接查询同值（双引擎）。
// 行为由既有用例覆盖（都改走新位置）：延后准备（`rfc287-t13` / `t14` / `t14b`、`rfc359-w5hn`、`rfc363` 一族、`rfc395-a3`）、同步预览
// （`rfc109`、`rfc359-w58`）、任务详情与失败码（`rfc203`、`rfc395-a7`）、运行时选项（`rfc103`、`scheduler-subagent-live-capture-passthrough`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, inboundBoundaryEdges, sourceUnit } from './architecture/census'
import { BACKEND_PREFIX } from './architecture/rfc294Gates'
import { describeEachProvider } from './helpers/eachProvider'
import { nodeRunFixture, nodeRunOutputFixture } from './helpers/model'
import { seedTask } from './helpers/questionDispatchFixture'
import { createMaterializedSpaceCleanup } from '@/modules/source-control/composition'
import { createWorkflowSyncPreviewReads } from '@/modules/task-execution/infrastructure/workflowSyncPreviewReads'
import { createNodeOutputQueries } from '@/modules/task-execution/infrastructure/nodeOutputQueries'
import { createNodeRunQueries } from '@/modules/task-execution/infrastructure/nodeRunQueries'
import { createRunSelectionReader } from '@/modules/task-execution/infrastructure/runSelection/table/reader'
import { createTaskTriggerQueries } from '@/modules/task-execution/infrastructure/taskTriggerQueries'
import * as taskExecutionParticipants from '@/modules/task-execution/public/participants'
import * as taskExecutionQueries from '@/modules/task-execution/public/queries'
import * as sourceControlQueries from '@/modules/source-control/public/queries'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RETIRED = 'services/task'
const TE = 'modules/task-execution/'
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const codeOnly = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function walk(dir: string, pattern = /\.[cm]?tsx?$/): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path, pattern) : pattern.test(name) ? [path] : []
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

const RETIRED_PATH = /(?:^|[/'"@])services\/task(?:\.ts)?$/
const RETIRED_DIRECTORY_SEGMENT = /(?:^|\/)services$/
const RETIRED_FILE_SEGMENT = /^task(?:\.ts)?$/

/**
 * String literals (not comments) that name the retired file by path — the shape `readFileSync(<path>)` locks use — and
 * the same path passed segment by segment as consecutive call arguments (`resolve(dir, 'src', 'services', 'task.ts')`).
 */
function retiredPathLiterals(path: string, text: string): string[] {
  if (!text.includes('services/task') && !/['"`]task(?:\.ts)?['"`]/.test(text)) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      RETIRED_PATH.test(node.text)
    )
      hits.push(`${slash(relative(REPO_ROOT, path))}: ${node.text}`)
    if (ts.isCallExpression(node))
      node.arguments.forEach((argument, index) => {
        const next = node.arguments[index + 1]
        if (
          next !== undefined &&
          ts.isStringLiteralLike(argument) &&
          ts.isStringLiteralLike(next) &&
          RETIRED_DIRECTORY_SEGMENT.test(argument.text) &&
          RETIRED_FILE_SEGMENT.test(next.text)
        )
          hits.push(`${slash(relative(REPO_ROOT, path))}: ${argument.text}, ${next.text}`)
      })
    node.forEachChild(visit)
  }
  visit(source)
  return hits
}

/** Markdown relative links (`](…)`, anchors dropped) that resolve to the retired file. */
function retiredMarkdownLinks(path: string, text: string): string[] {
  if (!text.includes('services/task')) return []
  const target = 'packages/backend/src/services/task.ts'
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1]!)
    .filter((link) => !/^[a-z]+:/i.test(link))
    .filter(
      (link) => slash(relative(REPO_ROOT, resolve(path, '..', link.split('#')[0]!))) === target,
    )
    .map((link) => `${slash(relative(REPO_ROOT, path))} -> ${link}`)
}

/** Every name a file exports (declarations and `export { … }` / `export type { … }` clauses), sorted. */
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
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name !== undefined
    )
      names.push(statement.name.text)
  }
  return names.sort()
}

/** Guards whose fixtures spell the retired path on purpose (they test their own matchers or read historical corpora). */
const FIXTURE_USERS = new Set([
  // The architecture report reads historical commits, where `rowToTask` lived in services/task.ts before taskDetailQueries.ts.
  'packages/backend/tests/architecture/architectureReport.ts',
  // RFC-331's topology rules over the (deleted) services/task.ts ↔ scheduler pair keep their matcher self-test fixtures.
  'packages/backend/tests/rfc331-task-execution-topology.test.ts',
])

describe('RFC-478 —— services/task.ts 不在、零引用', () => {
  test('文件不在', () => {
    expect(existsSync(join(SRC, `${RETIRED}.ts`))).toBe(false)
  })

  test('backend 的 src、用例与脚本零 import 它', () => {
    expect(importsOf(walk(SRC))).toEqual([])
    expect(importsOf(walk(TESTS))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'scripts')))).toEqual([])
  }, 60_000)

  test('各包、e2e、仓根脚本与 workflow 里没有指着它的路径（注释不算）', () => {
    const roots = [
      ...['backend', 'shared', 'frontend', 'system-mocks'].flatMap((pkg) =>
        ['src', 'tests', 'scripts'].map((dir) => join(REPO_ROOT, 'packages', pkg, dir)),
      ),
      join(REPO_ROOT, 'e2e'),
      join(REPO_ROOT, 'scripts'),
    ]
    const hits = roots
      .flatMap((root) => walk(root))
      .filter(
        (path) => path !== import.meta.path && !FIXTURE_USERS.has(slash(relative(REPO_ROOT, path))),
      )
      .flatMap((path) => retiredPathLiterals(path, readFileSync(path, 'utf8')))
    expect(hits).toEqual([])
    // Positive control: the exemptions still spell it (they would otherwise be stale entries).
    for (const user of FIXTURE_USERS)
      expect([
        user,
        retiredPathLiterals(join(REPO_ROOT, user), readFileSync(join(REPO_ROOT, user), 'utf8'))
          .length > 0,
      ]).toEqual([user, true])
    const workflows = walk(join(REPO_ROOT, '.github', 'workflows'), /\.ya?ml$/).filter((path) =>
      /packages\/backend\/src\/services\/task\.ts/.test(readFileSync(path, 'utf8')),
    )
    expect(workflows.map((path) => slash(relative(REPO_ROOT, path)))).toEqual([])
  }, 120_000)

  test('design/ 与 docs/ 的 Markdown 相对链接不指着它', () => {
    const markdown = [join(REPO_ROOT, 'design'), join(REPO_ROOT, 'docs')].flatMap((root) =>
      walk(root, /\.md$/),
    )
    expect(markdown.length).toBeGreaterThan(500)
    expect(
      markdown.flatMap((path) => retiredMarkdownLinks(path, readFileSync(path, 'utf8'))),
    ).toEqual([])
    // Negative control: a relative link (with an anchor) is found; a same-prefix sibling and a code span are not.
    expect(
      retiredMarkdownLinks(
        join(REPO_ROOT, 'design', 'RFC-000-probe', 'evidence.md'),
        [
          '[task](../../packages/backend/src/services/task.ts#L162)',
          '[archive](../../packages/backend/src/services/taskArchive.ts)',
          '`packages/backend/src/services/task.ts`',
        ].join('\n'),
      ),
    ).toEqual([
      'design/RFC-000-probe/evidence.md -> ../../packages/backend/src/services/task.ts#L162',
    ])
  })

  test('负对照：判据认得出别名、相对路径、空 import {}、类型与动态 import，也认得出路径字面量；不误伤注释与同前缀', () => {
    expect(targetOf(join(SRC, 'services', 'probe.ts'), './task')).toBe(RETIRED)
    expect(targetOf(join(TESTS, 'probe.test.ts'), '../src/services/task')).toBe(RETIRED)
    const fixture = [
      "import {} from '@/services/task'",
      "export type { X } from '../services/task'",
      "const lazy = import('@/services/task')",
      '// @/services/task (a comment)',
      "import { y } from '@/services/taskArchive'",
      "import { z } from '@/modules/task-execution/infrastructure/taskDetailRead'",
    ].join('\n')
    expect(
      specifiersIn(fixture).filter(
        (specifier) => targetOf(join(SRC, 'routes', 'probe.ts'), specifier) === RETIRED,
      ),
    ).toHaveLength(3)
    expect(
      retiredPathLiterals(
        join(REPO_ROOT, 'probe.ts'),
        [
          "read('packages/backend/src/services/task.ts')",
          "spec('@/services/task')",
          "readFileSync(resolve(dir, '..', 'src', 'services', 'task.ts'), 'utf8')",
          "join(SRC_ROOT, 'src/services', 'task')",
          "read('src/services/taskArchive.ts')",
          "read('src/modules/task-execution/infrastructure/taskDetailRead.ts')",
          "resolve(dir, '..', 'services', 'taskArchive.ts')",
          "resolve(dir, 'shared', 'src', 'schemas', 'task.ts')",
          "createLogger('task')",
          '// packages/backend/src/services/task.ts',
          "// resolve(dir, 'services', 'task.ts')",
        ].join('\n'),
      ),
    ).toEqual([
      'probe.ts: packages/backend/src/services/task.ts',
      'probe.ts: @/services/task',
      'probe.ts: services, task.ts',
      'probe.ts: src/services, task',
    ])
  })
})

describe('RFC-478 —— R1 销账', () => {
  test('census 的 R1 里没有它的边', () => {
    const offending = inboundBoundaryEdges(backendUnits(REPO_ROOT))
      .filter((edge) => edge.from === `${BACKEND_PREFIX}${RETIRED}.ts`)
      .map((edge) => `${edge.from} -> ${edge.to} (${edge.edgeKind})`)
    expect(offending).toEqual([])
  }, 120_000)

  test('负对照：同一规则把 services/ 文件取模块的 composition / application/ports 判为 R1，取 public 不判', () => {
    const probe = (text: string) =>
      inboundBoundaryEdges([sourceUnit(BACKEND_PREFIX + 'services/probe.ts', text)]).map(
        (edge) => edge.to,
      )
    expect(
      probe(
        [
          "import { composeAgentRunDistillObserver } from '@/modules/task-execution/composition/agentRunDistillObserver'",
          "import type { RepositoryPreparationLookup } from '@/modules/task-execution/application/ports/repositoryPreparationLookup'",
          "import { createRunHistorySnapshot } from '@/modules/task-execution/public/queries'",
        ].join('\n'),
      ),
    ).toEqual([
      'modules/task-execution/application/ports/repositoryPreparationLookup',
      'modules/task-execution/composition/agentRunDistillObserver',
    ])
  })
})

describe('RFC-478 —— 按内容分层', () => {
  test('定义处的导出清单', () => {
    const expectations: ReadonlyArray<readonly [string, readonly string[]]> = [
      [
        TE + 'domain/builtinWorkflowLayout.ts',
        [
          'layoutBuiltinWorkflowSnapshot',
          'layoutBuiltinWorkflowSnapshotJson',
          'projectWorkflowSnapshotForRead',
        ],
      ],
      [
        TE + 'domain/workflowSyncPreview.ts',
        [
          'buildSyncRunSummary',
          'builtinWorkflowSyncPreview',
          'notSyncableWorkflowPreview',
          'parseSnapshotDefinition',
          'workflowSyncGateReason',
        ],
      ],
      [
        TE + 'application/workflowSyncPreviewQuery.ts',
        ['WorkflowSyncPreviewValidation', 'computeWorkflowSyncPreview'],
      ],
      [TE + 'application/ports/workflowSyncPreviewReads.ts', ['WorkflowSyncPreviewReads']],
      [
        TE + 'application/resumeRollbackTargets.ts',
        ['selectResumeRollbackTargets', 'selectSyncRollbackTargets'],
      ],
      [TE + 'infrastructure/workflowSyncPreviewReads.ts', ['createWorkflowSyncPreviewReads']],
      [
        TE + 'infrastructure/deferredRepositoryPreparation.ts',
        [
          'DeferredRepositoryPreparationDependencies',
          'createDeferredRepositoryPreparationMechanics',
          'createDeferredRepositoryPreparationReader',
        ],
      ],
      [TE + 'infrastructure/taskDetailRead.ts', ['getTask', 'loadTaskFailureCodes']],
      [
        TE + 'composition/taskDriveRuntimeOptions.ts',
        ['TaskDriveRuntimeConfiguration', 'TaskDriveRuntimeOptions', 'runtimeConfigOpts'],
      ],
      [
        TE + 'composition/deferredRepositoryPreparation.ts',
        ['composeDeferredRepositoryPreparation', 'composeDeferredRepositoryPreparationStep'],
      ],
    ]
    for (const [path, names] of expectations)
      expect([path, exportedNames(path, read(path))]).toEqual([path, [...names].sort()])
  })

  test('domain 纯；同步预览的 application 不取 infrastructure 与 legacy', () => {
    for (const path of [
      TE + 'domain/builtinWorkflowLayout.ts',
      TE + 'domain/workflowSyncPreview.ts',
    ])
      expect([
        path,
        specifiersIn(read(path)).filter(
          (s) => s.startsWith('node:') || s.startsWith('@/db') || s === 'drizzle-orm',
        ),
      ]).toEqual([path, []])
    const fencedApplication = (text: string) =>
      specifiersIn(text).filter(
        (s) =>
          /(?:^|\/)infrastructure(?:\/|$)/.test(s) ||
          /^@\/(?:services|routes|ws|mcp|db)\//.test(s) ||
          s === 'drizzle-orm',
      )
    for (const path of [
      TE + 'application/workflowSyncPreviewQuery.ts',
      TE + 'application/ports/workflowSyncPreviewReads.ts',
      TE + 'application/resumeRollbackTargets.ts',
    ])
      expect([path, fencedApplication(read(path))]).toEqual([path, []])
    // Negative control: the same reader reports an infrastructure and a legacy import.
    expect(
      fencedApplication(
        "import { x } from '../infrastructure/nodeRunQueries'\nimport { y } from '@/services/legacyProbe'\n",
      ),
    ).toEqual(['../infrastructure/nodeRunQueries', '@/services/legacyProbe'])
  })

  test('延后准备的 infrastructure 不取 source-control，只经 task 自有的准备绑定', () => {
    const sourceControl = (text: string) =>
      specifiersIn(text).filter((s) => s.startsWith('@/modules/source-control/'))
    const preparation = read(TE + 'infrastructure/deferredRepositoryPreparation.ts')
    expect(sourceControl(preparation)).toEqual([])
    expect(specifiersIn(preparation).filter((s) => s.startsWith('@/services/'))).toEqual([])
    expect(preparation).toContain(
      "import type { TaskRepositoryPreparationBinding } from './repositoryPreparationBinding'",
    )
    // Negative control: a deep import of source-control's composition is reported.
    expect(
      sourceControl(
        "import { cleanupMaterializedSpaceLease } from '@/modules/source-control/composition'",
      ),
    ).toEqual(['@/modules/source-control/composition'])
  })
})

describe('RFC-478 —— 准备绑定与清理账本', () => {
  test('绑定必填；组成员解析与 groupName 同一段解析', () => {
    const preparation = read(TE + 'infrastructure/deferredRepositoryPreparation.ts')
    expect(preparation).toContain(
      '  readonly repositoryPreparation: TaskRepositoryPreparationBinding\n',
    )
    expect(preparation).not.toContain('repositoryPreparation?:')
    // The deleted no-binding fallback took `repositoryWorkspace`; only a comment still names it.
    expect(codeOnly(preparation)).not.toContain('repositoryWorkspace')
    expect(read(TE + 'infrastructure/repositoryPreparationBinding.ts')).toContain(
      '  groupCachedRepoIds(groupId: string): Promise<readonly string[]>\n',
    )
    const binding = read('modules/source-control/composition/repositoryPreparation.ts')
    const resolution =
      '        await resolveRepoGroupLayout(\n' +
      '          composeRepositoryWorkspaceStore(input.db, input.taskPorts),\n' +
      '          groupId,\n' +
      '        )\n'
    const groupName = binding.indexOf('    async groupName(groupId: string): Promise<string> {')
    const memberIds = binding.indexOf(
      '    async groupCachedRepoIds(groupId: string): Promise<readonly string[]> {',
    )
    expect(groupName).toBeGreaterThan(0)
    expect(memberIds).toBeGreaterThan(groupName)
    expect(binding.slice(groupName, memberIds)).toContain(resolution)
    expect(binding.slice(memberIds, binding.indexOf('    legacy: {', memberIds))).toContain(
      resolution + '      ).repos.map((repository) => repository.cachedRepoId)\n',
    )
  })

  test('空清理账本与 source-control 构造的逐字段相同', () => {
    expect(createMaterializedSpaceCleanup('rfc478-task', null)).toEqual({
      taskId: 'rfc478-task',
      ownedRoot: null,
      worktrees: [],
      state: 'owned',
      report: null,
    })
    expect(read(TE + 'infrastructure/deferredRepositoryPreparation.ts')).toContain(
      '      const cleanup: MaterializedSpaceCleanup = {\n' +
        '        taskId: descriptor.taskId,\n' +
        '        ownedRoot: null,\n' +
        '        worktrees: [],\n' +
        "        state: 'owned',\n" +
        '        report: null,\n' +
        '      }\n',
    )
  })
})

describe('RFC-478 —— public 收口与测试专用出口', () => {
  test('失去模块外生产消费方的 public 符号已撤出', () => {
    const withdrawn: ReadonlyArray<readonly [string, Record<string, unknown>, readonly string[]]> =
      [
        [
          TE + 'public/queries.ts',
          taskExecutionQueries,
          [
            'createRunHistoryBatchSnapshot',
            'createTaskDetailQueries',
            'createTaskPreparationQueries',
            'resolveTaskLaunchRuntimeConfiguration',
            'TaskDetailQueries',
            'TaskLaunchConfigurationQueries',
            'TaskPreparationQueries',
          ],
        ],
        [
          TE + 'public/participants.ts',
          taskExecutionParticipants,
          [
            'builtinWorkflowSyncPreview',
            'createLocalEffectAttemptObserver',
            'createTaskPreparationParticipantInTx',
            'setNodeRunStatusInTransaction',
            'taskExecutionModule',
            'TaskPreparationParticipant',
            'workflowSyncGateReason',
          ],
        ],
        // The retry reclaim was source-control's last outside reader; it now resolves group members through the binding.
        [
          'modules/source-control/public/queries.ts',
          sourceControlQueries,
          ['resolveRepoGroupLayout'],
        ],
      ]
    for (const [path, namespace, names] of withdrawn) {
      const exported = exportedNames(path, read(path))
      for (const name of names) {
        expect([path, name, exported.includes(name)]).toEqual([path, name, false])
        expect([name, name in namespace]).toEqual([name, false])
      }
    }
    // Positive control: the reader sees what the entries still offer.
    expect(exportedNames(TE + 'public/queries.ts', read(TE + 'public/queries.ts'))).toContain(
      'createRunHistorySnapshot',
    )
    expect('currentTaskExecutionContext' in taskExecutionParticipants).toBe(true)
    // RFC-480 retired `public/operations` as a whole: the three names RFC-478 withdrew from it are in no surviving
    // entry either (the namespace import of that file went with it).
    expect(existsSync(join(SRC, TE + 'public/operations.ts'))).toBe(false)
    for (const entry of ['commands', 'queries', 'participants', 'types', 'events']) {
      const path = TE + `public/${entry}.ts`
      const exported = exportedNames(path, read(path))
      for (const name of ['mintNodeRun', 'setNodeRunStatus', 'setTaskStatus'])
        expect([path, name, exported.includes(name)]).toEqual([path, name, false])
    }
    expect(
      exportedNames(TE + 'public/participants.ts', read(TE + 'public/participants.ts')),
    ).toContain('currentTaskExecutionContext')
  })

  test('测试专用出口只在 tests/helpers/，零调用方的停机函数不在 src', () => {
    expect(
      exportedNames(
        'tests/helpers/taskDriverRegistry.ts',
        readFileSync(join(TESTS, 'helpers', 'taskDriverRegistry.ts'), 'utf8'),
      ),
    ).toEqual(['abortAllActiveTasks', 'isTaskActive'])
    expect(
      exportedNames(
        'tests/helpers/taskContinuationDependencies.ts',
        readFileSync(join(TESTS, 'helpers', 'taskContinuationDependencies.ts'), 'utf8'),
      ),
    ).toEqual(['TaskContinuationDependencies'])
    const declared = walk(SRC).flatMap((path) => {
      const text = readFileSync(path, 'utf8')
      return [
        'function isTaskActive(',
        'function abortAllActiveTasks(',
        'function shutdownActiveTaskExecutions(',
        'interface TaskContinuationDependencies ',
      ]
        .filter((needle) => text.includes(needle))
        .map((needle) => `${slash(relative(SRC, path))}: ${needle}`)
    })
    expect(declared).toEqual([])
  }, 60_000)
})

describeEachProvider('RFC-478 —— 同步预览读端口', (harness) => {
  test('四个读与直接查询同值', async () => {
    const taskId = `rfc478-task-${process.pid}`
    await seedTask(harness.db, taskId)
    await nodeRunFixture(harness.db, {
      id: `${taskId}-a0`,
      taskId,
      nodeId: 'a',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await nodeRunFixture(harness.db, {
      id: `${taskId}-a1`,
      taskId,
      nodeId: 'a',
      status: 'failed',
      retryIndex: 1,
      iteration: 0,
    })
    await nodeRunOutputFixture(harness.db, {
      nodeRunId: `${taskId}-a0`,
      portName: 'answer',
      content: 'rfc478',
      kind: 'markdown',
    })
    const reads = createWorkflowSyncPreviewReads(harness.db)
    expect(await reads.listNodeRuns(taskId)).toEqual(
      await createNodeRunQueries(harness.db).list({ taskId }),
    )
    const direct = (
      await createRunSelectionReader(harness.db).familyHistory(
        taskId,
        { nodeId: 'a' },
        { topLevelOnly: true, statusIn: ['done'] },
      )
    ).at(-1)
    const freshest = await reads.freshestDoneTopLevelRunId(taskId, 'a')
    expect(freshest).toBe(direct?.id ?? null)
    // Positive control: the done run is found even though a later failed attempt exists.
    expect(freshest).toBe(`${taskId}-a0`)
    expect(await reads.freshestDoneTopLevelRunId(taskId, 'missing-node')).toBeNull()
    expect(await reads.producedPorts([`${taskId}-a0`])).toEqual(
      await createNodeOutputQueries(harness.db).listProducedPorts([`${taskId}-a0`]),
    )
    expect((await reads.producedPorts([`${taskId}-a0`])).map((row) => row.portName)).toEqual([
      'answer',
    ])
    expect(await reads.frozenTriggerContext(taskId)).toEqual(
      await createTaskTriggerQueries(harness.db).frozenContext(taskId),
    )
  })
})
