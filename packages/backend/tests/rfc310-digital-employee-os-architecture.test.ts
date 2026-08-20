// RFC-310 T143: executable owner/dependency manifest for the two OS contexts.
// RFC-294's global seven-manifest W0-R remains a separate migration wave; this
// vertical-slice manifest prevents the new contexts from adding that debt now.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BACKEND_SRC = join(REPO_ROOT, 'packages', 'backend', 'src')
const MANIFEST_PATH = join(
  REPO_ROOT,
  'design',
  'RFC-310-rule-driven-development-digital-employee',
  'os-architecture-manifest.json',
)

interface ContextManifest {
  readonly owner: string
  readonly topLevelEntries: readonly string[]
  readonly publicEntries: readonly string[]
  readonly externalImports: readonly string[]
}

interface OsArchitectureManifest {
  readonly schemaVersion: 1
  readonly contexts: Readonly<Record<'digital-employee' | 'event-center', ContextManifest>>
  readonly genericTypeLiteralBan: string
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as OsArchitectureManifest

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, out)
    else if (/\.[cm]?tsx?$/.test(name)) out.push(path)
  }
  return out
}

function portable(path: string): string {
  return path.replaceAll('\\', '/')
}

function importSpecifiers(text: string): string[] {
  const values: string[] = []
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) values.push(match[1]!)
  }
  return [...new Set(values)].sort()
}

describe('RFC-310 Digital Employee OS architecture manifest', () => {
  test('new bounded contexts keep their exact owner roots and public entrypoints', () => {
    expect(manifest.schemaVersion).toBe(1)
    for (const [context, entry] of Object.entries(manifest.contexts)) {
      expect(entry.owner.length).toBeGreaterThan(20)
      const root = join(BACKEND_SRC, 'modules', context)
      expect(readdirSync(root).sort()).toEqual([...entry.topLevelEntries].sort())
      expect(readdirSync(join(root, 'public')).sort()).toEqual([...entry.publicEntries].sort())
    }
  })

  test('every external dependency equals the reviewed exact composition/public manifest', () => {
    const files = walk(BACKEND_SRC)
    for (const [context, entry] of Object.entries(manifest.contexts)) {
      const moduleRoot = portable(join(BACKEND_SRC, 'modules', context))
      const prefix = `@/modules/${context}/`
      const actual: string[] = []
      for (const file of files) {
        if (portable(file).startsWith(`${moduleRoot}/`)) continue
        for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
          if (!specifier.startsWith(prefix)) continue
          actual.push(
            `${portable(relative(BACKEND_SRC, file))} -> ${specifier.slice(prefix.length)}`,
          )
        }
      }
      expect(actual.sort()).toEqual([...entry.externalImports].sort())
      expect(
        actual.every((edge) =>
          / -> (?:composition|public\/(?:commands|queries|participants|events|types))$/.test(edge),
        ),
      ).toBe(true)
    }
  })

  test('generic OS core and canvas never branch on the development employee type', () => {
    const genericRoots = [
      join(BACKEND_SRC, 'modules', 'digital-employee'),
      join(BACKEND_SRC, 'modules', 'event-center'),
      join(REPO_ROOT, 'packages', 'frontend', 'src', 'components', 'digital-employees'),
    ]
    const genericRoutes = [
      join(REPO_ROOT, 'packages', 'frontend', 'src', 'routes', 'digital-employees.tsx'),
      join(REPO_ROOT, 'packages', 'frontend', 'src', 'routes', 'digital-employees.$typeRef.tsx'),
      join(REPO_ROOT, 'packages', 'frontend', 'src', 'routes', 'employee-cases.$caseId.tsx'),
      join(REPO_ROOT, 'packages', 'frontend', 'src', 'routes', 'employee-cases.new.tsx'),
    ]
    const files = [...genericRoots.flatMap((root) => walk(root)), ...genericRoutes]
    const literal = new RegExp(`['"]${manifest.genericTypeLiteralBan}['"]`)
    expect(
      files
        .filter((file) => literal.test(readFileSync(file, 'utf8')))
        .map((file) => portable(relative(REPO_ROOT, file))),
    ).toEqual([])
  })
})
