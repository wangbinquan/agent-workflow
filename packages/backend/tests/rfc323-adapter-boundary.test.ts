// RFC-323 AC-14 — employee-scoped Adapter bindings may cross the Digital
// Employee boundary only as neutral exact refs plus a secret-free consumer
// projection. Adapter tables, executables, connection details and secret
// projection stay owned by Integration.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..', '..', '..')
const backendRoot = join(repoRoot, 'packages', 'backend', 'src')
const employeeRoot = join(backendRoot, 'modules', 'digital-employee')
const platformParticipant = join(
  backendRoot,
  'modules',
  'development-automation',
  'composition',
  'digitalEmployeePlatformWorkItems.ts',
)
const workspaceParticipant = join(
  backendRoot,
  'modules',
  'development-automation',
  'composition',
  'digitalEmployeeWorkspace.ts',
)
const employeeTypePackage = join(
  backendRoot,
  'modules',
  'development-automation',
  'composition',
  'employeeTypePackage.ts',
)
const connectionPort = join(employeeRoot, 'composition', 'required-ports.ts')

function walk(dir: string, output: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, output)
    else if (/\.[cm]?tsx?$/.test(name)) output.push(path)
  }
  return output
}

const importPatterns = [
  /(?:import|export)\s+(?:type\s+)?[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /import\s*['"]([^'"]+)['"]/g,
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function importsOf(source: string): string[] {
  return importPatterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1]!),
  )
}

function codeWithoutCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

describe('RFC-323 employee Adapter ownership boundary', () => {
  test('Digital Employee never imports Integration internals or reads Adapter storage', () => {
    const offenders: string[] = []
    const providerOwnedSymbols = [
      'developmentAdapterDefinitions',
      'developmentAdapterRevisions',
      'createSqliteDevelopmentAdapterStore',
      'executableRef',
      'secretProjection',
    ]
    const files = walk(employeeRoot)
    expect(files.length).toBeGreaterThanOrEqual(10)

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const rel = relative(backendRoot, file).replaceAll('\\', '/')
      for (const specifier of importsOf(source)) {
        if (/^@\/modules\/integration(?:\/|$)/.test(specifier)) {
          offenders.push(`${rel} imports ${specifier}`)
        }
      }
      const code = codeWithoutCommentLines(source)
      for (const symbol of providerOwnedSymbols) {
        if (new RegExp(`\\b${symbol}\\b`).test(code)) offenders.push(`${rel} reads ${symbol}`)
      }
    }

    expect(offenders).toEqual([])
  })

  test('the consumer-owned catalog projection is an exact secret-free field budget', () => {
    const source = readFileSync(connectionPort, 'utf8')
    const body = source.match(/export interface ToolConnectionProjection\s*\{([\s\S]*?)\n\}/)?.[1]
    expect(body).toBeDefined()
    const fields = [...(body ?? '').matchAll(/^\s*readonly\s+(\w+)\??:/gm)]
      .map((match) => match[1]!)
      .sort()
    expect(fields).toEqual([
      'available',
      'closureSummary',
      'contentDigest',
      'purpose',
      'ref',
      'visible',
    ])
    expect(body).not.toMatch(/executable|connectionRef|secret|draftJson|contentJson|DbClient/i)
  })

  test('platform pipeline and approval logic consume ports, never the Adapter store or runner', () => {
    const source = readFileSync(platformParticipant, 'utf8')
    expect(importsOf(source).filter((specifier) => specifier.includes('/integration/'))).toEqual([])
    expect(codeWithoutCommentLines(source)).not.toMatch(
      /developmentAdapterDefinitions|developmentAdapterRevisions|createSqliteDevelopmentAdapterStore|secretProjection|executableRef/,
    )
    expect(source).toContain('readonly pipelineEvidence?: PipelineEvidencePort')
    expect(source).toContain('readonly approvalGateway?: ApprovalGatewayPort')
  })

  test('standard Issue ingress does not allocate an employee Adapter slot or acquisition port', () => {
    const workspace = readFileSync(workspaceParticipant, 'utf8')
    const typePackage = readFileSync(employeeTypePackage, 'utf8')
    expect(typePackage).not.toContain("purpose: 'requirement-source'")
    expect(workspace).not.toMatch(
      /RequirementSourceAcquisitionPort|input\.requirementSource\.acquire|\.adapter-acquisition\.json/,
    )
  })

  test('the import matcher catches static, export-from, dynamic and require edges', () => {
    const fixture =
      "import type { A } from '@/modules/integration/a'\n" +
      "export { b } from '@/modules/integration/b'\n" +
      "import '@/modules/integration/c'\n" +
      "const d = import('@/modules/integration/d')\n" +
      "const e = require('@/modules/integration/e')\n"
    expect(new Set(importsOf(fixture))).toEqual(
      new Set([
        '@/modules/integration/a',
        '@/modules/integration/b',
        '@/modules/integration/c',
        '@/modules/integration/d',
        '@/modules/integration/e',
      ]),
    )
  })
})
