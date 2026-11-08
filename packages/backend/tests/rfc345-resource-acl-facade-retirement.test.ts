// RFC-395 II-pre：守卫改锁生产路径或删除后的精确存量，保留原扫描判据。
// RFC-345 T9 — compatibility facades are temporary, source-backed edges.
//
// This gate derives the live consumer ledger from the TypeScript AST instead
// of maintaining a stale copy of every import. The closed facade -> successor
// map is reviewed: a new facade cannot appear without an exact owner, while
// every new consumer is automatically enrolled with its imported symbols.

import { expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

interface RemoveOwner {
  readonly wave: string
  readonly path: string
  readonly exportName: string
}

interface ObservedCompatibilityDebt {
  readonly facade: string
  readonly consumer: string
  readonly importedSymbols: readonly string[]
  readonly useCase: string
  readonly removeOwners: readonly RemoveOwner[]
}

interface FacadeDefinition {
  readonly facade: string
  readonly compatibilityMarker: boolean
}

const facade = (path: string, compatibilityMarker = true): FacadeDefinition => ({
  facade: path,
  compatibilityMarker,
})

/** Reviewed facade inventory. Paths are explicit; no directory/stem rule can self-enrol debt. */
const FACADE_DEFINITIONS: readonly FacadeDefinition[] = [
  facade('services/agent.ts'),
  facade('services/importRefs.ts'),
  facade('services/mcp.ts', false),
  facade('services/mcpRuntimeTestTransitions.ts'),
  facade('services/plugin.ts'),
  facade('services/resourceAcl.ts'),
  facade('services/resourceRefs.ts'),
  facade('services/skill.ts'),
  facade('services/skillBootVerify.ts'),
  facade('services/skillDeleteOp.ts'),
  facade('services/skillFsPublish.ts'),
  facade('services/skillHash.ts'),
  facade('services/skillIdentityPaths.ts'),
  facade('services/skillOpRecovery.ts'),
  facade('services/skillOpRecoveryDriver.ts'),
  facade('services/skillOpRegistry.ts'),
  facade('services/skillOperations.ts'),
  facade('services/skillReferenceGuard.ts'),
  facade('services/skillReserveOp.ts'),
  facade('services/skillToken.ts'),
  facade('services/skillVersionOp.ts'),
  facade('services/workflow.ts'),
  facade('services/workflow.validator.ts'),
  facade('services/workflow.yaml.ts'),
  facade('services/workflowLaunchInputs.ts'),
  facade('services/workgroup/askerKey.ts'),
  facade('services/workgroup/configActions.ts', false),
  facade('services/workgroup/constants.ts'),
  facade('services/workgroup/context.ts'),
  facade('services/workgroup/dwActions.ts', false),
  facade('services/workgroup/hooks.ts'),
  facade('services/workgroup/lifecycle.ts'),
  facade('services/workgroup/memberTurns.ts'),
  facade('services/workgroup/messages.ts'),
  facade('services/workgroup/prompts.ts'),
  facade('services/workgroup/room.ts', false),
  facade('services/workgroup/rounds.ts'),
  facade('services/workgroup/state.ts'),
  facade('services/workgroup/strategies/freeCollab.ts'),
  facade('services/workgroup/strategies/leaderWorker.ts'),
  facade('services/workgroup/systemMessages.ts'),
  facade('services/workgroup/taskActions.ts', false),
  facade('services/workgroup/turnExecution.ts'),
  facade('services/workgroup/wake.ts'),
  facade('services/workgroups.ts'),
  facade('services/agentDeps.ts', false),
  facade('services/agentResourceIntegrity.ts', false),
]

const RETIRED_FACADES = [
  // RFC-395 II-b O: all tests now import the owner implementation directly.
  'services/agent.ts',
  'services/agentResourceIntegrity.ts',
  // RFC-345 T9: the last production consumer (the resource-package parser, which
  // is Resource Catalog's own legacy package layer) now reads the archive codec
  // from the owning module, so the compatibility re-export was deleted.
  'services/skill-zip.ts',
  'services/mcp.ts',
  'services/plugin.ts',
  'services/skill.ts',
  'services/workgroup/hooks.ts',
  'services/workgroup/lifecycle.ts',
  'services/workgroup/configActions.ts',
  'services/workgroup/dwActions.ts',
  'services/workgroup/room.ts',
  'services/workgroup/taskActions.ts',
  // RFC-454: the last one-hop re-exports here were deleted; consumers take the declaration sites
  // (`assertWorkflowLaunchInputs` through resource-catalog `public/queries`, the YAML serializer and the workflow
  // agent refs from shared, the workgroup host ids from shared and the clarify asker key from collaboration's domain).
  'services/resourceRefs.ts',
  'services/workflow.yaml.ts',
  'services/workflowLaunchInputs.ts',
  'services/workgroup/askerKey.ts',
  'services/workgroup/constants.ts',
  // RFC-466: the remaining consumers take resource-catalog's own contracts (collaboration its task-role port,
  // integration / knowledge-evolution `public/types`, task-execution `AgentLaunchResourceOperations.canViewWorkflow`)
  // and the two test-only users (the call-closure oracle and the full launch gate) moved to the test helpers.
  'services/resourceAcl.ts',
  'services/workgroups.ts',
  // RFC-467: the RFC-349 injection behaviour oracle moved to the test helpers with `agentDeps` (its only production
  // consumer); the two skill re-exports it read are deleted and it takes the resource-catalog definitions.
  'services/agentDeps.ts',
  'services/skillBootVerify.ts',
  'services/skillIdentityPaths.ts',
  // RFC-470: the last two thin re-exports. The workflow-sync routes read the workflow row through task-execution's
  // agent-launch resource seam (`AgentLaunchResourceOperations.readWorkflow`, implemented by resource-catalog next to
  // `canViewWorkflow`), the sync preview validates through the same seam's `validateHostWorkflow` (with the
  // candidate's frozen call closure), and the scheduled-task snapshot gate moved into resource-catalog. The successors
  // RFC-345 registered for these edges (`TaskExecutionResourceBinding`, `WorkflowValidationQueries`) were not used: the
  // former loads by launchability where the preview needs visibility, the latter requires a user authority and has no
  // frozen-closure input (RFC-470 proposal §3).
  'services/workflow.ts',
  'services/workflow.validator.ts',
] as const

/**
 * Source-backed, reviewed successor ledger. Every row names the exact consumer,
 * symbols/use-case and an existing non-facade successor contract. There is no
 * stem fallback: a new edge must be reviewed and added explicitly.
 *
 * RFC-470: the ledger is empty — every facade in FACADE_DEFINITIONS is retired. The successor-owner map and the row
 * helper went with the last three rows (git history keeps them); a new compatibility edge needs a reviewed row again.
 */
const EXACT_COMPATIBILITY_DEBT: readonly ObservedCompatibilityDebt[] = [
  // RFC-395 O2: review reads Agent snapshots through ReviewUpstreamAgentPort;
  // the final production consumer of services/agent.ts has retired.
  // RFC-359 AC-1（plan §5hl）：这条边**销账**——数字员工执行的两份 composer 合一后，
  // Agent 查询改成由装配方交进来的 `agents` 端口（三个组合根各自绑自己的目录查询面），
  // composer 自己不再 import `services/agent` 的 `getAgentById`。债是还掉的，不是挪走的。
  // RFC-359 W4-D16：bootstrap 不再从 services 门面借 MCP 运行时测试的同步失效函数——生命周期已是
  // resource-catalog 自己的中立实现（createMcpTransactionLifecycle），两条边随之销账。
  // RFC-395 II-a A5: action runner delegates the built-in agent write to the catalog participant; the facade edge is gone.
  // RFC-359 AC-1（plan §5hn 之后的盘点，第 7 刀）：**这条边销账**——`syncWorkflow` 的七道
  // 前置门合一之后，SQLite 路由不再自己判工作流可见性（共用的 `assertTaskWorkflowSyncable`
  // 判），它对 `canViewResource` 的依赖随之消失。上一刀记的「过渡态净增 2」回落了一条；
  // 另一条（`getWorkflow`）SQLite 侧的 `assertManualExecutionAllowed` 还在用，随那一刀走。
  // RFC-359 AC-1（plan §5hn 之后的盘点，第 6 刀）：`workflowSyncPreview` 两个引擎合一后，
  // 共用实现住在 `taskRouteOperations.ts` 里，于是这条边在那个文件上**新出现**。
  // SQLite 那一侧没有减少（它的 `syncWorkflow` 写侧还在用同一个）——**过渡态**，
  // 随写侧那一刀一起回落（同 `cross-context-observed-imports` 那笔 allowGrowth 的理由）。
  // RFC-359 AC-1（第 13 刀）**销账**：手动执行门两个引擎合一，SQLite 那份本地实现
  //（`getWorkflow` 判内置）随之删除——共用那份走 `builtinCandidateWorkflow` +
  // 资源权威，不再经 legacy Workflow 门面。债是还掉的，不是挪走的。
  // RFC-359 AC-1（同上，第 6 刀）：共用预览在 PG 命名的文件里查工作流行；过渡态，随写侧那一刀回落。
  // RFC-470：上面登记的三条边（`services/workflow.ts` → `taskRouteOperations.ts` 的 `getWorkflow`；
  // `services/workflow.validator.ts` → `services/task.ts` 与 `services/taskLaunchGate.ts` 的校验）**销账**，两个转出删除（见上方
  // RETIRED_FACADES 的注释）。
  // RFC-424：`services/workgroup/state.ts` → `services/task.ts` 的最后一个符号 `setDwStateTx`
  // 随测试专用的动态工作流续跑准入删除，整条边销账。
]

const RETIRED_RESOURCE_ACL_SYMBOLS = [
  'AclResourceIdentitySnapshot',
  'DEFAULT_USER_RESOURCE_VISIBILITY',
  'DisclosedRefs',
  'ResourceAclActorProjection',
  'ResourceAclAudienceAuthority',
  'canEditResourceInTx',
  'canGovernResource',
  'findOwnedAclResourceIdsByName',
  'grantsOfUserWhere',
  'hasPrivateResourceAccess',
  'listResourceGrantsInTx',
  'listResourceGrantUserIds',
  'loadGrantLevelInTx',
  'loadGrantLevelsForUser',
  'resolveAccessFrom',
  'resolveResourceAccess',
  'requireResourceView',
] as const

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(absolute))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(absolute)
  }
  return files
}

function parsedSource(file: string, source?: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source ?? readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
}

function resolveBackendSpecifier(
  sourceRoot: string,
  file: string,
  specifier: string,
): string | null {
  const unresolved = specifier.startsWith('@/')
    ? resolve(sourceRoot, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(file), specifier)
      : null
  if (unresolved === null) return null
  for (const candidate of [
    unresolved,
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    join(unresolved, 'index.ts'),
    join(unresolved, 'index.tsx'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return unresolved.endsWith('.ts') || unresolved.endsWith('.tsx') ? unresolved : `${unresolved}.ts`
}

function importedNames(statement: ts.ImportDeclaration | ts.ExportDeclaration): string[] {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause
    if (clause === undefined) return ['<side-effect>']
    const names: string[] = []
    if (clause.name !== undefined) names.push('default')
    if (clause.namedBindings === undefined) return names
    if (ts.isNamespaceImport(clause.namedBindings)) names.push('*')
    else {
      for (const element of clause.namedBindings.elements) {
        names.push(element.propertyName?.text ?? element.name.text)
      }
      if (clause.namedBindings.elements.length === 0) names.push('<empty>')
    }
    return names
  }

  if (statement.exportClause === undefined) return ['*']
  if (ts.isNamespaceExport(statement.exportClause)) return ['*']
  if (statement.exportClause.elements.length === 0) return ['<empty>']
  return statement.exportClause.elements.map(
    (element) => element.propertyName?.text ?? element.name.text,
  )
}

function dynamicImportedNames(call: ts.CallExpression): string[] {
  let cursor: ts.Node = call
  while (ts.isAwaitExpression(cursor.parent) || ts.isParenthesizedExpression(cursor.parent)) {
    cursor = cursor.parent
  }
  if (ts.isVariableDeclaration(cursor.parent)) {
    const binding = cursor.parent.name
    if (ts.isObjectBindingPattern(binding)) {
      return binding.elements.map((element) => {
        const property = element.propertyName
        return property !== undefined && ts.isIdentifier(property)
          ? property.text
          : ts.isIdentifier(element.name)
            ? element.name.text
            : '<dynamic>'
      })
    }
  }
  if (ts.isPropertyAccessExpression(cursor.parent)) return [cursor.parent.name.text]
  return ['<dynamic>']
}

function observedFacadeImports(
  sourceRoot: string,
  files: readonly string[],
  definitions: readonly FacadeDefinition[],
): Map<string, Set<string>> {
  const targets = new Map(
    definitions.map((definition) => [resolve(sourceRoot, definition.facade), definition.facade]),
  )
  const observed = new Map<string, Set<string>>()

  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        const target = resolveBackendSpecifier(sourceRoot, file, node.moduleSpecifier.text)
        const facade = target === null ? undefined : targets.get(target)
        if (facade !== undefined && target !== file) {
          const consumer = relative(sourceRoot, file).replaceAll('\\', '/')
          const key = `${facade}\u0000${consumer}`
          const names = observed.get(key) ?? new Set<string>()
          for (const name of importedNames(node)) names.add(name)
          observed.set(key, names)
        }
      }

      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0]!)
      ) {
        const target = resolveBackendSpecifier(sourceRoot, file, node.arguments[0]!.text)
        const facade = target === null ? undefined : targets.get(target)
        if (facade !== undefined && target !== file) {
          const consumer = relative(sourceRoot, file).replaceAll('\\', '/')
          const key = `${facade}\u0000${consumer}`
          const names = observed.get(key) ?? new Set<string>()
          for (const name of dynamicImportedNames(node)) names.add(name)
          observed.set(key, names)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(parsedSource(file))
  }
  return observed
}

function exportedDeclarationNames(
  sourceRoot: string,
  file: string,
  seen = new Set<string>(),
): Set<string> {
  if (seen.has(file) || !existsSync(file)) return new Set()
  seen.add(file)
  const names = new Set<string>()
  for (const statement of parsedSource(file).statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      (ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
        false)
    if (
      exported &&
      (ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      names.add(statement.name.text)
    }
    if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
      }
    }
    if (!ts.isExportDeclaration(statement)) continue
    if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text)
      continue
    }
    if (statement.exportClause !== undefined) continue
    if (
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue
    }
    const target = resolveBackendSpecifier(sourceRoot, file, statement.moduleSpecifier.text)
    if (target === null) continue
    for (const name of exportedDeclarationNames(sourceRoot, target, seen)) names.add(name)
  }
  return names
}

function buildObservedDebt(
  observed: ReadonlyMap<string, Set<string>>,
  definitions: readonly FacadeDefinition[],
): ObservedCompatibilityDebt[] {
  const byFacade = new Map(definitions.map((definition) => [definition.facade, definition]))
  const exactByEdge = new Map(
    EXACT_COMPATIBILITY_DEBT.map((entry) => [`${entry.facade}\u0000${entry.consumer}`, entry]),
  )
  expect(exactByEdge.size, 'exact compatibility ledger has no duplicate edges').toBe(
    EXACT_COMPATIBILITY_DEBT.length,
  )
  expect(
    [...exactByEdge.keys()].sort(),
    'exact compatibility ledger has neither stale nor unreviewed live edges',
  ).toEqual([...observed.keys()].sort())

  return [...observed.entries()]
    .map(([key, names]) => {
      const [facade, consumer] = key.split('\u0000') as [string, string]
      const definition = byFacade.get(facade)
      expect(definition, `closed facade map contains ${facade}`).toBeDefined()
      const importedSymbols = [...names].sort()
      const exact = exactByEdge.get(key)
      expect(exact, `${facade} -> ${consumer} needs explicit successor debt`).toBeDefined()
      expect(
        exact?.importedSymbols,
        `${facade} -> ${consumer} imported symbols changed and need review`,
      ).toEqual(importedSymbols)
      expect(
        exact?.useCase.trim().length,
        `${facade} -> ${consumer} exact use case`,
      ).toBeGreaterThan(0)
      return exact ?? { facade, consumer, importedSymbols, useCase: '', removeOwners: [] }
    })
    .sort((left, right) =>
      `${left.facade}\u0000${left.consumer}`.localeCompare(
        `${right.facade}\u0000${right.consumer}`,
      ),
    )
}

function compatibilityMarker(source: string): boolean {
  const header = source.split('\n').slice(0, 8).join('\n')
  return /RFC-345[\s\S]*compatibility facade/u.test(header)
}

function explicitRelativeReexports(file: string): string[] {
  return parsedSource(file).statements.flatMap((statement) => {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith('.')
    ) {
      return []
    }
    return [statement.moduleSpecifier.text]
  })
}

/** Follow aliases used by explicit exports to catch two-hop relative bypasses. */
function relativeExportOriginChains(sourceRoot: string, entry: string): string[] {
  const reviewedPublicFiles = new Set(
    ['commands.ts', 'operations.ts', 'participants.ts', 'queries.ts', 'types.ts'].map((name) =>
      resolve(sourceRoot, 'modules/resource-catalog/public', name),
    ),
  )
  const findings = new Set<string>()

  const traceExport = (
    file: string,
    exportedName: string,
    chain: readonly string[],
    seen: ReadonlySet<string>,
  ): void => {
    const visitKey = `${file}\u0000${exportedName}`
    if (seen.has(visitKey) || !existsSync(file)) return
    const nextSeen = new Set(seen)
    nextSeen.add(visitKey)
    const unit = parsedSource(file)
    const imports = new Map<string, { target: string; imported: string }>()
    const aliases = new Map<string, string>()

    for (const statement of unit.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const target = resolveBackendSpecifier(sourceRoot, file, statement.moduleSpecifier.text)
        if (target === null) continue
        const clause = statement.importClause
        if (clause?.name !== undefined)
          imports.set(clause.name.text, { target, imported: 'default' })
        if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            imports.set(element.name.text, {
              target,
              imported: element.propertyName?.text ?? element.name.text,
            })
          }
        }
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer !== undefined &&
            ts.isIdentifier(declaration.initializer)
          ) {
            aliases.set(declaration.name.text, declaration.initializer.text)
          }
        }
      }
    }

    const traceLocal = (localName: string, localChain: readonly string[]): void => {
      const alias = aliases.get(localName)
      if (alias !== undefined) {
        traceLocal(alias, [...localChain, `${relative(sourceRoot, file)}#${localName}`])
        return
      }
      const binding = imports.get(localName)
      if (binding === undefined) return
      const nextChain = [
        ...localChain,
        `${relative(sourceRoot, file)}#${localName}`,
        `${relative(sourceRoot, binding.target)}#${binding.imported}`,
      ]
      if (!reviewedPublicFiles.has(binding.target)) {
        findings.add(nextChain.join(' -> '))
        return
      }
      traceExport(binding.target, binding.imported, nextChain, nextSeen)
    }

    for (const statement of unit.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.exportClause === undefined) {
          if (
            statement.moduleSpecifier !== undefined &&
            ts.isStringLiteralLike(statement.moduleSpecifier)
          ) {
            const target = resolveBackendSpecifier(sourceRoot, file, statement.moduleSpecifier.text)
            if (target === null) continue
            const nextChain = [...chain, `${relative(sourceRoot, target)}#*`]
            if (!reviewedPublicFiles.has(target)) findings.add(nextChain.join(' -> '))
            else traceExport(target, exportedName, nextChain, nextSeen)
          }
          continue
        }
        if (!ts.isNamedExports(statement.exportClause)) continue
        for (const element of statement.exportClause.elements) {
          if (element.name.text !== exportedName) continue
          const imported = element.propertyName?.text ?? element.name.text
          if (
            statement.moduleSpecifier !== undefined &&
            ts.isStringLiteralLike(statement.moduleSpecifier)
          ) {
            const target = resolveBackendSpecifier(sourceRoot, file, statement.moduleSpecifier.text)
            if (target === null) continue
            const nextChain = [...chain, `${relative(sourceRoot, target)}#${imported}`]
            if (!reviewedPublicFiles.has(target)) findings.add(nextChain.join(' -> '))
            else traceExport(target, imported, nextChain, nextSeen)
          } else {
            traceLocal(imported, chain)
          }
        }
      }

      const exported =
        ts.canHaveModifiers(statement) &&
        (ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
          false)
      if (!exported || !ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === exportedName &&
          declaration.initializer !== undefined &&
          ts.isIdentifier(declaration.initializer)
        ) {
          traceLocal(declaration.initializer.text, chain)
        }
      }
    }
  }

  for (const statement of parsedSource(entry).statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause === undefined) {
        if (
          statement.moduleSpecifier !== undefined &&
          ts.isStringLiteralLike(statement.moduleSpecifier)
        ) {
          const target = resolveBackendSpecifier(sourceRoot, entry, statement.moduleSpecifier.text)
          if (target !== null && !reviewedPublicFiles.has(target)) {
            findings.add(`${relative(sourceRoot, entry)}#* -> ${relative(sourceRoot, target)}#*`)
          }
        }
        continue
      }
      if (!ts.isNamedExports(statement.exportClause)) continue
      for (const element of statement.exportClause.elements) {
        traceExport(
          entry,
          element.name.text,
          [`${relative(sourceRoot, entry)}#${element.name.text}`],
          new Set(),
        )
      }
      continue
    }

    const exported =
      ts.canHaveModifiers(statement) &&
      (ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
        false)
    if (!exported || !ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.initializer === undefined ||
        !ts.isIdentifier(declaration.initializer)
      )
        continue
      traceExport(
        entry,
        declaration.name.text,
        [`${relative(sourceRoot, entry)}#${declaration.name.text}`],
        new Set(),
      )
    }
  }
  return [...findings].sort()
}

test('resource ACL compatibility barrels retire only consumer-zero symbols', () => {
  const sourceRoot = resolve(import.meta.dir, '../src')
  const publicOperationsPath = resolve(sourceRoot, 'modules/resource-catalog/public/operations.ts')
  const publicOperations = readFileSync(publicOperationsPath, 'utf8')
  // RFC-466: the services/resourceAcl facade itself is retired; only the public half of this lock remains.
  expect(existsSync(resolve(sourceRoot, 'services/resourceAcl.ts'))).toBe(false)
  const packageCli = readFileSync(resolve(sourceRoot, 'cli/package.ts'), 'utf8')
  const packageComposition = readFileSync(
    resolve(sourceRoot, 'modules/resource-catalog/composition/resourcePackageOperations.ts'),
    'utf8',
  )
  const postgresqlPackageComposition = readFileSync(
    resolve(sourceRoot, 'modules/resource-catalog/composition/postgresqlResourcePackageCatalog.ts'),
    'utf8',
  )
  const packageProviderComposition = readFileSync(
    resolve(sourceRoot, 'modules/resource-catalog/composition/resourcePackageProvider.ts'),
    'utf8',
  )

  for (const retiredSymbol of RETIRED_RESOURCE_ACL_SYMBOLS) {
    const exactSymbol = new RegExp(`\\b${retiredSymbol}\\b`)
    expect(exactSymbol.test(publicOperations), `${retiredSymbol} public export`).toBe(false)
  }

  expect(packageCli).not.toContain("from '@/services/resourceAcl'")
  expect(packageCli).toContain('catalog.transport.findOwnedResourceIdsByName')
  expect(packageComposition).toContain('readonly resources: ResourcePackageOwnedResourceLookupPort')
  expect(packageComposition).toContain('return deps.resources.findOwnedIdsByName({')
  // RFC-359 W12: both provider wrappers delegate the lookup binding to one composition.
  // RFC-359（apply 引擎合一，plan §5dv/§5dw）：SQLite 专属的那个 wrapper
  // （`composeSqliteResourcePackageProvider`）零生产消费者后退役，只剩带写会话的那一条；
  // 读装配仍然是同一个 `composeResourcePackageProvider`。
  expect(packageComposition).not.toContain('composeSqliteResourcePackageProvider')
  expect(postgresqlPackageComposition).toContain('...composeResourcePackageProvider(input)')
  for (const consumer of [packageComposition, postgresqlPackageComposition]) {
    expect(consumer).toContain("from './resourcePackageProvider'")
    expect(consumer).not.toContain('createResourcePackageOwnedResourceLookup')
  }
  expect(packageProviderComposition).toContain("from '../infrastructure/packageResourceRows'")
  expect(packageProviderComposition).toContain(
    'resources: createResourcePackageOwnedResourceLookup(input.db)',
  )
  expect(packageComposition).not.toContain('findOwnedAclResourceIdsByName(deps.db,')

  expect(
    explicitRelativeReexports(publicOperationsPath),
    'public operations must not directly re-export relative barrels',
  ).toEqual([])
  expect(
    relativeExportOriginChains(sourceRoot, publicOperationsPath),
    'public operations must not disguise internal owners through relative import/export chains',
  ).toEqual([])
})

test('workflow ACL identity is application-owned and agents consume the exact public ACL seam', () => {
  const sourceRoot = resolve(import.meta.dir, '../src')
  const publicTypes = readFileSync(
    resolve(sourceRoot, 'modules/resource-catalog/public/types.ts'),
    'utf8',
  )
  const workflowPorts = readFileSync(
    resolve(sourceRoot, 'modules/resource-catalog/application/workflows/ports.ts'),
    'utf8',
  )
  const workflowApplication = readFileSync(
    resolve(sourceRoot, 'modules/resource-catalog/application/workflows/workflowApplication.ts'),
    'utf8',
  )
  const agentRoutes = readFileSync(resolve(sourceRoot, 'routes/agents.ts'), 'utf8')

  expect(publicTypes).not.toMatch(/\bexport interface WorkflowAclIdentity\b/)
  expect(workflowPorts).toMatch(/\bexport interface WorkflowAclIdentity\b/)
  expect(workflowApplication).toContain('WorkflowAclIdentity,')
  expect(agentRoutes).toContain('queries.get(authority, { id: row.id })')
  expect(agentRoutes).not.toContain('filterVisibleRows')
  expect(agentRoutes).not.toContain("from '@/services/resourceAcl'")
})

test('all live classic compatibility consumers have source-derived exact successor debt', () => {
  const sourceRoot = resolve(import.meta.dir, '../src')
  const repositoryRoot = resolve(sourceRoot, '../../..')
  const files = sourceFiles(sourceRoot)
  const definitionsByFacade = new Map(
    FACADE_DEFINITIONS.map((definition) => [definition.facade, definition]),
  )

  const discoveredCompatibilityFacades = sourceFiles(resolve(sourceRoot, 'services'))
    .filter((file) => compatibilityMarker(readFileSync(file, 'utf8')))
    .map((file) => relative(sourceRoot, file).replaceAll('\\', '/'))
    .sort()
  expect(
    discoveredCompatibilityFacades.filter((facade) => !definitionsByFacade.has(facade)),
    'new RFC-345 facades need an exact successor map',
  ).toEqual([])

  for (const definition of FACADE_DEFINITIONS) {
    const facadePath = resolve(sourceRoot, definition.facade)
    if (!existsSync(facadePath) || !definition.compatibilityMarker) continue
    expect(
      compatibilityMarker(readFileSync(facadePath, 'utf8')),
      `${definition.facade} retains its marker until deletion`,
    ).toBe(true)
  }

  const observed = observedFacadeImports(sourceRoot, files, FACADE_DEFINITIONS)
  const debt = buildObservedDebt(observed, FACADE_DEFINITIONS)
  const exportedNames = new Map<string, Set<string>>()

  for (const retiredFacade of RETIRED_FACADES) {
    expect(existsSync(resolve(sourceRoot, retiredFacade)), `${retiredFacade} stays retired`).toBe(
      false,
    )
    expect(
      [...observed.keys()].filter((key) => key.startsWith(`${retiredFacade}\u0000`)),
      `${retiredFacade} cannot regain consumers`,
    ).toEqual([])
  }

  for (const entry of debt) {
    expect(
      entry.importedSymbols.length,
      `${entry.facade} -> ${entry.consumer} symbols`,
    ).toBeGreaterThan(0)
    expect(
      entry.importedSymbols.filter((symbol) =>
        ['*', 'default', '<dynamic>', '<empty>', '<side-effect>'].includes(symbol),
      ),
      `${entry.facade} -> ${entry.consumer} must use reviewable named symbols`,
    ).toEqual([])
    expect(
      entry.useCase.trim().length,
      `${entry.facade} -> ${entry.consumer} use case`,
    ).toBeGreaterThan(0)
    expect(
      entry.removeOwners.length,
      `${entry.facade} -> ${entry.consumer} successor`,
    ).toBeGreaterThan(0)

    for (const removeOwner of entry.removeOwners) {
      expect(removeOwner.wave.length, `${entry.facade} -> ${entry.consumer} wave`).toBeGreaterThan(
        0,
      )
      expect(
        removeOwner.path.includes('/services/') ||
          removeOwner.path.includes('/resource-catalog/infrastructure/legacy/'),
        `${entry.facade} -> ${entry.consumer} cannot self-certify through a compatibility owner`,
      ).toBe(false)
      const ownerPath = resolve(repositoryRoot, removeOwner.path)
      expect(existsSync(ownerPath), `${removeOwner.path} exists`).toBe(true)
      const names = exportedNames.get(ownerPath) ?? exportedDeclarationNames(sourceRoot, ownerPath)
      exportedNames.set(ownerPath, names)
      expect(
        names.has(removeOwner.exportName),
        `${removeOwner.path}#${removeOwner.exportName} is an exact export`,
      ).toBe(true)
    }
  }

  const importedResourceAclSymbols = new Set(
    debt
      .filter((entry) => entry.facade === 'services/resourceAcl.ts')
      .flatMap((entry) => [...entry.importedSymbols]),
  )
  expect(
    RETIRED_RESOURCE_ACL_SYMBOLS.filter((symbol) => importedResourceAclSymbols.has(symbol)),
    'only consumer-zero ACL symbols may be declared retired',
  ).toEqual([])

  for (const definition of FACADE_DEFINITIONS) {
    const prefix = `${definition.facade}\u0000`
    const consumers = [...observed.keys()].filter((key) => key.startsWith(prefix))
    if (existsSync(resolve(sourceRoot, definition.facade))) {
      expect(
        consumers.length,
        `${definition.facade} has zero production consumers and must be retired`,
      ).toBeGreaterThan(0)
      continue
    }
    expect(consumers, `${definition.facade} may be deleted only at zero consumers`).toEqual([])
  }
  // 显式超时：这一条 readdirSync 递归整棵 src 树再逐文件做文本匹配，成本随源码树增长。
  // 2026-09-03 在 `Backend tests (macos-latest shard 4/4)` 上以 **7013.75ms** 撞上 bun
  // 默认的 5000ms（同一提交本机整文件 1.1–1.3s）。与 `docs/audit-backlog.md` 里 RFC-227
  // Seatbelt（5015ms / 本机 380ms）、以及同日 rfc322 棘轮（5058.92ms / 本机 850ms）同族：
  // 工作量确定且有界，变的是机器速度。处置照那两条——给宽裕但**有限**的上限，真挂住仍会
  // 失败，不是把上限抬到永不触发。
}, 30_000)
