// RFC-428: four deployment selections that no deployment ever set — or set and never had read — are retired:
// `databasePreOpenRecovery`, `nodeRunPromptContentEffects`, `portArtifactContentEffects`, `startupLease`
// (inventory: design/RFC-428-dead-deployment-selections/inventory.md). This lock keeps them out of the selection
// contract and its forwarding table, and keeps the startup lease composition free of a selected provider.
// Reads the production sources without importing them.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const PROFILE = PREFIX + 'bootstrap/deploymentProfile.ts'
const KEYS = PREFIX + 'bootstrap/deploymentSelections.ts'
const SYSTEM_OPERATIONS = PREFIX + 'modules/system-operations/composition.ts'
const RETIRED = [
  'databasePreOpenRecovery',
  'nodeRunPromptContentEffects',
  'portArtifactContentEffects',
  'startupLease',
  // RFC-429: the evidence group is derived from (or shadowed by) evidenceArtifacts.
  'attemptContext',
  'evidenceDocumentCommands',
  'evidenceRead',
  'missionInputBlobs',
  // RFC-430: derivable (or a stateless equivalent) — skillContent.packageContent, actionWorkspaceEffects.contents.
  'automationWorkspaceEffects',
  'historyRestrictions',
  'resourcePackageSkillContent',
]
const UNITS = backendUnits(ROOT)

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

export function retiredSelectionViolations(units: readonly SourceUnit[]): string[] {
  const found = new Set<string>()
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const profile = byPath.get(PROFILE)
  if (profile !== undefined)
    walk(profile.source, (node) => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'DeploymentSelections')
        for (const member of node.members) {
          const name = member.name?.getText(profile.source)
          if (name !== undefined && RETIRED.includes(name)) found.add('selection:' + name)
        }
    })
  const keys = byPath.get(KEYS)
  if (keys !== undefined)
    walk(keys.source, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(keys.source) === 'DEPLOYMENT_SELECTION_KEYS'
      )
        walk(node, (inner) => {
          if (ts.isPropertyAssignment(inner) && RETIRED.includes(inner.name.getText(keys.source)))
            found.add('key:' + inner.name.getText(keys.source))
        })
    })
  const operations = byPath.get(SYSTEM_OPERATIONS)
  if (operations !== undefined)
    walk(operations.source, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'composeDaemonStartupLease') {
        const [input] = node.parameters
        if (
          input?.type !== undefined &&
          ts.isTypeLiteralNode(input.type) &&
          input.type.members.some(
            (member) => member.name?.getText(operations.source) === 'selected',
          )
        )
          found.add('startup-lease-selected')
      }
    })
  return [...found].sort()
}

test('live corpus: the retired selections stay retired', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  expect(retiredSelectionViolations(UNITS)).toEqual([])
})

test('negative fixtures over the corpus: each way back is reported', () => {
  const replace = (path: string, edit: (text: string) => string) =>
    UNITS.map((unit) => (unit.path === path ? sourceUnit(path, edit(unit.text)) : unit))
  expect(
    retiredSelectionViolations(
      replace(PROFILE, (text) =>
        text.replace(
          'export interface DeploymentSelections {',
          'export interface DeploymentSelections {\n  readonly startupLease?: object',
        ),
      ),
    ),
  ).toEqual(['selection:startupLease'])
  expect(
    retiredSelectionViolations(
      replace(KEYS, (text) =>
        text.replace(
          '  secretBox: true,',
          '  secretBox: true,\n  portArtifactContentEffects: true,',
        ),
      ),
    ),
  ).toEqual(['key:portArtifactContentEffects'])
  expect(
    retiredSelectionViolations(
      replace(SYSTEM_OPERATIONS, (text) =>
        text.replace(
          'export function composeDaemonStartupLease(input: {',
          'export function composeDaemonStartupLease(input: {\n  readonly selected?: object',
        ),
      ),
    ),
  ).toEqual(['startup-lease-selected'])
})

test('negative fixtures over fabricated units alone: every matcher still bites', () => {
  const only = (path: string, text: string) => retiredSelectionViolations([sourceUnit(path, text)])
  expect(
    only(PROFILE, 'export interface DeploymentSelections { databasePreOpenRecovery?: object }'),
  ).toContain('selection:databasePreOpenRecovery')
  expect(
    only(KEYS, 'export const DEPLOYMENT_SELECTION_KEYS = { nodeRunPromptContentEffects: true }'),
  ).toContain('key:nodeRunPromptContentEffects')
  expect(
    only(
      SYSTEM_OPERATIONS,
      'export function composeDaemonStartupLease(input: { selected?: object; local: () => object }) {}',
    ),
  ).toContain('startup-lease-selected')
})
