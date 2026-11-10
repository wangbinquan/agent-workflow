// RFC-470 — 退役最后两个薄转出 workflow / workflow.validator 与 taskLaunchGate：任务启动资源适配器归 resource-catalog（RFC-294 W9-D 第十七步）。
//
// 锁五件事：
// ① `services/workflow.ts`、`services/workflow.validator.ts`、`services/taskLaunchGate.ts` 与 task-execution 原先的启动资源实现 / 组合文件不在，
//    src / 用例 / 脚本零 import 它们（TypeScript `preProcessFile` 取文件的全部模块引用，带负对照）。
// ② resource-catalog 的启动资源实现与 task-execution 的端口逐项相同（编译期锁：两边各写一份同形的类型，resource-catalog 不取 task-execution）；
//    端口补了 `readWorkflow`、校验候选补了 `frozenClosureJson`、校验问题带 `code`。
// ③ 工作流同步预览与同步门经端口读工作流行（不再取 `getWorkflow`），`services/task.ts` 的同步预览经注入的 `validateHostWorkflow` 校验并透传
//    候选的冻结调用闭包；装配根取 resource-catalog 的 composition。
// ④ `PLUGIN_DISABLED_SITES` 的锚点文件都在。
// ⑤ 行为：`readWorkflow` 读到行、不存在回 null；快照校验门在新位置对非法快照抛 `workflow-invalid`（带 issues）、合法的不抛。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import type * as TaskExecutionPort from '@/modules/task-execution/application/ports/agentLaunchResourceOperations'
import type * as ResourceCatalogImplementation from '@/modules/resource-catalog/infrastructure/agentLaunchResourceOperations'
import {
  assertWorkflowSnapshotLaunchable,
  composeAgentLaunchResourceOperations,
} from '@/modules/resource-catalog/composition/agentLaunchResources'
import { PLUGIN_DISABLED_SITES } from '@/modules/resource-catalog/domain/disabledResourcePolicy'
import { DomainError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'
import { createWorkflow } from './helpers/model/resourceWrites'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RETIRED = [
  'services/workflow',
  'services/workflow.validator',
  'services/taskLaunchGate',
  'modules/task-execution/infrastructure/agentLaunchResourceOperations',
  'modules/task-execution/composition/agentLaunchResources',
]
const RC_COMPOSITION = '@/modules/resource-catalog/composition/agentLaunchResources'
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Every module specifier a file references: static (incl. empty `import {}`), side-effect, re-export, type, dynamic, require. */
const specifiersIn = (text: string) =>
  ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName)

/** Resolve an import specifier to a `src/`-relative path stem (alias and relative forms), or null. */
function targetOf(from: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return specifier.slice(2)
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

// ② compile-time lock: the two declarations of the port shape are identical, member by member.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const sameOperations: Equal<
  ResourceCatalogImplementation.AgentLaunchResourceOperations,
  TaskExecutionPort.AgentLaunchResourceOperations
> = true
const sameIssue: Equal<
  ResourceCatalogImplementation.AgentLaunchValidationIssue,
  TaskExecutionPort.AgentLaunchValidationIssue
> = true
const sameCandidate: Equal<
  ResourceCatalogImplementation.AgentLaunchWorkflowValidationCandidate,
  TaskExecutionPort.AgentLaunchWorkflowValidationCandidate
> = true
const sameAclRow: Equal<
  ResourceCatalogImplementation.AgentLaunchWorkflowAclRow,
  TaskExecutionPort.AgentLaunchWorkflowAclRow
> = true
const sameAgentQuery: Equal<
  ResourceCatalogImplementation.AgentLaunchVisibleAgentQuery,
  TaskExecutionPort.AgentLaunchVisibleAgentQuery
> = true
const sameValidation: Equal<
  ResourceCatalogImplementation.AgentLaunchWorkflowValidation,
  TaskExecutionPort.AgentLaunchWorkflowValidation
> = true
// The assembly root hands the composed value to task-execution as its port.
const handOver = (
  operations: ReturnType<typeof composeAgentLaunchResourceOperations>,
): TaskExecutionPort.AgentLaunchResourceOperations => operations

describe('RFC-470 —— 退役的文件不在、零引用', () => {
  test('五个文件不在', () => {
    for (const path of RETIRED)
      expect([path, existsSync(join(SRC, `${path}.ts`))]).toEqual([path, false])
  })

  test('src、用例与脚本零 import 它们', () => {
    expect(importsOf(walk(SRC))).toEqual([])
    expect(importsOf(walk(TESTS))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'scripts')))).toEqual([])
  }, 60_000)

  test('负对照：判据认得出别名、相对路径、空 import {} 与动态 import，不误伤同前缀与注释', () => {
    const probe = join(SRC, 'services', 'probe.ts')
    expect(targetOf(probe, './workflow')).toBe('services/workflow')
    expect(targetOf(probe, './workflow.validator')).toBe('services/workflow.validator')
    expect(targetOf(probe, '../modules/task-execution/composition/agentLaunchResources')).toBe(
      'modules/task-execution/composition/agentLaunchResources',
    )
    for (const kept of [
      './workflow.yaml',
      '../modules/resource-catalog/infrastructure/legacy/workflow',
      '../modules/resource-catalog/composition/agentLaunchResources',
    ])
      expect([kept, RETIRED.includes(targetOf(probe, kept) ?? '')]).toEqual([kept, false])
    expect(
      specifiersIn(
        "import {} from '@/services/taskLaunchGate'\n" +
          "const w = await import('./workflow')\n" +
          "// import '@/services/workflow.validator'\n",
      ).sort(),
    ).toEqual(['./workflow', '@/services/taskLaunchGate'])
  })
})

describe('RFC-470 —— 启动资源适配器归 resource-catalog', () => {
  test('编译期锁：resource-catalog 的实现与 task-execution 的端口逐项相同', () => {
    expect([
      sameOperations,
      sameIssue,
      sameCandidate,
      sameAclRow,
      sameAgentQuery,
      sameValidation,
    ]).toEqual([true, true, true, true, true, true])
    expect(typeof handOver).toBe('function')
  })

  test('resource-catalog 的实现不取 task-execution，端口补了 readWorkflow / frozenClosureJson / code', () => {
    for (const path of [
      'modules/resource-catalog/infrastructure/agentLaunchResourceOperations.ts',
      'modules/resource-catalog/infrastructure/workflowSnapshotLaunchGate.ts',
      'modules/resource-catalog/composition/agentLaunchResources.ts',
    ])
      expect([path, specifiersIn(read(path)).filter((s) => s.includes('task-execution'))]).toEqual([
        path,
        [],
      ])
    const implementation = read(
      'modules/resource-catalog/infrastructure/agentLaunchResourceOperations.ts',
    )
    expect(implementation).toContain("import { getWorkflow } from './legacy/workflow'")
    expect(implementation).toContain(
      'readWorkflow: (workflowId: string) => getWorkflow(db, workflowId),',
    )
    const port = read('modules/task-execution/application/ports/agentLaunchResourceOperations.ts')
    expect(port).toContain('  readWorkflow(workflowId: string): Promise<WorkflowDetail | null>\n')
    expect(port).toContain('  readonly frozenClosureJson?: string | null\n')
    expect(port).toContain('  readonly code: string\n')
  })

  test('装配根取 resource-catalog 的 composition', () => {
    for (const path of [
      'bootstrap/daemonModules/taskExecution.ts',
      'bootstrap/daemonModules/scheduledTasks.ts',
    ])
      expect([path, specifiersIn(read(path)).includes(RC_COMPOSITION)]).toEqual([path, true])
  })
})

describe('RFC-470 —— 同步预览与同步门经端口读、经注入的校验判', () => {
  test('taskRouteOperations 不再取 getWorkflow，两处经 dependencies.readWorkflow 读行', () => {
    const routes = read('modules/task-execution/infrastructure/taskRouteOperations.ts')
    expect(routes).not.toMatch(/\bgetWorkflow\(/)
    expect(routes.split('await dependencies.readWorkflow(task.workflowId)').length - 1).toBe(2)
    expect(routes).toMatch(
      /computeWorkflowSyncPreview\(\s*dependencies\.db,\s*task,\s*workflow,\s*dependencies\.resourceAuthorityFor\(actor\),\s*dependencies\.validateHostWorkflow,\s*\)/,
    )
    expect(read('modules/task-execution/composition/providerRuntime.ts')).toMatch(
      /readWorkflow: \(workflowId\) =>\s+taskRouteLaunchDependencies\.agent\.resources\.readWorkflow\(workflowId\),/,
    )
  })

  test('services/task.ts 的同步预览经注入的 validateHostWorkflow 校验并透传冻结闭包', () => {
    const task = read('services/task.ts')
    expect(task).not.toMatch(/\b(?:validateWorkflowDef|buildWorkflowValidationContext)\(/)
    expect(task).toContain('  validateHostWorkflow: WorkflowSyncPreviewValidation,\n')
    expect(task).toContain(
      '  const validation = await validateHostWorkflow(newDef, {\n' +
        '    definition: newDef,\n' +
        '    currentWorkflow: { id: workflow.id, name: workflow.name },\n' +
        '    frozenClosureJson: candidateClosureJson,\n' +
        '  })\n',
    )
  })

  test('PLUGIN_DISABLED_SITES 的锚点文件都在', () => {
    for (const site of PLUGIN_DISABLED_SITES)
      expect([site, existsSync(join(SRC, site))]).toEqual([site, true])
    expect(PLUGIN_DISABLED_SITES).toContain(
      'modules/resource-catalog/infrastructure/legacy/workflow.validator.ts',
    )
  })
})

const EMPTY_DEFINITION: WorkflowDefinition = {
  $schema_version: 5,
  inputs: [],
  nodes: [],
  edges: [],
} as unknown as WorkflowDefinition

describeEachProvider('RFC-470 —— resource-catalog 的启动资源与快照校验门', (harness) => {
  test('readWorkflow 读到行；不存在回 null', async () => {
    const created = await createWorkflow(harness.db, {
      name: 'rfc470-read-workflow',
      description: '',
      definition: EMPTY_DEFINITION,
    })
    const operations = composeAgentLaunchResourceOperations({ db: harness.db })
    const row = await operations.readWorkflow(created.id)
    expect(row?.id).toBe(created.id)
    expect(row?.name).toBe('rfc470-read-workflow')
    expect(row?.version).toBe(created.version)
    expect(await operations.readWorkflow('missing-workflow-id')).toBeNull()
  })

  test('快照校验门：非法快照抛 workflow-invalid（带 issues），合法的不抛', async () => {
    await expect(
      assertWorkflowSnapshotLaunchable(harness.db, {
        id: 'wf-rfc470-valid',
        name: 'rfc470-valid',
        version: 1,
        definition: EMPTY_DEFINITION,
      }),
    ).resolves.toBeUndefined()
    const invalid = {
      ...EMPTY_DEFINITION,
      nodes: ['one', 'two'].map((id) => ({
        id,
        kind: 'agent-single',
        agentId: `missing-${id}`,
        agentName: `missing-${id}`,
        promptTemplate: 'work',
      })),
    } as unknown as WorkflowDefinition
    const error = await assertWorkflowSnapshotLaunchable(harness.db, {
      id: 'wf-rfc470-invalid',
      name: 'rfc470-invalid',
      version: 1,
      definition: invalid,
    }).then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('workflow-invalid')
    expect((error as DomainError).message).toContain(
      "workflow 'wf-rfc470-invalid' failed static validation",
    )
    const issues = ((error as DomainError).details as { issues: readonly { severity?: string }[] })
      .issues
    expect(
      issues.filter((issue) => (issue.severity ?? 'error') === 'error').length,
    ).toBeGreaterThanOrEqual(2)
  })
})
