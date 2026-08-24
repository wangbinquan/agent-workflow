import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

const repoRoot = resolve(import.meta.dir, '..', '..', '..')

describe('binary build virtual embed isolation', () => {
  test('injects embed.generated.ts in memory without mutating the watched dev source', () => {
    const source = readFileSync(resolve(repoRoot, 'scripts', 'build-binary.ts'), 'utf8')

    expect(source).toContain('files: { [generatedPath]: input.generatedContents }')
    expect(source).toContain('const generated = renderGenerated()')
    expect(source).not.toMatch(/writeFileSync\s*\(\s*generatedPath/)
  })
})
