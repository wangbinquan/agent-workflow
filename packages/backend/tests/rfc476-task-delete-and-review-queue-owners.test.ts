// RFC-476 — 任务删除与评审变更队列归 task-execution（RFC-294 W9-D 第二十三步）。
//
// 锁五件事：
// ① `services/taskDelete.ts` 与 `services/reviewMutationCoordinator.ts` 不在：backend 的 src / 用例 / 脚本零 import（`preProcessFile` 取全部
//    模块引用，带负对照）；各包、e2e 与仓根脚本里没有指着它们的路径字面量（注释不算，带负对照）；workflow 与 `design/`、`docs/` 的 Markdown
//    相对链接也不指着它们（带负对照）。
// ② census 的 `R1` 里没有它们；负对照：同一规则把 `services/` 文件取两个模块内部的合成样例判为 `R1`。
// ③ 方向（目标 DAG：collaboration → task-execution 是 offered 边，反向只有 required-implementation）：队列在 task-execution、不取
//    collaboration；collaboration 只经 task-execution `public/participants` 进队列（带负对照）；删除实现不取 task-execution 自己的 public。
// ④ 合同与收口：task-execution public 交出参与方（只交值）；task-execution public 不再交出只剩删除实现在取的九个符号；bootstrap 的
//    删除恢复取自 `composition/bootRecovery`，与恢复实现是同一函数。
// ⑤ 队列行为：同一任务串行、不同任务并行、`reserve` 在调用时同步取号、已发出的作用域解析排在之后的 task 键入口前面、解析不到任务时
//    不入队、失败的工作不毒化后来者、队列用完即清。
// 行为由既有用例覆盖（都改走新位置）：删除一族（`rfc243`、`rfc287-t13`、`rfc311`、`rfc328`、`rfc359-t7c` / `w7` / `w8-t28`、`rfc370`），
// 评审 / 取消一族（`review-cancel-concurrency`、`review-decision-full-asserts`、`review-multidoc`、`rfc326`、`rfc359-w5hm` / `w11` / `w12`、
// `fusion-engine`、`lifecycle-repair-S1`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, inboundBoundaryEdges, sourceUnit } from './architecture/census'
import { BACKEND_PREFIX } from './architecture/rfc294Gates'
import {
  __hasTaskReviewMutationQueueForTesting,
  reserveTaskReviewMutationSlot,
  taskReviewMutationQueue,
} from '@/modules/task-execution/infrastructure/reviewMutationQueue'
import { recoverInterruptedTaskDeletes as composedRecovery } from '@/modules/task-execution/composition/bootRecovery'
import { recoverInterruptedTaskDeletes } from '@/modules/task-execution/infrastructure/taskDeleteRecovery'
import * as taskExecutionParticipants from '@/modules/task-execution/public/participants'
import * as taskExecutionQueries from '@/modules/task-execution/public/queries'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RETIRED = ['services/taskDelete', 'services/reviewMutationCoordinator'] as const
const TE = 'modules/task-execution/'
const CO = 'modules/collaboration/'
const QUEUE = TE + 'infrastructure/reviewMutationQueue.ts'
/** collaboration's entry into the queue (review-scope resolution and its not-found error stay here). */
const LOCK = CO + 'infrastructure/reviewMutationLock.ts'
const DELETE = TE + 'infrastructure/taskDelete.ts'
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

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

const isRetired = (stem: string | null) => (RETIRED as readonly string[]).includes(stem ?? '')

const importsOf = (files: readonly string[]) =>
  files.flatMap((path) =>
    specifiersIn(readFileSync(path, 'utf8'))
      .filter((specifier) => isRetired(targetOf(path, specifier)))
      .map((specifier) => `${slash(relative(REPO_ROOT, path))} -> ${specifier}`),
  )

const RETIRED_PATH = /(?:^|[/'"@])services\/(?:taskDelete|reviewMutationCoordinator)(?:\.ts)?$/

/** String literals (not comments) that name a retired file by path — the shape `readFileSync(<path>)` locks use. */
function retiredPathLiterals(path: string, text: string): string[] {
  if (!text.includes('taskDelete') && !text.includes('reviewMutationCoordinator')) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      RETIRED_PATH.test(node.text)
    )
      hits.push(`${slash(relative(REPO_ROOT, path))}: ${node.text}`)
    node.forEachChild(visit)
  }
  visit(source)
  return hits
}

/** Markdown relative links (`](…)`, anchors dropped) that resolve to a retired file. */
function retiredMarkdownLinks(path: string, text: string): string[] {
  if (!text.includes('taskDelete') && !text.includes('reviewMutationCoordinator')) return []
  const targets = RETIRED.map((stem) => `packages/backend/src/${stem}.ts`)
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1]!)
    .filter((link) => !/^[a-z]+:/i.test(link))
    .filter((link) =>
      targets.includes(slash(relative(REPO_ROOT, resolve(path, '..', link.split('#')[0]!)))),
    )
    .map((link) => `${slash(relative(REPO_ROOT, path))} -> ${link}`)
}

/** The module specifier the import that binds `name` comes from (or null). */
function sourceOfName(path: string, text: string, name: string): string | null {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const named = statement.importClause?.namedBindings
    if (named !== undefined && ts.isNamedImports(named))
      if (named.elements.some((element) => element.name.text === name))
        return statement.moduleSpecifier.text
  }
  return null
}

/** Module specifiers under `prefix` that a file imports values from (type-only imports and type-only names excluded). */
function valueImportsFrom(path: string, text: string, prefix: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const specifier = statement.moduleSpecifier.text
    if (!specifier.startsWith(prefix)) continue
    const clause = statement.importClause
    if (clause === undefined) {
      hits.push(specifier)
      continue
    }
    if (clause.isTypeOnly) continue
    const named = clause.namedBindings
    const valueNamed =
      named !== undefined &&
      (ts.isNamespaceImport(named) || named.elements.some((element) => !element.isTypeOnly))
    if (clause.name !== undefined || valueNamed) hits.push(specifier)
  }
  return hits
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

/** Module specifiers of a file that leave the module through anything but another context's exact `public/` entry. */
function crossContextInternals(text: string, ownContext: string): string[] {
  return specifiersIn(text).filter((specifier) => {
    const match = /^@\/modules\/([a-z-]+)\/(.+)$/.exec(specifier)
    if (match === null || match[1] === ownContext) return false
    return !/^public\/(?:commands|queries|participants|events|operations|types)$/.test(match[2]!)
  })
}

describe('RFC-476 —— 两个 services/ 文件不在、零引用', () => {
  test('文件不在', () => {
    for (const stem of RETIRED)
      expect([stem, existsSync(join(SRC, `${stem}.ts`))]).toEqual([stem, false])
  })

  test('backend 的 src、用例与脚本零 import 它们', () => {
    expect(importsOf(walk(SRC))).toEqual([])
    expect(importsOf(walk(TESTS))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'scripts')))).toEqual([])
  }, 60_000)

  test('各包、e2e、仓根脚本与 workflow 里没有指着它们的路径（注释不算）', () => {
    const roots = [
      ...['backend', 'shared', 'frontend', 'system-mocks'].flatMap((pkg) =>
        ['src', 'tests', 'scripts'].map((dir) => join(REPO_ROOT, 'packages', pkg, dir)),
      ),
      join(REPO_ROOT, 'e2e'),
      join(REPO_ROOT, 'scripts'),
    ]
    const hits = roots
      .flatMap((root) => walk(root))
      // This file, and RFC-317 T14's matcher self-test that fabricates a forbidden `@/services/taskDelete` import.
      .filter(
        (path) =>
          path !== import.meta.path &&
          slash(relative(REPO_ROOT, path)) !==
            'packages/backend/tests/rfc303-architecture-lock.test.ts',
      )
      .flatMap((path) => retiredPathLiterals(path, readFileSync(path, 'utf8')))
    expect(hits).toEqual([])
    const workflows = walk(join(REPO_ROOT, '.github', 'workflows'), /\.ya?ml$/).filter((path) =>
      /packages\/backend\/src\/services\/(?:taskDelete|reviewMutationCoordinator)\.ts/.test(
        readFileSync(path, 'utf8'),
      ),
    )
    expect(workflows.map((path) => slash(relative(REPO_ROOT, path)))).toEqual([])
  }, 120_000)

  test('design/ 与 docs/ 的 Markdown 相对链接不指着它们', () => {
    const markdown = [join(REPO_ROOT, 'design'), join(REPO_ROOT, 'docs')].flatMap((root) =>
      walk(root, /\.md$/),
    )
    // Positive control: the corpus is the whole design tree.
    expect(markdown.length).toBeGreaterThan(500)
    expect(
      markdown.flatMap((path) => retiredMarkdownLinks(path, readFileSync(path, 'utf8'))),
    ).toEqual([])
    // Negative control: relative links to either retired file are found; a sibling and a code span are not.
    expect(
      retiredMarkdownLinks(
        join(REPO_ROOT, 'design', 'RFC-000-probe', 'evidence.md'),
        [
          '[delete](../../packages/backend/src/services/taskDelete.ts#L91)',
          '[queue](../../packages/backend/src/services/reviewMutationCoordinator.ts)',
          // RFC-478 retired services/task.ts; another existing services/ sibling is the non-retired control.
          '[agent](../../packages/backend/src/services/systemAgentRun.ts)',
          '`packages/backend/src/services/taskDelete.ts`',
        ].join('\n'),
      ),
    ).toEqual([
      'design/RFC-000-probe/evidence.md -> ../../packages/backend/src/services/taskDelete.ts#L91',
      'design/RFC-000-probe/evidence.md -> ../../packages/backend/src/services/reviewMutationCoordinator.ts',
    ])
  })

  test('负对照：判据认得出别名、相对路径、空 import {}、类型转出与动态 import，也认得出路径字面量；不误伤注释与同前缀', () => {
    expect(targetOf(join(SRC, 'services', 'probe.ts'), './taskDelete')).toBe('services/taskDelete')
    expect(
      targetOf(join(TESTS, 'probe.test.ts'), '../src/services/reviewMutationCoordinator'),
    ).toBe('services/reviewMutationCoordinator')
    const fixture = [
      "import {} from '@/services/taskDelete'",
      "export type { X } from '../services/reviewMutationCoordinator'",
      "const lazy = import('@/services/taskDelete')",
      '// @/services/taskDelete (a comment)',
      "import { y } from '@/services/taskDeleteSummary'",
      "import { z } from '@/modules/task-execution/infrastructure/taskDelete'",
    ].join('\n')
    expect(
      specifiersIn(fixture).filter((specifier) =>
        isRetired(targetOf(join(SRC, 'routes', 'probe.ts'), specifier)),
      ),
    ).toHaveLength(3)
    expect(
      retiredPathLiterals(
        // An absolute probe path: `relative(REPO_ROOT, …)` of a bare name would resolve against the process cwd.
        join(REPO_ROOT, 'probe.ts'),
        [
          "read('packages/backend/src/services/taskDelete.ts')",
          "spec('@/services/reviewMutationCoordinator')",
          "read('src/services/taskDeletes.ts')",
          "read('src/modules/task-execution/infrastructure/taskDelete.ts')",
          '// packages/backend/src/services/reviewMutationCoordinator.ts',
        ].join('\n'),
      ),
    ).toEqual([
      'probe.ts: packages/backend/src/services/taskDelete.ts',
      'probe.ts: @/services/reviewMutationCoordinator',
    ])
  })
})

describe('RFC-476 —— R1 销账与方向', () => {
  test('census 的 R1 里没有它们的边', () => {
    const offending = inboundBoundaryEdges(backendUnits(REPO_ROOT))
      .filter((edge) => RETIRED.some((stem) => edge.from === `${BACKEND_PREFIX}${stem}.ts`))
      .map((edge) => `${edge.from} -> ${edge.to} (${edge.edgeKind})`)
    expect(offending).toEqual([])
  }, 120_000)

  test('负对照：同一规则把 services/ 文件取两个模块的 infrastructure 判为 R1，取 public 不判', () => {
    const probe = (text: string) =>
      inboundBoundaryEdges([sourceUnit(BACKEND_PREFIX + 'services/probe.ts', text)]).map(
        (edge) => edge.to,
      )
    expect(
      probe(
        [
          "import { recoverInterruptedTaskDeletes } from '@/modules/task-execution/infrastructure/taskDeleteRecovery'",
          "import { DatabaseReviewMutationScopeResolver } from '@/modules/collaboration/infrastructure/reviewMutationScope'",
          "import { taskReviewMutationQueue } from '@/modules/collaboration/public/participants'",
        ].join('\n'),
      ),
    ).toEqual([
      'modules/collaboration/infrastructure/reviewMutationScope',
      'modules/task-execution/infrastructure/taskDeleteRecovery',
    ])
  })

  test('队列在 task-execution、不取 collaboration；collaboration 只经 task-execution public 进队列；删除实现不取自己的 public', () => {
    expect(specifiersIn(read(QUEUE)).filter((s) => s.startsWith('@/modules/'))).toEqual([])
    expect(crossContextInternals(read(LOCK), 'collaboration')).toEqual([])
    // Positive control: collaboration's adapter does take the participant from task-execution's public entry,
    // and collaboration's review and collaborator writers go through the adapter.
    expect(sourceOfName(LOCK, read(LOCK), 'taskReviewMutationQueue')).toBe(
      '@/modules/task-execution/public/participants',
    )
    for (const [path, name] of [
      [CO + 'infrastructure/review.ts', 'withReviewNodeMutationLock'],
      [CO + 'infrastructure/review.ts', 'withTaskReviewMutationLock'],
      [CO + 'infrastructure/taskCollab.ts', 'withTaskReviewMutationLock'],
    ] as const)
      expect([path, name, sourceOfName(path, read(path), name)]).toEqual([
        path,
        name,
        './reviewMutationLock',
      ])
    // Negative control: a deep import of the queue implementation is reported.
    expect(
      crossContextInternals(
        [
          "import { withTaskReviewMutationLock } from '@/modules/task-execution/infrastructure/reviewMutationQueue'",
          "import { taskReviewMutationQueue } from '@/modules/task-execution/public/participants'",
        ].join('\n'),
        'collaboration',
      ),
    ).toEqual(['@/modules/task-execution/infrastructure/reviewMutationQueue'])
    expect(
      specifiersIn(read(DELETE)).filter((specifier) =>
        /^(?:@\/modules\/task-execution\/public\/|(?:\.\.\/)+public\/)/.test(specifier),
      ),
    ).toEqual([])
  })

  test('删除实现不取 collaboration：协作一半是 task-execution 自有的端口，由组合根注入 collaboration 的实现', () => {
    expect(
      specifiersIn(read(DELETE)).filter((s) => s.startsWith('@/modules/collaboration/')),
    ).toEqual([])
    // Positive control: the port the delete takes is task-execution's own.
    expect(sourceOfName(DELETE, read(DELETE), 'TaskDeletionCollaborationInTx')).toBe(
      '../application/ports/taskDeletionCollaboration',
    )
    // Negative control: the value-import reader reports a value import and ignores a type-only one.
    expect(
      valueImportsFrom(
        DELETE,
        [
          "import { createTaskDeletionCollaborationParticipantInTx } from '@/modules/collaboration/public/participants'",
          "import type { TaskDeletionCollaborationParticipant } from '@/modules/collaboration/public/types'",
        ].join('\n'),
        '@/modules/collaboration/',
      ),
    ).toEqual(['@/modules/collaboration/public/participants'])
    const root = read('bootstrap/daemonModules/taskExecution.ts')
    expect(root).toContain(
      'taskDeletionCollaboration: createTaskDeletionCollaborationParticipantInTx,',
    )
    expect(
      sourceOfName(
        'bootstrap/daemonModules/taskExecution.ts',
        root,
        'createTaskDeletionCollaborationParticipantInTx',
      ),
      // RFC-481: bootstrap takes the factory from collaboration's composition (it left public/participants).
    ).toBe('@/modules/collaboration/composition')
  })
})

describe('RFC-476 —— 合同与 public 收口', () => {
  test('task-execution public 交出队列参与方（只交值，合同类型留在端口里）', () => {
    expect(taskExecutionParticipants.taskReviewMutationQueue).toBe(taskReviewMutationQueue)
    expect(
      exportedNames(TE + 'public/participants.ts', read(TE + 'public/participants.ts')).filter(
        (name) => /^TaskReview|^taskReviewMutationQueue$/.test(name),
      ),
    ).toEqual(['taskReviewMutationQueue'])
    expect(Object.keys(taskReviewMutationQueue).sort()).toEqual([
      'serialize',
      'serializeAfterLookup',
    ])
    expect(Object.isFrozen(taskReviewMutationQueue)).toBe(true)
  })

  test('task-execution public 不再交出只剩删除实现在取的符号', () => {
    const withdrawn = [
      'ActiveTaskExecutionParticipant',
      'TaskDeletionParticipant',
      'TaskDeletionQueries',
      'TerminalMaintenanceStore',
      'assertTerminalMaintenanceClaimTx',
      'createTaskDeletionParticipantInTx',
      'createTaskDeletionQueries',
      'createTerminalMaintenanceStore',
      'transitionTerminalMaintenanceClaimTx',
    ]
    const exported = [
      ...exportedNames(TE + 'public/participants.ts', read(TE + 'public/participants.ts')),
      ...exportedNames(TE + 'public/queries.ts', read(TE + 'public/queries.ts')),
    ]
    expect(withdrawn.filter((name) => exported.includes(name))).toEqual([])
    for (const name of withdrawn) {
      expect([name, name in taskExecutionParticipants]).toEqual([name, false])
      expect([name, name in taskExecutionQueries]).toEqual([name, false])
    }
    // Positive control: the export reader sees what the entry still offers.
    // RFC-478 withdrew `createTaskPreparationParticipantInTx`; its sibling factory stays.
    expect(exported).toContain('createConsumedInputsParticipantInTx')
    expect(exported).toContain('TaskExecutionPermits')
  })

  test('bootstrap 的删除恢复取自 composition/bootRecovery，与恢复实现是同一函数', () => {
    expect(composedRecovery).toBe(recoverInterruptedTaskDeletes)
    expect(
      sourceOfName(
        'bootstrap/daemonApplication.ts',
        read('bootstrap/daemonApplication.ts'),
        'recoverInterruptedTaskDeletes',
      ),
    ).toBe('@/modules/task-execution/composition/bootRecovery')
  })
})

describe('RFC-476 —— 评审变更队列的行为', () => {
  let n = 0
  const taskId = () => `rfc476-task-${process.pid}-${++n}`
  const gate = () => {
    let open: () => void = () => {}
    const opened = new Promise<void>((resolve) => {
      open = resolve
    })
    return { open, opened }
  }

  test('同一任务串行：后来者等前一个做完', async () => {
    const id = taskId()
    const order: string[] = []
    const started = gate()
    const first = gate()
    const a = taskReviewMutationQueue.serialize(id, {
      run: async () => {
        order.push('a:start')
        started.open()
        await first.opened
        order.push('a:end')
        return 'a'
      },
    })
    const b = taskReviewMutationQueue.serialize(id, {
      run: async () => {
        order.push('b')
        return 'b'
      },
    })
    await started.opened
    expect(order).toEqual(['a:start'])
    first.open()
    expect(await Promise.all([a, b])).toEqual(['a', 'b'])
    expect(order).toEqual(['a:start', 'a:end', 'b'])
    expect(__hasTaskReviewMutationQueueForTesting(id)).toBe(false)
  })

  test('不同任务并行', async () => {
    const [x, y] = [taskId(), taskId()]
    const held = gate()
    const order: string[] = []
    const a = taskReviewMutationQueue.serialize(x, {
      run: async () => {
        await held.opened
        order.push('x')
      },
    })
    await taskReviewMutationQueue.serialize(y, {
      run: async () => {
        order.push('y')
      },
    })
    expect(order).toEqual(['y'])
    held.open()
    await a
    expect(order).toEqual(['y', 'x'])
  })

  test('reserve 在调用时同步取号：先取号者先跑，即使后来者先入队', async () => {
    const id = taskId()
    const order: string[] = []
    const enter = reserveTaskReviewMutationSlot(id)
    expect(__hasTaskReviewMutationQueueForTesting(id)).toBe(true)
    const later = taskReviewMutationQueue.serialize(id, {
      run: async () => {
        order.push('serialize')
      },
    })
    await Promise.resolve()
    const reserved = enter(async () => {
      order.push('reserve')
      return 7
    })
    expect(await reserved).toBe(7)
    await later
    expect(order).toEqual(['reserve', 'serialize'])
  })

  test('已发出的作用域解析排在之后的 task 键入口前面（先发出者先入队）', async () => {
    const id = taskId()
    const order: string[] = []
    const lookup = gate()
    let resolveLookup: (value: string | null) => void = () => {}
    const pending = new Promise<string | null>((resolve) => {
      resolveLookup = resolve
    })
    const scoped = taskReviewMutationQueue.serializeAfterLookup(pending, {
      run: async () => {
        order.push('scoped')
        return 'scoped'
      },
      missing: async () => {
        throw new Error('unexpected missing')
      },
    })
    // Issued after the lookup: it must wait for the lookup to join first.
    const keyed = taskReviewMutationQueue.serialize(id, {
      run: async () => {
        order.push('keyed')
        return 'keyed'
      },
    })
    lookup.open()
    await lookup.opened
    await Promise.resolve()
    expect(order).toEqual([])
    resolveLookup(id)
    expect(await Promise.all([scoped, keyed])).toEqual(['scoped', 'keyed'])
    expect(order).toEqual(['scoped', 'keyed'])
    expect(__hasTaskReviewMutationQueueForTesting(id)).toBe(false)
  })

  test('解析不到任务时走 missing、不入队；同步抛出的 missing 以拒绝交回', async () => {
    let ran = false
    const outcome = taskReviewMutationQueue.serializeAfterLookup(Promise.resolve(null), {
      run: async () => {
        ran = true
        return 'ran'
      },
      missing: () => {
        throw new Error('rfc476 not found')
      },
    })
    await expect(outcome).rejects.toThrow('rfc476 not found')
    expect(ran).toBe(false)
  })

  test('失败的工作不毒化后来者，队列用完即清', async () => {
    const id = taskId()
    const failing = taskReviewMutationQueue.serialize(id, {
      run: async () => {
        throw new Error('rfc476 probe failure')
      },
    })
    const next = taskReviewMutationQueue.serialize(id, { run: async () => 'ok' })
    await expect(failing).rejects.toThrow('rfc476 probe failure')
    expect(await next).toBe('ok')
    expect(__hasTaskReviewMutationQueueForTesting(id)).toBe(false)
  })
})
