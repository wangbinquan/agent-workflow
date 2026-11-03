// RFC-401 Part A (design §9): each resource kind is written through one participant in
// `modules/resource-catalog/infrastructure/` — agents (A1), MCP servers and plugins (A2), workflows (A3a), workgroups
// (A3b; workgroup rows have no separate write program, so the lock scans for raw row writes instead), skills (Part B T5:
// `skills` / `skill_versions` rows; the ordinary CRUD writes, ZIP, restore and fusion reach it through the skill write scene
// `skillAtomicApply.ts`, and Intent no longer pre-checks skill names — `intent-name-conflict` is gone). The ordinary
// CRUD repository, the Intent port and the resource-package arm (and, for agents, the digital-employee template writer;
// for workflows, the built-in workflow catalog) all call it, and only the participant imports the kind's row-write
// program. For agents the dependency-graph check has one write-time caller (the participant) plus the public validation
// query, and Intent's own `agent-runtime-not-found` and the package planner's `BundleCycleError` are gone. For workflows
// Intent no longer rejects duplicate names (`workflow-name-in-use`) nor runs the full graph check on commit
// (`intent-workflow-invalid`, proposal §5 #2 / #8). RFC-401 T6 (proposal G5) deleted the test-only legacy writers of
// agents, workflows and workgroups (and the YAML import writer), so those kinds have no legacy importer left.
// Reads the production sources without importing them.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const ROOT = resolve(import.meta.dir, '../../../..')
const RC = 'packages/backend/src/modules/resource-catalog/'
const INFRA = RC + 'infrastructure/'
const INTENT_PORTS = INFRA + 'aggregateAdapters/intentApplyResourcePorts.ts'
const PACKAGE_ARMS = INFRA + 'aggregateAdapters/postgresqlResourcePackageMutationArms.ts'
const GRAPH = RC + 'domain/agentDependencies.ts'
const GRAPH_QUERY = RC + 'application/agents/agentDependencyValidation.ts'

interface WriteStack {
  readonly kind: string
  readonly participant: string
  readonly factory: string
  /** Module suffix of the kind's row-write program and the atoms only the participant may import. */
  readonly program: string
  readonly programExports: readonly string[]
  /** Raw row writes only the participant (and the legacy importers) may contain, for kinds without a program. */
  readonly rowWrite?: RegExp
  /** Exact set: it can only shrink. */
  readonly legacyImporters: readonly string[]
  /** Scene adapters that must hand their writes to the participant. */
  readonly scenes: readonly { readonly path: string; readonly fn: string }[]
}

const STACKS: readonly WriteStack[] = [
  {
    kind: 'agent',
    participant: INFRA + 'agentMutationParticipant.ts',
    factory: 'createAgentMutationParticipant',
    program: '/agentReferenceWrite',
    programExports: [
      'createAgentReferenceWriteParticipant',
      'prepareAgentReferenceUpdate',
      'replaceAgentReferences',
    ],
    // RFC-401 T6 (G5): the test-only legacy writers are deleted; fixtures write through the participant
    // (`tests/helpers/model/resourceWrites.ts`).
    legacyImporters: [],
    scenes: [
      { path: INTENT_PORTS, fn: 'createAgentPort' },
      { path: PACKAGE_ARMS, fn: 'commitPostgresqlAgentPackageMutation' },
      { path: INFRA + 'agentRepository.ts', fn: 'createAgentRepository' },
      {
        path: INFRA + 'digitalEmployeeAgentTemplateCatalog.ts',
        fn: 'createDigitalEmployeeAgentTemplateRepository',
      },
    ],
  },
  {
    kind: 'mcp',
    participant: INFRA + 'mcpMutationParticipant.ts',
    factory: 'createMcpMutationParticipant',
    program: '/mcpPersistence',
    programExports: ['insertMcpRowInTx', 'updateMcpRowInTx'],
    legacyImporters: [],
    scenes: [
      { path: INTENT_PORTS, fn: 'createMcpPort' },
      { path: PACKAGE_ARMS, fn: 'commitPostgresqlMcpPackageMutation' },
      { path: INFRA + 'mcpRepository.ts', fn: 'createMcpRepository' },
    ],
  },
  {
    kind: 'plugin',
    participant: INFRA + 'pluginMutationParticipant.ts',
    factory: 'createPluginMutationParticipant',
    program: '/pluginPersistence',
    programExports: ['insertPluginRowInTx', 'publishPluginRowInTx'],
    legacyImporters: [],
    scenes: [
      { path: INTENT_PORTS, fn: 'createPluginPort' },
      { path: PACKAGE_ARMS, fn: 'commitPostgresqlPluginPackageMutation' },
      { path: INFRA + 'pluginRepository.ts', fn: 'createPluginRepository' },
    ],
  },
  {
    kind: 'workflow',
    participant: INFRA + 'workflowMutationParticipant.ts',
    factory: 'createWorkflowMutationParticipant',
    program: '/workflowDefinitionWrite',
    programExports: ['createWorkflowDefinitionWriteParticipant'],
    // RFC-401 T6 (G5): the test-only legacy writers (and the YAML import writer) are deleted.
    legacyImporters: [],
    scenes: [
      { path: INTENT_PORTS, fn: 'createWorkflowPort' },
      { path: PACKAGE_ARMS, fn: 'commitPostgresqlWorkflowPackageMutation' },
      { path: INFRA + 'workflowRepository.ts', fn: 'createWorkflowRepository' },
      { path: RC + 'composition/builtinWorkflowCatalog.ts', fn: 'composeBuiltinWorkflowCatalog' },
    ],
  },
  {
    kind: 'workgroup',
    participant: INFRA + 'workgroupMutationParticipant.ts',
    factory: 'createWorkgroupMutationParticipant',
    program: '/workgroupMutationParticipant',
    programExports: [],
    // Content and member-row writes; the repository keeps only the delete of the workgroup row.
    rowWrite:
      /\.(?:insert|update)\(\s*workgroups\s*\)|\.(?:insert|update|delete)\(\s*workgroupMembers\s*\)|insertOne\([^,]+,\s*(?:workgroups|workgroupMembers)\s*,/,
    // RFC-401 T6 (G5): the test-only legacy writers are deleted.
    legacyImporters: [],
    scenes: [
      { path: INTENT_PORTS, fn: 'createWorkgroupPort' },
      { path: PACKAGE_ARMS, fn: 'commitPostgresqlWorkgroupPackageMutation' },
      { path: INFRA + 'workgroupRepository.ts', fn: 'createWorkgroupRepository' },
    ],
  },
  {
    kind: 'skill',
    participant: INFRA + 'skillMutationParticipant.ts',
    factory: 'createSkillMutationParticipant',
    program: '/skillMutationParticipant',
    programExports: [],
    rowWrite:
      /\.(?:insert|update|delete)\(\s*(?:skills|skillVersions)\s*\)|insertOne\([^,]+,\s*(?:skills|skillVersions)\s*,/,
    // Not content writes: recovery and boot bookkeeping of the skill row state (old-format operation recovery that drops a
    // never-ready row or flips it ready, quarantine, boot snapshot verdicts, the database live-tree reference).
    legacyImporters: [
      INFRA + 'databaseSkillTrees.ts',
      INFRA + 'legacy/skillBootVerify.ts',
      INFRA + 'legacy/skillOpRecoveryDriver.ts',
      INFRA + 'legacy/skillReserveOp.ts',
      INFRA + 'resourcePackageOperationRecovery.ts',
    ],
    scenes: [
      { path: INTENT_PORTS, fn: 'createSkillPort' },
      { path: PACKAGE_ARMS, fn: 'commitPostgresqlSkillPackageMutation' },
      { path: INFRA + 'skillAtomicApply.ts', fn: 'createSkillApplyScene' },
    ],
  },
]
/** Codes and identifiers the unified write rules removed (proposal §5 #2 / #8). */
const RETIRED_STRINGS = [
  'intent-name-conflict',
  'workflow-name-in-use',
  'intent-workflow-invalid',
  'workgroup-human-inactive',
] as const
const RETIRED_IDENTIFIERS = ['validateResolvedBundleWorkflowGraphs'] as const
const UNITS = backendUnits(ROOT)

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

function importedNames(unit: SourceUnit, moduleSuffix: string): string[] {
  const names: string[] = []
  for (const statement of unit.source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.endsWith(moduleSuffix)
    )
      continue
    const bindings = statement.importClause?.namedBindings
    if (bindings !== undefined && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        names.push((element.propertyName ?? element.name).text)
  }
  return names
}

function calls(node: ts.Node, source: ts.SourceFile, callee: string): boolean {
  let found = false
  walk(node, (inner) => {
    if (ts.isCallExpression(inner) && inner.expression.getText(source) === callee) found = true
  })
  return found
}

export function writeStackViolations(units: readonly SourceUnit[]): string[] {
  const found = new Set<string>()
  for (const unit of units) {
    for (const stack of STACKS) {
      if (unit.path === stack.participant || stack.legacyImporters.includes(unit.path)) continue
      const imported = importedNames(unit, stack.program).filter((name) =>
        stack.programExports.includes(name),
      )
      if (imported.length > 0) found.add(`${stack.kind}-write-program:${unit.path}`)
      if (stack.rowWrite?.test(unit.text) === true)
        found.add(`${stack.kind}-row-write:${unit.path}`)
    }
    const agent = STACKS[0]!
    if (unit.path !== GRAPH && unit.path !== agent.participant && unit.path !== GRAPH_QUERY) {
      if (importedNames(unit, '/agentDependencies').includes('assertAgentDependencyGraph'))
        found.add('graph-check:' + unit.path)
    }
    walk(unit.source, (node) => {
      if (ts.isStringLiteralLike(node) && node.text === 'agent-runtime-not-found')
        found.add('intent-runtime-code:' + unit.path)
      if (ts.isIdentifier(node) && node.text === 'BundleCycleError')
        found.add('bundle-cycle-error:' + unit.path)
      if (
        ts.isStringLiteralLike(node) &&
        (RETIRED_STRINGS as readonly string[]).includes(node.text)
      )
        found.add(`retired-code:${node.text}:${unit.path}`)
      if (ts.isIdentifier(node) && (RETIRED_IDENTIFIERS as readonly string[]).includes(node.text))
        found.add(`retired-identifier:${node.text}:${unit.path}`)
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(unit.source) === 'semantics' &&
        ts.isStringLiteralLike(node.initializer) &&
        node.initializer.text === 'intent'
      )
        found.add('intent-graph-semantics:' + unit.path)
    })
  }
  for (const stack of STACKS)
    for (const scene of stack.scenes) {
      const unit = units.find((candidate) => candidate.path === scene.path)
      if (unit === undefined) continue
      let fn: ts.FunctionDeclaration | undefined
      walk(unit.source, (node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === scene.fn) fn = node
      })
      if (fn === undefined || !calls(fn, unit.source, stack.factory))
        found.add('scene-bypass:' + scene.fn)
    }
  return [...found].sort()
}

test('live corpus: each kind is written through its one participant', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of [
    GRAPH,
    GRAPH_QUERY,
    ...STACKS.flatMap((stack) => [stack.participant, ...stack.legacyImporters]),
  ])
    expect(
      UNITS.some((unit) => unit.path === path),
      path,
    ).toBe(true)
  expect(writeStackViolations(UNITS)).toEqual([])
})

// 每条负例都对整个语料（2000+ 文件）重跑一次判据；带覆盖率的 CI 上一轮约 0.6 s，九条合计超过缺省的 5 s（A3b 提交的 CI
// 41516047519 shard 2 即超时），超时放宽到 30 s。
test('negative fixtures over the corpus: each way back is reported', () => {
  const replace = (path: string, edit: (text: string) => string) =>
    UNITS.map((unit) => (unit.path === path ? sourceUnit(path, edit(unit.text)) : unit))
  expect(
    writeStackViolations(
      replace(
        INFRA + 'fusionResourceSeed.ts',
        (text) =>
          "import { createAgentReferenceWriteParticipant } from './agentReferenceWrite'\n" + text,
      ),
    ),
  ).toEqual(['agent-write-program:' + INFRA + 'fusionResourceSeed.ts'])
  expect(
    writeStackViolations(
      replace(
        INFRA + 'mcpRepository.ts',
        (text) => "import { insertMcpRowInTx } from './mcpPersistence'\n" + text,
      ),
    ),
  ).toEqual(['mcp-write-program:' + INFRA + 'mcpRepository.ts'])
  expect(
    writeStackViolations(
      replace(
        PACKAGE_ARMS,
        (text) =>
          "import { assertAgentDependencyGraph } from '../../domain/agentDependencies'\n" + text,
      ),
    ),
  ).toEqual(['graph-check:' + PACKAGE_ARMS])
  expect(
    writeStackViolations(
      replace(INTENT_PORTS, (text) =>
        text.replace(
          'const agents = createAgentMutationParticipant(transaction, { now })',
          'const agents = createIntentAgentWriter(transaction, { now })',
        ),
      ),
    ),
  ).toEqual(['scene-bypass:createAgentPort'])
  expect(
    writeStackViolations(
      replace(INTENT_PORTS, (text) =>
        text.replace(
          'const plugins = createPluginMutationParticipant(transaction, { now })',
          'const plugins = createIntentPluginWriter(transaction, { now })',
        ),
      ),
    ),
  ).toEqual(['scene-bypass:createPluginPort'])
  expect(
    writeStackViolations(
      replace(INTENT_PORTS, (text) =>
        text.replace(
          'const workflows = createWorkflowMutationParticipant(transaction, { now })',
          'const workflows = createIntentWorkflowWriter(transaction, { now })',
        ),
      ),
    ),
  ).toEqual(['scene-bypass:createWorkflowPort'])
  expect(
    writeStackViolations(
      replace(
        INFRA + 'demoResourceCatalogSeed.ts',
        (text) =>
          "import { createWorkflowDefinitionWriteParticipant } from './workflowDefinitionWrite'\n" +
          text,
      ),
    ),
  ).toEqual(['workflow-write-program:' + INFRA + 'demoResourceCatalogSeed.ts'])
  expect(
    writeStackViolations(
      replace(
        INFRA + 'workgroupRepository.ts',
        (text) => text + '\nawait transaction.delete(workgroupMembers).where(condition)\n',
      ),
    ),
  ).toEqual(['workgroup-row-write:' + INFRA + 'workgroupRepository.ts'])
  expect(
    writeStackViolations(
      replace(INTENT_PORTS, (text) =>
        text.replace(
          'const workgroups = createWorkgroupMutationParticipant(transaction, {',
          'const workgroups = createIntentWorkgroupWriter(transaction, {',
        ),
      ),
    ),
  ).toEqual(['scene-bypass:createWorkgroupPort'])
  expect(
    writeStackViolations(
      replace(
        INFRA + 'legacy/skill.ts',
        (text) => text + '\nawait tx.update(skills).set({ description }).where(condition)\n',
      ),
    ),
  ).toEqual(['skill-row-write:' + INFRA + 'legacy/skill.ts'])
  expect(
    writeStackViolations(
      replace(INTENT_PORTS, (text) =>
        text.replace(
          'const skillWrites = createSkillMutationParticipant(transaction)',
          'const skillWrites = createIntentSkillWriter(transaction)',
        ),
      ),
    ),
  ).toEqual(['scene-bypass:createSkillPort'])
}, 30_000)

test('negative fixtures over fabricated units alone: every matcher still bites', () => {
  const only = (path: string, text: string) => writeStackViolations([sourceUnit(path, text)])
  expect(
    only(INFRA + 'x.ts', "import { replaceAgentReferences } from './agentReferenceWrite'"),
  ).toEqual(['agent-write-program:' + INFRA + 'x.ts'])
  expect(
    only(INFRA + 'x.ts', "import { publishPluginRowInTx } from './pluginPersistence'"),
  ).toEqual(['plugin-write-program:' + INFRA + 'x.ts'])
  expect(only(INFRA + 'x.ts', "throw new ValidationError('agent-runtime-not-found', 'x')")).toEqual(
    ['intent-runtime-code:' + INFRA + 'x.ts'],
  )
  expect(
    only('packages/backend/src/services/bundle/provider.ts', 'export class BundleCycleError {}'),
  ).toEqual(['bundle-cycle-error:packages/backend/src/services/bundle/provider.ts'])
  expect(only(INFRA + 'x.ts', "throw new ConflictError('workflow-name-in-use', 'taken')")).toEqual([
    'retired-code:workflow-name-in-use:' + INFRA + 'x.ts',
  ])
  expect(
    only(INFRA + 'x.ts', "throw new ValidationError('workgroup-human-inactive', 'x')"),
  ).toEqual(['retired-code:workgroup-human-inactive:' + INFRA + 'x.ts'])
  expect(only(INFRA + 'x.ts', 'await insertOne(transaction, workgroupMembers, value)')).toEqual([
    'workgroup-row-write:' + INFRA + 'x.ts',
  ])
  expect(only(INFRA + 'x.ts', 'await tx.update(workgroups).set({ name })')).toEqual([
    'workgroup-row-write:' + INFRA + 'x.ts',
  ])
  expect(only(INFRA + 'x.ts', 'await insertOne(tx, skillVersions, row)')).toEqual([
    'skill-row-write:' + INFRA + 'x.ts',
  ])
  expect(only(INFRA + 'x.ts', "throw new ValidationError('intent-name-conflict', 'x')")).toEqual([
    'retired-code:intent-name-conflict:' + INFRA + 'x.ts',
  ])
  // The delete of a workgroup row (the repository's delete path) is not a content write.
  expect(only(INFRA + 'x.ts', 'await tx.delete(workgroups).where(condition)')).toEqual([])
  expect(
    only(
      'packages/backend/src/modules/intent/infrastructure/x.ts',
      "throw new ValidationError('intent-workflow-invalid', 'x')",
    ),
  ).toEqual([
    'retired-code:intent-workflow-invalid:packages/backend/src/modules/intent/infrastructure/x.ts',
  ])
  expect(
    only(
      'packages/backend/src/modules/intent/application/x.ts',
      'export async function validateResolvedBundleWorkflowGraphs() {}',
    ),
  ).toEqual([
    'retired-identifier:validateResolvedBundleWorkflowGraphs:packages/backend/src/modules/intent/application/x.ts',
  ])
  expect(only(INFRA + 'x.ts', "assertAgentDependencyGraph({ semantics: 'intent' })")).toEqual([
    'intent-graph-semantics:' + INFRA + 'x.ts',
  ])
  // A scene that no longer calls its participant, and scenes that disappeared from the file, are both reported.
  expect(
    only(PACKAGE_ARMS, 'export async function commitPostgresqlMcpPackageMutation() {}'),
  ).toEqual([
    'scene-bypass:commitPostgresqlAgentPackageMutation',
    'scene-bypass:commitPostgresqlMcpPackageMutation',
    'scene-bypass:commitPostgresqlPluginPackageMutation',
    'scene-bypass:commitPostgresqlSkillPackageMutation',
    'scene-bypass:commitPostgresqlWorkflowPackageMutation',
    'scene-bypass:commitPostgresqlWorkgroupPackageMutation',
  ])
})
