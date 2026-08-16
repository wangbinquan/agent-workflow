import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..', '..', '..')
const productionPackages = ['backend', 'frontend', 'shared']

describe('test-only package boundary', () => {
  test('production package manifests and source graphs never depend on system mocks', () => {
    for (const name of productionPackages) {
      const root = join(repoRoot, 'packages', name)
      const manifest = readFileSync(join(root, 'package.json'), 'utf8')
      expect(manifest).not.toContain('@agent-workflow/system-mocks')
      for (const path of sourceFiles(join(root, 'src'))) {
        expect(readFileSync(path, 'utf8')).not.toContain('@agent-workflow/system-mocks')
      }
    }
  })
})

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
