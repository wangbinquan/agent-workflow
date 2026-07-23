// RFC-225 — raw workgroup content writes stay behind the version-fenced
// services/workgroups.ts authority. Tests and migrations are out of scope.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')

function walkTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkTsFiles(path))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

function inventory(pattern: RegExp): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const path of walkTsFiles(BACKEND_SRC)) {
    const source = readFileSync(path, 'utf8')
    const file = relative(BACKEND_SRC, path).split(sep).join('/')
    const matches = source.match(pattern)
    if (matches !== null) counts[file] = matches.length
  }
  return counts
}

describe('RFC-225 workgroup writer inventory', () => {
  test('workgroup row insert/update/delete has one production authority', () => {
    expect(inventory(/\.insert\s*\(\s*workgroups\s*\)/g)).toEqual({
      'services/workgroups.ts': 1,
    })
    expect(inventory(/\.update\s*\(\s*workgroups\s*\)/g)).toEqual({
      'services/workgroups.ts': 1,
    })
    expect(inventory(/\.delete\s*\(\s*workgroups\s*\)/g)).toEqual({
      'services/workgroups.ts': 1,
    })
  })

  test('member replacement writes cannot grow a second path', () => {
    expect(inventory(/\.insert\s*\(\s*workgroupMembers\s*\)/g)).toEqual({
      'services/workgroups.ts': 2,
    })
    expect(inventory(/\.delete\s*\(\s*workgroupMembers\s*\)/g)).toEqual({
      'services/workgroups.ts': 1,
    })
    expect(inventory(/\.update\s*\(\s*workgroupMembers\s*\)/g)).toEqual({})
  })
})
