// RFC-477 — 节点回滚、资源限额、agent 启动快照与触发预检按 owner 归位（RFC-294 W9-D 第二十四步）。
//
// 锁五件事：
// ① 五个 `services/` 文件（`nodeRollback`、`limits`、`agentLaunch`、`execution/triggerPreflight`、`execution/resourcePolicy`）不在：
//    backend 的 src / 用例 / 脚本零 import（`preProcessFile` 取全部模块引用，带负对照）；各包、e2e 与仓根脚本里没有指着它们的路径字面量
//    （注释不算，带负对照）；workflow 与 `design/`、`docs/` 的 Markdown 相对链接也不指着它们（带负对照）。
// ② census 的 `R1` 里没有它们（带负对照）。
// ③ 方向：collaboration 不取 task-execution 的回滚内部，只经自有端口 `NodeRunWorkspaceRollbackPort`（bootstrap 交 task-execution 的
//    实现，带负对照）；task-execution 的限额策略与审计端口不取 system-operations（值与类型都不取，带负对照）。
// ④ 落位与 public：定义处按内容分层（domain / application / infrastructure）；新增的 public 符号与定义处是同一个值；迁移后失去模块外
//    消费方的 public 符号已撤出。
// ⑤ 回滚作用域的行为：任务不在时为 null；`plan` 与 `rollback` 落到同一个目标（与直接调规划 / 回滚相同的结果）；作用域装载的是
//    带 `db` 的目标（源码锁，带负对照：`db` 是可选字段，丢了 `tsc` 不报，在任务执行上下文里的回滚就不再写 RFC-328 effect）。
// 行为由既有用例覆盖（都改走新位置）：回滚（`rfc092`、`rfc098`、`git-snapshot`、`single-nonroot-member-workspace`、`scheduler-audit-s02`
// / `s13`）、限额（`rfc349-resource-limit-provider`、`rfc359-w7-resource-limit-conformance`、`rfc243-parent-child-lifecycle`）、启动快照
// （`rfc165`、`rfc218`、`rfc199`、`builtin-workflow-auto-layout`、`rfc365`）、触发预检（`rfc167`、`rfc223-pr3b`、`rfc408`、`rfc292`）与停用资源
// （`rfc282-a3`、`rfc284`、`rfc317-registry-reverse-completeness`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, inboundBoundaryEdges, sourceUnit } from './architecture/census'
import { BACKEND_PREFIX } from './architecture/rfc294Gates'
import { describeEachProvider } from './helpers/eachProvider'
import { seedTask } from './helpers/questionDispatchFixture'
import {
  createNodeRunWorkspaceRollback,
  loadRollbackTarget,
  planNodeRunRollbackTargets,
  rollbackNodeRunWorktrees,
} from '@/modules/task-execution/infrastructure/nodeRollback'
import { createNodeRunWorkspaceRollback as composedRollback } from '@/modules/task-execution/composition'
import { validateAgentLaunchShape } from '@/modules/task-execution/domain/agentHostWorkflow'
import {
  assertTriggerPreflight,
  triggerPreflightIssue,
  triggerSourceFromContext,
} from '@/modules/resource-catalog/domain/triggerPreflight'
import {
  DISABLED_RESOURCE_POLICY,
  notModeledDisabledKinds,
} from '@/modules/resource-catalog/domain/disabledResourcePolicy'
import * as taskExecutionQueries from '@/modules/task-execution/public/queries'
import * as taskExecutionTypes from '@/modules/task-execution/public/types'
import * as resourceCatalogQueries from '@/modules/resource-catalog/public/queries'
import * as resourceCatalogTypes from '@/modules/resource-catalog/public/types'
import * as systemOperations from '@/modules/system-operations/public/operations'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RETIRED = [
  'services/nodeRollback',
  'services/limits',
  'services/agentLaunch',
  'services/execution/triggerPreflight',
  'services/execution/resourcePolicy',
] as const
const TE = 'modules/task-execution/'
const RC = 'modules/resource-catalog/'
const CO = 'modules/collaboration/'
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

const RETIRED_PATH =
  /(?:^|[/'"@])services\/(?:nodeRollback|limits|agentLaunch|execution\/triggerPreflight|execution\/resourcePolicy)(?:\.ts)?$/
const MENTIONS = /nodeRollback|services\/limits|agentLaunch|triggerPreflight|resourcePolicy/

/** String literals (not comments) that name a retired file by path — the shape `readFileSync(<path>)` locks use. */
function retiredPathLiterals(path: string, text: string): string[] {
  if (!MENTIONS.test(text)) return []
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
  if (!MENTIONS.test(text)) return []
  const targets = RETIRED.map((stem) => `packages/backend/src/${stem}.ts`)
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1]!)
    .filter((link) => !/^[a-z]+:/i.test(link))
    .filter((link) =>
      targets.includes(slash(relative(REPO_ROOT, resolve(path, '..', link.split('#')[0]!)))),
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

/** Module specifiers of a file that leave the module through anything but another context's exact `public/` entry. */
function crossContextInternals(text: string, ownContext: string): string[] {
  return specifiersIn(text).filter((specifier) => {
    const match = /^@\/modules\/([a-z-]+)\/(.+)$/.exec(specifier)
    if (match === null || match[1] === ownContext) return false
    return !/^public\/(?:commands|queries|participants|events|operations|types)$/.test(match[2]!)
  })
}

/** Guards whose negative fixtures spell a retired path on purpose (they test their own matchers, not these files). */
const FIXTURE_USERS = new Set([
  // RFC-473's markdown-link and import-matcher fixtures use the trigger preflight path as a "sibling, not retired" control.
  'packages/backend/tests/rfc473-execution-outcome-and-resource-sessions.test.ts',
  // RFC-405 / RFC-410 negative fixtures: an engine / contract file importing a legacy `services/` path is a violation.
  'packages/backend/tests/architecture/rfc405-agent-single-executor.test.ts',
  'packages/backend/tests/architecture/rfc410-dynamic-workflow-engine.test.ts',
])

describe('RFC-477 —— 五个 services/ 文件不在、零引用', () => {
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
      .filter(
        (path) => path !== import.meta.path && !FIXTURE_USERS.has(slash(relative(REPO_ROOT, path))),
      )
      .flatMap((path) => retiredPathLiterals(path, readFileSync(path, 'utf8')))
    expect(hits).toEqual([])
    const workflows = walk(join(REPO_ROOT, '.github', 'workflows'), /\.ya?ml$/).filter((path) =>
      /packages\/backend\/src\/services\/(?:nodeRollback|limits|agentLaunch|execution\/triggerPreflight|execution\/resourcePolicy)\.ts/.test(
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
    // Negative control: relative links to retired files are found; a sibling and a code span are not.
    expect(
      retiredMarkdownLinks(
        join(REPO_ROOT, 'design', 'RFC-000-probe', 'evidence.md'),
        [
          '[rollback](../../packages/backend/src/services/nodeRollback.ts#L101)',
          '[policy](../../packages/backend/src/services/execution/resourcePolicy.ts)',
          '[task](../../packages/backend/src/services/task.ts)',
          '`packages/backend/src/services/limits.ts`',
        ].join('\n'),
      ),
    ).toEqual([
      'design/RFC-000-probe/evidence.md -> ../../packages/backend/src/services/nodeRollback.ts#L101',
      'design/RFC-000-probe/evidence.md -> ../../packages/backend/src/services/execution/resourcePolicy.ts',
    ])
  })

  test('负对照：判据认得出别名、相对路径、空 import {}、类型转出与动态 import，也认得出路径字面量；不误伤注释与同前缀', () => {
    expect(targetOf(join(SRC, 'services', 'probe.ts'), './limits')).toBe('services/limits')
    expect(targetOf(join(TESTS, 'probe.test.ts'), '../src/services/agentLaunch')).toBe(
      'services/agentLaunch',
    )
    const fixture = [
      "import {} from '@/services/nodeRollback'",
      "export type { X } from '../services/execution/resourcePolicy'",
      "const lazy = import('@/services/execution/triggerPreflight')",
      '// @/services/limits (a comment)',
      "import { y } from '@/services/agentLaunchReservation'",
      "import { z } from '@/modules/task-execution/infrastructure/nodeRollback'",
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
          "read('packages/backend/src/services/nodeRollback.ts')",
          "spec('@/services/execution/triggerPreflight')",
          "read('src/services/limitsStore.ts')",
          "read('src/modules/task-execution/infrastructure/nodeRollback.ts')",
          '// packages/backend/src/services/agentLaunch.ts',
        ].join('\n'),
      ),
    ).toEqual([
      'probe.ts: packages/backend/src/services/nodeRollback.ts',
      'probe.ts: @/services/execution/triggerPreflight',
    ])
  })
})

describe('RFC-477 —— R1 销账与方向', () => {
  test('census 的 R1 里没有它们的边', () => {
    const offending = inboundBoundaryEdges(backendUnits(REPO_ROOT))
      .filter((edge) => RETIRED.some((stem) => edge.from === `${BACKEND_PREFIX}${stem}.ts`))
      .map((edge) => `${edge.from} -> ${edge.to} (${edge.edgeKind})`)
    expect(offending).toEqual([])
  }, 120_000)

  test('负对照：同一规则把 services/ 文件取模块的 infrastructure / application/ports 判为 R1，取 public 不判', () => {
    const probe = (text: string) =>
      inboundBoundaryEdges([sourceUnit(BACKEND_PREFIX + 'services/probe.ts', text)]).map(
        (edge) => edge.to,
      )
    expect(
      probe(
        [
          "import { loadNodeRollbackTarget } from '@/modules/task-execution/infrastructure/nodeRollbackPersistence'",
          "import type { TaskRollbackQueries } from '@/modules/task-execution/application/ports/taskRollbackQueries'",
          "import { hasTaskRollbackCheckpoint } from '@/modules/task-execution/public/queries'",
        ].join('\n'),
      ),
    ).toEqual([
      'modules/task-execution/application/ports/taskRollbackQueries',
      'modules/task-execution/infrastructure/nodeRollbackPersistence',
    ])
  })

  test('collaboration 只经自有端口取回滚，不取 task-execution 的回滚内部；bootstrap 交 task-execution 的实现', () => {
    for (const path of [
      CO + 'infrastructure/review.ts',
      CO + 'infrastructure/clarify/autoDispatch.ts',
      CO + 'infrastructure/taskExecutionParticipantBindings.ts',
      CO + 'application/ports/nodeRunWorkspaceRollback.ts',
    ]) {
      expect([path, crossContextInternals(read(path), 'collaboration')]).toEqual([path, []])
      expect([
        path,
        specifiersIn(read(path)).filter((specifier) => specifier.includes('nodeRollback')),
      ]).toEqual([path, []])
    }
    // Positive control: both callers go through the bindings' factory, and the bindings type it with the own port.
    for (const path of [
      CO + 'infrastructure/review.ts',
      CO + 'infrastructure/clarify/autoDispatch.ts',
    ])
      expect([path, read(path).includes('.createNodeRunWorkspaceRollback(db)')]).toEqual([
        path,
        true,
      ])
    expect(read(CO + 'infrastructure/taskExecutionParticipantBindings.ts')).toContain(
      'readonly createNodeRunWorkspaceRollback: (db: PersistenceDb) => NodeRunWorkspaceRollbackPort',
    )
    // Negative control: a deep import of the rollback implementation is reported.
    expect(
      crossContextInternals(
        "import { rollbackNodeRunWorktrees } from '@/modules/task-execution/infrastructure/nodeRollback'",
        'collaboration',
      ),
    ).toEqual(['@/modules/task-execution/infrastructure/nodeRollback'])
    const root = read('bootstrap/crossContextClosure.ts')
    expect(root).toMatch(
      /import \{[^}]*\bcreateNodeRunWorkspaceRollback\b[^}]*\} from '@\/modules\/task-execution\/composition'/,
    )
    expect(root).toContain('    createNodeRunWorkspaceRollback,\n')
    expect(composedRollback).toBe(createNodeRunWorkspaceRollback)
  })

  test('回滚作用域装载带 db 的目标，规划与回滚都对着它（在任务执行上下文里回滚照旧写 RFC-328 effect）', () => {
    // The effect journal only runs when the target carries `db` (and an execution context is current), so a scope that
    // planned / rolled back against a db-less target would silently stop journaling; `RollbackTarget.db` is optional,
    // so `tsc` would not notice. The loader itself is pinned to return the db-bearing target in the provider suite below.
    const text = read(TE + 'infrastructure/nodeRollback.ts')
    const start = text.indexOf('export function createNodeRunWorkspaceRollback(')
    expect(start).toBeGreaterThan(0)
    const body = text.slice(start, text.indexOf('\n}\n', start))
    expect(body).toContain('const target = await loadRollbackTarget(db, taskId)')
    expect(body).toContain(
      'plan: (run: RollbackRunRow) => planNodeRunRollbackTargets(target, run),',
    )
    expect(body).toContain('rollbackNodeRunWorktrees(target, run, {}, log),')
    // Negative control: the provider-neutral loader builds a target without `db` (no journal); the scope must not use it.
    expect(text).toContain('export async function loadRollbackTargetFrom(')
    expect(body).not.toContain('loadRollbackTargetFrom(')
  })

  test('task-execution 的限额策略与审计端口不取 system-operations（值与类型都不取）', () => {
    for (const path of [
      TE + 'application/resourceLimitEnforcement.ts',
      TE + 'application/ports/taskResourceLimitAudit.ts',
    ])
      expect([
        path,
        specifiersIn(read(path)).filter((s) => s.startsWith('@/modules/system-operations')),
      ]).toEqual([path, []])
    // Positive control: the policy's persistence is task-execution's facts plus its own audit port.
    expect(read(TE + 'application/resourceLimitEnforcement.ts')).toContain(
      'readonly persistence: TaskResourceLimitFacts & TaskResourceLimitAudit',
    )
    // Negative control: the same reader sees a type-only import of the system-operations audit.
    expect(
      specifiersIn(
        "import type { ResourceLimitAudit } from '@/modules/system-operations/public/operations'",
      ).filter((s) => s.startsWith('@/modules/system-operations')),
    ).toEqual(['@/modules/system-operations/public/operations'])
    // Bootstrap still spreads system-operations' audit into the policy's persistence.
    expect(read('bootstrap/resourceLimits.ts')).toContain('...createResourceLimitAudit(input.db),')
  })
})

describe('RFC-477 —— 落位与 public 收口', () => {
  test('定义处按内容分层', () => {
    const expectations: ReadonlyArray<readonly [string, readonly string[]]> = [
      [TE + 'domain/nodeRunRollbackOutcome.ts', ['RollbackOutcome', 'snapshotMissingDetail']],
      [
        TE + 'infrastructure/nodeRollback.ts',
        [
          'NodeRunRollbackLog',
          'PlannedNodeRunRollbackTarget',
          'RollbackRunRow',
          'RollbackTarget',
          'createNodeRunWorkspaceRollback',
          'loadRollbackTarget',
          'loadRollbackTargetFrom',
          'planNodeRunRollbackTargets',
          'rollbackNodeRunWorktrees',
        ],
      ],
      [
        TE + 'application/resourceLimitEnforcement.ts',
        ['EnforceLimitsResult', 'ResourceLimitOperations', 'enforceLimits'],
      ],
      [
        TE + 'application/ports/taskResourceLimitAudit.ts',
        ['TaskResourceLimitAudit', 'TaskResourceLimitCancellationAudit'],
      ],
      [
        TE + 'domain/agentHostWorkflow.ts',
        [
          'AGENT_HOST_AGENT_NODE_ID',
          'AGENT_HOST_CLARIFY_NODE_ID',
          'AGENT_HOST_INPUT_KEY',
          'AGENT_HOST_INPUT_NODE_ID',
          'buildAgentHostSnapshot',
          'validateAgentLaunchShape',
        ],
      ],
      [
        RC + 'domain/triggerPreflight.ts',
        [
          'assertTriggerPreflight',
          'collectLaunchTriggerDefinitions',
          'triggerPreflightIssue',
          'triggerSourceFromContext',
        ],
      ],
      [
        RC + 'domain/disabledResourcePolicy.ts',
        [
          'DISABLED_RESOURCE_POLICY',
          'DisableableResourceKind',
          'DisabledDisposition',
          'DisabledPolicyEntry',
          'PLUGIN_DISABLED_ERROR_CODE',
          'PLUGIN_DISABLED_SITES',
          'notModeledDisabledKinds',
        ],
      ],
      [
        CO + 'application/ports/nodeRunWorkspaceRollback.ts',
        [
          'NodeRunWorkspaceRollbackLog',
          'NodeRunWorkspaceRollbackOutcome',
          'NodeRunWorkspaceRollbackPort',
          'NodeRunWorkspaceRollbackScope',
        ],
      ],
    ]
    for (const [path, names] of expectations)
      expect([path, exportedNames(path, read(path))]).toEqual([path, [...names].sort()])
    // The domain files stay pure: no filesystem, process or persistence imports.
    for (const path of [
      TE + 'domain/nodeRunRollbackOutcome.ts',
      TE + 'domain/agentHostWorkflow.ts',
      RC + 'domain/triggerPreflight.ts',
      RC + 'domain/disabledResourcePolicy.ts',
    ])
      expect([
        path,
        specifiersIn(read(path)).filter(
          (s) => s.startsWith('node:') || s.startsWith('@/db') || s === 'drizzle-orm',
        ),
      ]).toEqual([path, []])
  })

  test('新增的 public 符号与定义处是同一个值', () => {
    expect(taskExecutionQueries.validateAgentLaunchShape).toBe(validateAgentLaunchShape)
    expect(resourceCatalogQueries.assertTriggerPreflight).toBe(assertTriggerPreflight)
    expect(resourceCatalogQueries.triggerPreflightIssue).toBe(triggerPreflightIssue)
    expect(resourceCatalogQueries.triggerSourceFromContext).toBe(triggerSourceFromContext)
    expect(resourceCatalogTypes.DISABLED_RESOURCE_POLICY).toBe(DISABLED_RESOURCE_POLICY)
    expect(resourceCatalogTypes.notModeledDisabledKinds).toBe(notModeledDisabledKinds)
  })

  test('迁移后失去模块外消费方的 public 符号已撤出', () => {
    const withdrawn: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
      [TE + 'public/queries.ts', taskExecutionQueries, 'taskRollbackPlan'],
      [TE + 'public/queries.ts', taskExecutionQueries, 'callRowHumanWait'],
      [TE + 'public/queries.ts', taskExecutionQueries, 'readTaskResourceUsage'],
      [TE + 'public/queries.ts', taskExecutionQueries, 'parseCallHumanWait'],
      [TE + 'public/types.ts', taskExecutionTypes, 'TaskResourceLimitFacts'],
      ['modules/system-operations/public/operations.ts', systemOperations, 'ResourceLimitAudit'],
      // The trigger preflight was the last outside reader of the call-closure codec; the plugin-disabled code's last
      // outside reader was the injected policy bundle (resource-catalog's snapshot adapter now reads its own).
      [RC + 'public/queries.ts', resourceCatalogQueries, 'parseCallClosure'],
      [RC + 'public/types.ts', resourceCatalogTypes, 'FrozenCallClosure'],
      [RC + 'public/types.ts', resourceCatalogTypes, 'PLUGIN_DISABLED_ERROR_CODE'],
    ]
    for (const [path, namespace, name] of withdrawn) {
      expect([path, name, exportedNames(path, read(path)).includes(name)]).toEqual([
        path,
        name,
        false,
      ])
      expect([name, name in namespace]).toEqual([name, false])
    }
    // Positive control: the export reader sees what the entries still offer.
    expect(exportedNames(TE + 'public/queries.ts', read(TE + 'public/queries.ts'))).toContain(
      'hasTaskRollbackCheckpoint',
    )
    expect(exportedNames(TE + 'public/types.ts', read(TE + 'public/types.ts'))).toContain(
      'TaskRollbackCheckpointRun',
    )
  })
})

describeEachProvider('RFC-477 —— 回滚作用域', (harness) => {
  const run = { id: 'rfc477-run', checkpoints: [] } as const
  const warnings: string[] = []
  const log = { warn: (msg: string) => void warnings.push(msg) }

  test('任务不在时为 null', async () => {
    expect(await createNodeRunWorkspaceRollback(harness.db).load('rfc477-missing-task')).toBeNull()
  })

  test('plan 与 rollback 落到同一个目标：与直接规划 / 回滚的结果相同', async () => {
    const taskId = `rfc477-task-${process.pid}`
    await seedTask(harness.db, taskId)
    const scope = await createNodeRunWorkspaceRollback(harness.db).load(taskId)
    expect(scope).not.toBeNull()
    const target = (await loadRollbackTarget(harness.db, taskId))!
    // The loader the scope uses (source lock above) returns the db-bearing target the RFC-328 effect journal needs.
    expect(target.taskId).toBe(taskId)
    expect(target.db).toBe(harness.db)
    expect(scope!.plan(run)).toEqual(planNodeRunRollbackTargets(target, run))
    warnings.length = 0
    const viaScope = await scope!.rollback(run, log)
    const direct = await rollbackNodeRunWorktrees(target, run, {}, log)
    // No recorded checkpoint: both are the same no-op outcome, and neither warns.
    expect(viaScope).toEqual(direct)
    expect(viaScope).toEqual({ attempted: false, failures: [] })
    expect(warnings).toEqual([])
  })
})
