import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..', '..', '..')
const productionPackages = ['backend', 'frontend', 'shared']
const packageName = '@agent-workflow/system-mocks'

interface PackageManifest {
  private?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

describe('test-only package boundary', () => {
  test('the mock suite is private and only a root development dependency', () => {
    const mockManifest = manifestAt(join(repoRoot, 'packages', 'system-mocks'))
    const rootManifest = manifestAt(repoRoot)

    expect(mockManifest.private).toBe(true)
    expect(rootManifest.devDependencies?.[packageName]).toBe('workspace:*')
    expect(rootManifest.dependencies?.[packageName]).toBeUndefined()
    expect(rootManifest.optionalDependencies?.[packageName]).toBeUndefined()
    expect(rootManifest.peerDependencies?.[packageName]).toBeUndefined()
  })

  test('production package manifests and source graphs never name the mock package', () => {
    for (const name of productionPackages) {
      const root = join(repoRoot, 'packages', name)
      const manifest = readFileSync(join(root, 'package.json'), 'utf8')
      expect(manifest).not.toContain(packageName)
      for (const path of sourceFiles(join(root, 'src'))) {
        expect(readFileSync(path, 'utf8')).not.toContain(packageName)
      }
    }
  })

  test('the dependency graph rejects package-name and relative-path imports into mocks', () => {
    const config = readFileSync(join(repoRoot, '.dependency-cruiser.cjs'), 'utf8')
    expect(config).toContain("name: 'no-production-to-system-mocks'")
    expect(config).toContain("from: { path: '^packages/(backend|frontend|shared)/src/' }")
    expect(config).toContain("to: { path: '^packages/system-mocks/' }")
  })
})

function manifestAt(root: string): PackageManifest {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageManifest
}

function sourceFiles(root: string): string[] {
  const files: string[] = []
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.shift()!
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) queue.push(path)
      else if (entry.isFile() && /\.(?:ts|tsx|js|mjs)$/.test(entry.name)) files.push(path)
    }
  }
  return files
}
