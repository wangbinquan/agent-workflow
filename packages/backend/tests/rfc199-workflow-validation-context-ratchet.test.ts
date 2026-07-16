// RFC-199 B3 validation-context source ratchet.
//
// Why this file exists: a receipt hash is only trustworthy when every live
// inventory field read by validation (including delegated port derivation)
// is represented by projectWorkflowValidationContext. Hand-maintained prose
// drifts silently, so this test uses the TypeScript checker to inventory real
// Agent/Skill/Plugin property reads and follows helpers that receive those
// resource types. A new semantic read without a matching projection turns the
// test red; prompt/secret/path fields remain explicitly forbidden.

import { canonicalJson, type Agent, type Skill } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import {
  projectWorkflowValidationContext,
  type ValidatorContext,
} from '../src/services/workflow.validator'

type InventoryFamily = 'agent' | 'skill' | 'plugin'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BACKEND_TSCONFIG = resolve(REPO_ROOT, 'packages', 'backend', 'tsconfig.json')
const VALIDATOR_SOURCE = resolve(
  REPO_ROOT,
  'packages',
  'backend',
  'src',
  'services',
  'workflow.validator.ts',
)
const LOCAL_SOURCE_ROOTS = [
  resolve(REPO_ROOT, 'packages', 'backend', 'src') + sep,
  resolve(REPO_ROOT, 'packages', 'shared', 'src') + sep,
]
const DIRECT_INVENTORY_TYPES = new Map<string, InventoryFamily>([
  ['Agent', 'agent'],
  ['PortLookupAgent', 'agent'],
  ['Skill', 'skill'],
  ['ValidatorPluginResource', 'plugin'],
])
const INVENTORY_CARRIER_TYPES = new Set([
  ...DIRECT_INVENTORY_TYPES.keys(),
  'AgentLookup',
  'PortAgentLookup',
  'ValidatorContext',
])

function fixtureAgent(name = 'coder'): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: 'description',
    ownerUserId: 'owner-1',
    visibility: 'private',
    builtin: false,
    inputs: [{ name: 'query', kind: 'string', required: true }],
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    outputWrapperPortNames: { answer: 'accepted' },
    role: 'normal',
    syncOutputsOnIterate: true,
    runtime: 'opencode',
    permission: { bash: 'deny' },
    skills: ['reviewing'],
    dependsOn: [],
    mcp: ['filesystem'],
    plugins: ['formatter'],
    frontmatterExtra: { token: 'secret' },
    bodyMd: 'SECRET PROMPT',
    schemaVersion: 4,
    createdAt: 10,
    updatedAt: 20,
  }
}

function fixtureSkill(): Skill {
  return {
    id: 'skill-reviewing',
    name: 'reviewing',
    description: 'description',
    ownerUserId: 'owner-1',
    visibility: 'private',
    sourceKind: 'managed',
    managedPath: '/secret/skill/path',
    schemaVersion: 2,
    contentVersion: 7,
    createdAt: 10,
    updatedAt: 30,
  }
}

function fixtureContext(): ValidatorContext {
  return {
    agents: [fixtureAgent()],
    skills: [fixtureSkill()],
    plugins: [
      {
        id: 'plugin-formatter',
        name: 'formatter',
        ownerUserId: 'owner-1',
        visibility: 'private',
        enabled: true,
        sourceKind: 'npm',
        resolvedVersion: '1.2.3',
        schemaVersion: 3,
        updatedAt: 40,
      },
    ],
  }
}

function compilerProgram(): ts.Program {
  const loaded = ts.readConfigFile(BACKEND_TSCONFIG, ts.sys.readFile)
  if (loaded.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'))
  }
  const config = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(BACKEND_TSCONFIG),
    undefined,
    BACKEND_TSCONFIG,
  )
  return ts.createProgram({ rootNames: [VALIDATOR_SOURCE], options: config.options })
}

function typeNames(type: ts.Type): string[] {
  const names = [type.aliasSymbol?.getName(), type.getSymbol()?.getName()]
  return names.filter((name): name is string => name !== undefined)
}

function inventoryFamilyOf(checker: ts.TypeChecker, type: ts.Type): InventoryFamily | undefined {
  if (type.isUnionOrIntersection()) {
    for (const member of type.types) {
      const family = inventoryFamilyOf(checker, member)
      if (family !== undefined) return family
    }
  }
  for (const name of typeNames(type)) {
    const family = DIRECT_INVENTORY_TYPES.get(name)
    if (family !== undefined) return family
  }
  // Agent/Skill are z.infer aliases and TypeScript may expand away their alias
  // symbols at call sites. These structural discriminators use capability
  // fields unique to each inventory resource, never variable-name heuristics.
  const properties = new Set(
    checker.getPropertiesOfType(type).map((property) => property.getName()),
  )
  if (properties.has('outputs') && properties.has('outputKinds') && properties.has('role')) {
    return 'agent'
  }
  if (properties.has('managedPath') && properties.has('contentVersion')) return 'skill'
  if (properties.has('enabled') && properties.has('resolvedVersion')) return 'plugin'
  return undefined
}

function isInventoryCarrier(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (inventoryFamilyOf(checker, type) !== undefined) return true
  if (typeNames(type).some((name) => INVENTORY_CARRIER_TYPES.has(name))) return true
  if (
    type.isUnionOrIntersection() &&
    type.types.some((member) => isInventoryCarrier(checker, member))
  ) {
    return true
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return false
  const reference = type as ts.TypeReference
  return checker
    .getTypeArguments(reference)
    .some((argument) => isInventoryCarrier(checker, argument))
}

function calledLocalSource(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): ts.SourceFile | undefined {
  const receiver = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.expression
    : undefined
  const carriesInventory =
    call.arguments.some((argument) =>
      isInventoryCarrier(checker, checker.getTypeAtLocation(argument)),
    ) ||
    (receiver !== undefined && isInventoryCarrier(checker, checker.getTypeAtLocation(receiver)))
  if (!carriesInventory) return undefined

  let symbol = checker.getSymbolAtLocation(call.expression)
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol)
  }
  const source = symbol?.declarations?.[0]?.getSourceFile()
  if (source === undefined || source.isDeclarationFile) return undefined
  const absolute = resolve(source.fileName)
  return LOCAL_SOURCE_ROOTS.some((root) => absolute.startsWith(root)) ? source : undefined
}

function discoverSemanticSources(program: ts.Program): ts.SourceFile[] {
  const checker = program.getTypeChecker()
  const first = program.getSourceFile(VALIDATOR_SOURCE)
  if (first === undefined) throw new Error(`missing compiler source: ${VALIDATOR_SOURCE}`)

  const found = new Map<string, ts.SourceFile>([[resolve(first.fileName), first]])
  const queue = [first]
  while (queue.length > 0) {
    const source = queue.shift()!
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const delegated = calledLocalSource(checker, node)
        if (delegated !== undefined) {
          const path = resolve(delegated.fileName)
          if (!found.has(path)) {
            found.set(path, delegated)
            queue.push(delegated)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return [...found.values()].sort((left, right) => left.fileName.localeCompare(right.fileName))
}

function semanticFieldReads(program: ts.Program, sources: ts.SourceFile[]) {
  const checker = program.getTypeChecker()
  const reads = new Map<InventoryFamily, Set<string>>([
    ['agent', new Set()],
    ['skill', new Set()],
    ['plugin', new Set()],
  ])

  for (const source of sources) {
    const visit = (node: ts.Node, excluded = false): void => {
      const insideProjection =
        excluded ||
        (ts.isFunctionDeclaration(node) && node.name?.text === 'projectWorkflowValidationContext')
      if (insideProjection) return

      if (ts.isPropertyAccessExpression(node)) {
        const family = inventoryFamilyOf(checker, checker.getTypeAtLocation(node.expression))
        if (family !== undefined) reads.get(family)!.add(node.name.text)
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        const family = inventoryFamilyOf(checker, checker.getTypeAtLocation(node.expression))
        if (family !== undefined) reads.get(family)!.add(node.argumentExpression.text)
      } else if (ts.isSpreadElement(node)) {
        const family = inventoryFamilyOf(checker, checker.getTypeAtLocation(node.expression))
        if (family !== undefined) reads.get(family)!.add('*')
      }
      ts.forEachChild(node, (child) => visit(child, insideProjection))
    }
    visit(source)
  }
  return reads
}

describe('RFC-199 validation-context semantic source ratchet', () => {
  test('all typed validator and delegated port reads are projected', () => {
    const program = compilerProgram()
    const sources = discoverSemanticSources(program)
    expect(
      sources.map((source) => relative(REPO_ROOT, source.fileName)),
      'A new helper receiving inventory resources needs explicit source-boundary review',
    ).toEqual([
      'packages/backend/src/services/workflow.validator.ts',
      'packages/shared/src/nodePorts.ts',
      'packages/shared/src/wrapperFanout.ts',
    ])

    const reads = semanticFieldReads(program, sources)
    expect(
      Object.fromEntries([...reads].map(([family, fields]) => [family, [...fields].sort()])),
    ).toEqual({
      agent: [
        'dependsOn',
        'name',
        'outputKinds',
        'outputWrapperPortNames',
        'outputs',
        'plugins',
        'role',
        'skills',
      ],
      skill: ['name'],
      plugin: ['enabled', 'name'],
    })

    const projected = projectWorkflowValidationContext(fixtureContext())
    const projectionFields = new Map<InventoryFamily, Set<string>>([
      ['agent', new Set(Object.keys(projected.agents[0]!))],
      ['skill', new Set(Object.keys(projected.skills[0]!))],
      ['plugin', new Set(Object.keys(projected.plugins[0]!))],
    ])
    for (const [family, fields] of reads) {
      const missing = [...fields].filter((field) => !projectionFields.get(family)!.has(field))
      expect(
        missing,
        `${family} semantic reads missing from validation-context projection`,
      ).toEqual([])
    }
  }, 20_000)

  test('projection keeps prompt, secret configuration and runtime paths out', () => {
    const projection = canonicalJson(projectWorkflowValidationContext(fixtureContext()))
    for (const forbidden of [
      'bodyMd',
      'permission',
      'frontmatterExtra',
      'managedPath',
      'cachedPath',
      'spec',
      'options',
      'SECRET PROMPT',
      '/secret/skill/path',
    ]) {
      expect(projection).not.toContain(forbidden)
    }
  })
})
