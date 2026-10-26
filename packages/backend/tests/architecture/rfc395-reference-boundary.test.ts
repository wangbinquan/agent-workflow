// RFC-395 F: ordered relations and parser-owned indexes replace JSON reference storage.
// Keep all former writer/delete boundaries and negative controls.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../src')
const catalog = 'modules/resource-catalog/infrastructure/'
const agentWriters = [
  'agentRepository.ts',
  'digitalEmployeeAgentTemplateCatalog.ts',
  'demoResourceCatalogSeed.ts',
  'fusionResourceSeed.ts',
  'aggregateAdapters/intentApplyResourcePorts.ts',
  'aggregateAdapters/postgresqlResourcePackageMutationArms.ts',
]
const workflowWriters = [
  'workflowRepository.ts',
  'demoResourceCatalogSeed.ts',
  'fusionResourceSeed.ts',
  'legacy/workflow.ts',
  'aggregateAdapters/intentApplyResourcePorts.ts',
  'aggregateAdapters/postgresqlResourcePackageMutationArms.ts',
]
const lookups = [
  'mcpRepository.ts',
  'pluginRepository.ts',
  'agentPersistenceSemantics.ts',
  'workflowPersistenceSemantics.ts',
  'legacy/skill.ts',
  'legacy/skillDeleteOp.ts',
]
function bypasses(source: string, kind: 'agent' | 'workflow' | 'lookup'): boolean {
  if (kind === 'lookup')
    return /\blike\s*\(\s*agents\.|JSON\.parse\(row\.(?:dependsOn|definition)\)/.test(source)
  if (kind === 'workflow')
    return /\.(?:insert|update)\(workflows\)|insertOne\([^,]+,\s*workflows/.test(source)
  return (
    /\.insert\(agents\)|insertOne\([^,]+,\s*agents|updateAgentPersistenceValues\(/.test(source) ||
    /\.update\(agents\)\s*\.set\(\{[^}]*\b(?:skills|dependsOn|mcp|plugins)\s*:/.test(source)
  )
}
function preparesUpdateBeforeTransaction(source: string): boolean {
  const start = source.indexOf('async update(authority, id, submitted, fence)')
  if (start < 0) return false
  const body = source.slice(start, source.indexOf('async delete(', start))
  const prepare = body.indexOf('prepareAgentReferenceUpdate(')
  return prepare >= 0 && body.indexOf('runResourceCatalogTransaction(') > prepare
}
function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8')
}

describe('RFC-395 F target reference boundaries', () => {
  test('all six agent writers and workflow writers delegate their original transaction', () => {
    expect(new Set([...agentWriters, ...workflowWriters, ...lookups]).size).toBeGreaterThanOrEqual(
      12,
    )
    for (const file of agentWriters) {
      const source = read(catalog + file)
      expect(source, file).toContain('createAgentReferenceWriteParticipant(')
      expect(bypasses(source, 'agent'), file).toBe(false)
    }
    for (const file of workflowWriters) {
      const source = read(catalog + file)
      expect(source, file).toContain('createWorkflowDefinitionWriteParticipant(')
      expect(bypasses(source, 'workflow'), file).toBe(false)
    }
    expect(preparesUpdateBeforeTransaction(read(catalog + 'agentRepository.ts'))).toBe(true)
    expect(read(catalog + 'fusionResourceSeed.ts')).toContain('runResourceCatalogTransaction(')
    const fusion = read('modules/knowledge-evolution/infrastructure/fusionRepository.ts')
    expect(fusion).toContain(
      'input.resourceSeed.seed(seed, { repair: repairFusionWorkflowDefinition })',
    )
    expect(fusion).not.toMatch(
      /\.(?:insert|update)\((?:agents|workflows)\)|insertOne\([^,]+,\s*(?:agents|workflows)/,
    )
  })
  test('reverse scans stay in the relation adapters and both delete phases keep their lookup', () => {
    for (const file of lookups) expect(bypasses(read(catalog + file), 'lookup'), file).toBe(false)
    for (const [file, factory, mutation] of [
      ['mcpRepository.ts', 'createAgentMcpReferenceLookup', 'mutation'],
      ['pluginRepository.ts', 'createAgentPluginReferenceLookup', 'deletion'],
    ] as const) {
      const source = read(catalog + file)
      expect(source).toContain(`${factory}(transaction).find(${mutation}.id)`)
      expect(source.match(new RegExp(`${factory}\\(`, 'g'))).toHaveLength(2)
    }
    expect(read(catalog + 'legacy/skill.ts')).toContain(
      'createAgentSkillReferenceLookup(db).find(skillId)',
    )
    expect(read(catalog + 'legacy/skillDeleteOp.ts')).toContain(
      'createAgentSkillReferenceLookup(tx).find(skillId)',
    )
    expect(
      read('modules/resource-catalog/application/agents/agentDependencyValidation.ts'),
    ).not.toContain('JSON.parse')
  })
  test('runtime readers and writers use target relations and the shared parser index', () => {
    const reader = read(catalog + 'agentPersistence.ts')
    const writer = read(catalog + 'agentReferenceWrite.ts')
    for (const table of [
      'agentSkillRefs',
      'agentMcpRefs',
      'agentPluginRefs',
      'agentDependencies',
    ]) {
      expect(reader).toContain(table)
      expect(writer).toContain(`transaction.insert(${table})`)
      expect(writer).toContain(`transaction.delete(${table})`)
    }
    expect(reader).toContain('orderBy(asc(agentSkillRefs.ordinal))')
    expect(reader).not.toMatch(/decodeAgentSkillReferences|row\.(?:skills|dependsOn|mcp|plugins)\b/)
    const lookup = read(catalog + 'referenceLookup.ts')
    expect(lookup).not.toMatch(
      /\blike\s*\(|\bLIKE\b|JSON\.parse|decodeWorkflowReferenceDocument|matchesStoredAgentReference/,
    )
    expect(lookup).toContain('exists(')
    expect(lookup).toContain('eq(index.revision, workflows.version)')
    expect(lookup).toContain("kind === 'agent' ? 'id' : 'name'")
    const workflow = read(catalog + 'workflowDefinitionWrite.ts')
    expect(workflow).toContain('workflowDependencyIndexEntries(')
    expect(workflow).toMatch(/transaction\s*\.delete\(workflowDependencyIndex\)/)
    expect(workflow).toMatch(/transaction\s*\.insert\(workflowDependencyIndex\)/)
    expect(read(catalog + 'migration/workflowDocument.ts')).toContain(
      'workflowDependencyIndexEntries(',
    )
    const publicSource = read('modules/resource-catalog/public/participants.ts')
    const boot = publicSource.slice(
      publicSource.indexOf('export interface SkillCatalogBootParticipant'),
      publicSource.indexOf('export interface DemoResourceCatalogSeedMarkerContext'),
    )
    expect(boot).toContain('recoverOperations()')
    expect(boot).not.toMatch(/runIdentityMigrationBarrier|backfillLegacyVersions/)
  })
  test('negative controls catch each retired boundary and accept participant calls', () => {
    expect(
      preparesUpdateBeforeTransaction(
        'async update(authority, id, submitted, fence) { prepareAgentReferenceUpdate(input); runResourceCatalogTransaction(db); } async delete(',
      ),
    ).toBe(true)
    expect(
      preparesUpdateBeforeTransaction(
        'async update(authority, id, submitted, fence) { runResourceCatalogTransaction(db); prepareAgentReferenceUpdate(input); } async delete(',
      ),
    ).toBe(false)
    expect(bypasses('await tx.insert(agents).values(values)', 'agent')).toBe(true)
    expect(bypasses('await tx.update(agents).set({ skills: raw })', 'agent')).toBe(true)
    expect(bypasses('await tx.update(agents).set({ name: newName })', 'agent')).toBe(false)
    expect(bypasses('await tx.update(workflows).set({ definition })', 'workflow')).toBe(true)
    expect(bypasses('like(agents.mcp, pattern)', 'lookup')).toBe(true)
    expect(bypasses('JSON.parse(row.dependsOn)', 'lookup')).toBe(true)
    expect(bypasses('await createAgentReferenceWriteParticipant(tx).insert(input)', 'agent')).toBe(
      false,
    )
    expect(
      bypasses('await createWorkflowDefinitionWriteParticipant(tx).update(input)', 'workflow'),
    ).toBe(false)
  })
})
