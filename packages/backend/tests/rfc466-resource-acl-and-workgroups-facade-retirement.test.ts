// RFC-466 — 退役 resourceAcl 与 workgroups 兼容 facade（RFC-294 W9-D 第十三步）。
//
// 锁五件事：
// ① `services/resourceAcl.ts`、`services/workgroups.ts` 不在，src / 用例 / 脚本零 import 它们（census AST，别名与相对路径都认，带负对照）。
// ② 六个原消费方改取 owner 的合同：collaboration 评审写路径用自己的 `CollaborationTaskRolePolicy`；integration 取 resource-catalog
//    `public/queries`、knowledge-evolution 取 `public/types`；task-execution 的工作流同步两处用 `AgentLaunchResourceOperations.canViewWorkflow`
//    （实现处转交 resource-catalog 的可见性判定）；`services/taskLaunchGate.ts` 只留生产在用的快照校验。
// ③ resource-catalog `public/queries` 导出的 `isVisibleToAudienceSnapshot` 就是 domain 里那一个（同一个函数对象）；它的入参带受众
//    authority 投影，不经 `public/types` 转出（RFC-294 W0-R：authority 类型不得穿过 public/types）。
// ④ 只剩用例在用的两段代码在用例树里：调用闭包预言与完整启动门不在 src、在 `tests/helpers/`。
// ⑤ facade 退役后失去模块外消费方的两个 public 符号收回（RFC-294 design §3.3）：intent 的 `canAuditIntentSessions` 落 intent
//    `domain/sessionAudit.ts`（resource-catalog 里那份无人引用的同名副本删除），intent `public/operations.ts` 随之删除（其余四个类型
//    转出本来就没有消费方）；`callEdgeKey` 退出 resource-catalog `public/queries`。
import { describe, expect, test } from 'bun:test'
import type { Permission } from '@agent-workflow/shared'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import * as publicQueries from '@/modules/resource-catalog/public/queries'
import * as publicTypes from '@/modules/resource-catalog/public/types'
import * as resourceAccess from '@/modules/resource-catalog/domain/resourceAccess'
import { canAuditIntentSessions } from '@/modules/intent/domain/sessionAudit'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RETIRED = ['services/resourceAcl', 'services/workgroups'] as const
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

/** Resolve an import specifier to a `src/`-relative path stem (alias and relative forms), or null. */
function targetOf(from: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return specifier.slice(2)
  if (!specifier.startsWith('.')) return null
  const absolute = resolve(from, '..', specifier)
  const rel = slash(relative(SRC, absolute))
  return rel.startsWith('..') ? null : rel.replace(/\.[cm]?tsx?$/, '')
}

const importsOf = (files: readonly string[], targets: readonly string[]) =>
  files.flatMap((path) => {
    const unit = sourceUnit(slash(relative(REPO_ROOT, path)), readFileSync(path, 'utf8'))
    return importEdges(unit)
      .map((edge) => targetOf(path, edge.specifier))
      .filter((target): target is string => target !== null)
      .filter((target) => targets.includes(target))
      .map((target) => `${slash(relative(REPO_ROOT, path))} -> ${target}`)
  })
const importsOfRetired = (files: readonly string[]) => importsOf(files, RETIRED)

describe('RFC-466 —— 两个兼容 facade 退役', () => {
  test('两个 facade 文件不在', () => {
    for (const facade of RETIRED)
      expect([facade, existsSync(join(SRC, `${facade}.ts`))]).toEqual([facade, false])
  })

  test('src、用例与脚本零 import 它们', () => {
    expect(importsOfRetired(walk(SRC))).toEqual([])
    expect(importsOfRetired(walk(TESTS))).toEqual([])
    expect(importsOfRetired(walk(resolve(REPO_ROOT, 'scripts')))).toEqual([])
  }, 60_000)

  test('负对照：判据认得出别名与相对路径', () => {
    const probe = join(SRC, 'modules', 'collaboration', 'infrastructure', 'probe.ts')
    expect(targetOf(probe, '@/services/resourceAcl')).toBe('services/resourceAcl')
    expect(targetOf(probe, '../../../services/workgroups')).toBe('services/workgroups')
    expect(targetOf(probe, '../../../services/workgroupsExtra')).toBe('services/workgroupsExtra')
    const unit = sourceUnit(
      'packages/backend/src/modules/collaboration/infrastructure/probe.ts',
      "import { resolveTaskRole } from '@/services/resourceAcl'\n",
    )
    expect(importEdges(unit).map((edge) => edge.specifier)).toEqual(['@/services/resourceAcl'])
  })
})

describe('RFC-466 —— 原消费方改取 owner 的合同', () => {
  test('collaboration 评审写路径用自己的任务角色端口', () => {
    const review = read('modules/collaboration/infrastructure/review.ts')
    expect(review).toContain(
      'const role = taskRolePolicy.resolveTaskRole(actor, ownerUserId, isMember)',
    )
    expect(review).toContain('  const role = assertActingMember(\n    args.taskRolePolicy,\n')
    expect(review).not.toMatch(/import \{[^}]*\bresolveTaskRole\b[^}]*\} from/)
  })

  test('integration 取 resource-catalog public/queries、knowledge-evolution 取 public/types', () => {
    expect(read('modules/integration/composition/digitalEmployeeToolConnections.ts')).toContain(
      "import { isVisibleToAudienceSnapshot } from '@/modules/resource-catalog/public/queries'",
    )
    expect(read('modules/knowledge-evolution/inbound/fusionRoutes.ts')).toContain(
      "import { hasResourceAclBypass } from '@/modules/resource-catalog/public/types'",
    )
  })

  test('public 面导出的两个判定就是 domain 里那一个；受众可见性判定不经 public/types', () => {
    expect(publicQueries.isVisibleToAudienceSnapshot).toBe(
      resourceAccess.isVisibleToAudienceSnapshot,
    )
    expect(publicTypes.hasResourceAclBypass).toBe(resourceAccess.hasResourceAclBypass)
    expect(Object.keys(publicTypes)).not.toContain('isVisibleToAudienceSnapshot')
  })

  test('工作流同步两处经 AgentLaunchResourceOperations.canViewWorkflow，实现转交 resource-catalog 的可见性判定', () => {
    const routes = read('modules/task-execution/infrastructure/taskRouteOperations.ts')
    expect(routes.split('await dependencies.canViewWorkflow(actor, workflow)').length - 1).toBe(2)
    expect(routes).not.toMatch(/\bcanViewResource\(/)
    expect(
      read('modules/task-execution/application/ports/agentLaunchResourceOperations.ts'),
    ).toContain(
      '  canViewWorkflow(actor: Actor, workflow: AgentLaunchWorkflowAclRow): Promise<boolean>\n',
    )
    expect(
      read('modules/task-execution/infrastructure/agentLaunchResourceOperations.ts'),
    ).toContain(") => canViewResource(db, actor, 'workflow', workflow),")
    expect(read('modules/task-execution/composition/providerRuntime.ts')).toContain(
      'taskRouteLaunchDependencies.agent.resources.canViewWorkflow(actor, workflow)',
    )
  })

  test('services/taskLaunchGate 只留生产在用的快照校验', () => {
    const gate = read('services/taskLaunchGate.ts')
    expect(gate).toContain('export async function assertWorkflowSnapshotLaunchable(')
    expect(gate).not.toContain('export async function assertWorkflowLaunchable(')
    expect(gate).not.toMatch(/\bcanViewResource\b/)
  })
})

describe('RFC-466 —— 只剩用例在用的代码在用例树里', () => {
  test('调用闭包预言与完整启动门不在 src、在 tests/helpers/', () => {
    expect(
      existsSync(join(SRC, 'modules/task-execution/infrastructure/legacyCallClosure.ts')),
    ).toBe(false)
    const oracle = readFileSync(join(TESTS, 'helpers/legacyCallClosure.ts'), 'utf8')
    expect(oracle).toContain('export async function freezeCallClosure(')
    const gate = readFileSync(join(TESTS, 'helpers/workflowLaunchGate.ts'), 'utf8')
    expect(gate).toContain('export async function assertWorkflowLaunchable(')
    const productionDefiners = walk(SRC).filter((path) =>
      /export async function (?:freezeCallClosure|assertWorkflowLaunchable)\(/.test(
        readFileSync(path, 'utf8'),
      ),
    )
    expect(productionDefiners.map((path) => slash(relative(SRC, path)))).toEqual([])
  }, 30_000)
})

describe('RFC-466 —— 失去模块外消费方的两个 public 符号收回', () => {
  test('intent 的审计判定落在 domain、public/operations.ts 删除且零 import；intent 自己的两个调用方取 domain', () => {
    expect(existsSync(join(SRC, 'modules/intent/public/operations.ts'))).toBe(false)
    expect(importsOf([...walk(SRC), ...walk(TESTS)], ['modules/intent/public/operations'])).toEqual(
      [],
    )
    expect(canAuditIntentSessions({ permissions: new Set<Permission>(['intent:audit']) })).toBe(
      true,
    )
    expect(canAuditIntentSessions({ permissions: new Set<Permission>() })).toBe(false)
    for (const file of [
      'modules/intent/application/session.ts',
      'modules/intent/inbound/intentSessionRoutes.ts',
    ])
      expect([file, read(file)]).toEqual([
        file,
        expect.stringContaining(
          "import { canAuditIntentSessions } from '@/modules/intent/domain/sessionAudit'",
        ),
      ])
    expect(read('modules/resource-catalog/application/resourceDefaults.ts')).not.toContain(
      'canAuditIntentSessions',
    )
  }, 60_000)

  test('callEdgeKey 退出 resource-catalog public/queries（同一个 codec 的其余出口照旧）', () => {
    expect(Object.keys(publicQueries)).not.toContain('callEdgeKey')
    expect(Object.keys(publicQueries)).toContain('parseCallClosure')
  })
})
