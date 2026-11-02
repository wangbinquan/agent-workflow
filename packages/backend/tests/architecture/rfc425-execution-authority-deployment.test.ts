// RFC-425: the execution authority answers whether this instance may execute; the deployment kind and the SPA marker
// come from the deployment profile. This lock pins that split: the port declares no `mode`, no authority-shaped object
// literal anywhere in src writes one, server.ts takes the deployment kind and the marker from its own required values,
// the daemon session gives the lifecycle program the profile's kind, the embedded SPA marker is injected without
// comparing deployment literals, and each profile states its marker.
// Reads the production sources without importing them.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const PORT = PREFIX + 'modules/system-operations/application/ports/executionAuthority.ts'
const SERVER = PREFIX + 'server.ts'
const EMBED = PREFIX + 'embed.ts'
const STANDALONE = PREFIX + 'bootstrap/standalone.ts'
const CREWSTATION = PREFIX + 'bootstrap/crewstation.ts'
const SESSION = PREFIX + 'bootstrap/daemonSession.ts'
const DEPLOYMENT_LITERALS = new Set(['standalone', 'crewstation'])
const AUTHORITY_MEMBERS = ['current', 'whenActive', 'onLost']
const UNITS = backendUnits(ROOT)

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (node.name === undefined) return null
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null
}

function stringLiteral(node: ts.Node): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null
}

export function deploymentSplitViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  for (const unit of units) {
    if (!unit.path.startsWith(PREFIX)) continue
    walk(unit.source, (node) => {
      if (
        unit.path === PORT &&
        ts.isInterfaceDeclaration(node) &&
        node.name.text === 'ExecutionAuthorityPort' &&
        node.members.some((member) => member.name?.getText(unit.source) === 'mode')
      )
        found.push('port-declares-mode')
      if (ts.isObjectLiteralExpression(node)) {
        const names = node.properties.map(propertyName)
        if (AUTHORITY_MEMBERS.every((member) => names.includes(member)) && names.includes('mode'))
          found.push('authority-mode:' + unit.path)
      }
      if (
        unit.path === SERVER &&
        ts.isPropertyAccessExpression(node) &&
        node.name.text === 'mode' &&
        /executionAuthority$/.test(node.expression.getText(unit.source))
      )
        found.push('server-reads-authority-mode')
      if (
        unit.path === EMBED &&
        ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(node.operatorToken.kind) &&
        [node.left, node.right].some((side) => DEPLOYMENT_LITERALS.has(stringLiteral(side) ?? ''))
      )
        found.push('embed-compares-deployment')
    })
  }
  const server = byPath.get(SERVER)?.text ?? ''
  if (!server.includes('executionStatusOf(deps.executionAuthority, deps.deploymentKind)'))
    found.push('server-status-without-deployment-kind')
  if (!server.includes('frontendMarker: deps.frontendMarker'))
    found.push('server-marker-not-required-value')
  if (!/profile:\s*input\.deploymentKind,/.test(byPath.get(SESSION)?.text ?? ''))
    found.push('session-lifecycle-without-deployment-kind')
  if (!/frontendMarker:\s*null,/.test(byPath.get(STANDALONE)?.text ?? ''))
    found.push('standalone-profile-marker')
  if (!/frontendMarker:\s*'crewstation',/.test(byPath.get(CREWSTATION)?.text ?? ''))
    found.push('crewstation-profile-marker')
  return found.sort()
}

test('live corpus: the authority carries no deployment kind and the profile supplies it', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  expect(deploymentSplitViolations(UNITS)).toEqual([])
})

test('negative fixtures: each re-coupling of the deployment kind to the authority is reported', () => {
  const replace = (path: string, text: string) => [
    ...UNITS.filter((unit) => unit.path !== path),
    sourceUnit(path, text),
  ]
  const portUnit = UNITS.find((unit) => unit.path === PORT)!
  const serverUnit = UNITS.find((unit) => unit.path === SERVER)!
  const embedUnit = UNITS.find((unit) => unit.path === EMBED)!
  const sessionUnit = UNITS.find((unit) => unit.path === SESSION)!
  expect(
    deploymentSplitViolations(
      replace(
        SESSION,
        sessionUnit.text.replace(
          'profile: input.deploymentKind,',
          'profile: input.executionAuthority?.mode,',
        ),
      ),
    ),
  ).toEqual(['session-lifecycle-without-deployment-kind'])
  expect(
    deploymentSplitViolations(
      replace(
        PORT,
        portUnit.text.replace(
          'export interface ExecutionAuthorityPort {',
          "export interface ExecutionAuthorityPort {\n  readonly mode: 'standalone' | 'crewstation'",
        ),
      ),
    ),
  ).toContain('port-declares-mode')
  const fabricated = PREFIX + 'modules/system-operations/infrastructure/fabricated.ts'
  expect(
    deploymentSplitViolations([
      ...UNITS,
      sourceUnit(
        fabricated,
        "export const a = { mode: 'crewstation', current: () => s, whenActive: () => p, onLost: () => () => {} }",
      ),
    ]),
  ).toContain('authority-mode:' + fabricated)
  const rewired = serverUnit.text.replace(
    'executionStatusOf(deps.executionAuthority, deps.deploymentKind)',
    'executionStatusOf(deps.executionAuthority, deps.executionAuthority.mode)',
  )
  expect(deploymentSplitViolations(replace(SERVER, rewired))).toEqual([
    'server-reads-authority-mode',
    'server-status-without-deployment-kind',
  ])
  expect(
    deploymentSplitViolations(
      replace(
        SERVER,
        serverUnit.text.replace('frontendMarker: deps.frontendMarker', 'frontendMarker: null'),
      ),
    ),
  ).toEqual(['server-marker-not-required-value'])
  expect(
    deploymentSplitViolations(
      replace(
        EMBED,
        embedUnit.text + "\nexport const hosted = (d: string) => d !== 'standalone'\n",
      ),
    ),
  ).toEqual(['embed-compares-deployment'])
  expect(deploymentSplitViolations(UNITS.filter((unit) => unit.path !== STANDALONE))).toEqual([
    'standalone-profile-marker',
  ])
  expect(deploymentSplitViolations(UNITS.filter((unit) => unit.path !== CREWSTATION))).toEqual([
    'crewstation-profile-marker',
  ])
})

test('negative fixtures over fabricated units alone: every matcher still bites', () => {
  const only = (path: string, text: string) => deploymentSplitViolations([sourceUnit(path, text)])
  expect(
    only(PORT, "export interface ExecutionAuthorityPort {\n  readonly mode: 'standalone'\n}"),
  ).toContain('port-declares-mode')
  const fabricated = PREFIX + 'modules/system-operations/infrastructure/fabricated.ts'
  expect(
    only(
      fabricated,
      "export const a = { mode: 'standalone', current: () => s, whenActive: () => p, onLost: () => () => {} }",
    ),
  ).toContain('authority-mode:' + fabricated)
  expect(only(SERVER, 'export const kind = deps.executionAuthority.mode')).toContain(
    'server-reads-authority-mode',
  )
  expect(only(EMBED, "export const hosted = (d: string) => d === 'crewstation'")).toContain(
    'embed-compares-deployment',
  )
  expect(only(STANDALONE, "export const profile = { frontendMarker: 'standalone', }")).toContain(
    'standalone-profile-marker',
  )
  expect(
    only(SESSION, 'composeDaemonLifecycle({ profile: input.executionAuthority?.mode, })'),
  ).toContain('session-lifecycle-without-deployment-kind')
})
