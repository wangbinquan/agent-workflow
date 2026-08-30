// RFC-225 / RFC-345 T5-WG — raw workgroup content writes stay behind the two
// exact version-fenced authorities during compatibility cutover: the active
// resource-catalog repository and the legacy facade island. Tests and
// migrations are out of scope; this inventory must shrink when T9 retires the
// remaining legacy consumers.

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
  test('workgroup row insert/update/delete has only the active and compatibility authorities', () => {
    expect(inventory(/\.insert\s*\(\s*workgroups\s*\)/g)).toEqual({
      'modules/resource-catalog/infrastructure/sqliteWorkgroupRepository.ts': 1,
      'services/workgroups.ts': 1,
    })
    expect(inventory(/\.update\s*\(\s*workgroups\s*\)/g)).toEqual({
      'modules/resource-catalog/infrastructure/sqliteWorkgroupRepository.ts': 1,
      'services/workgroups.ts': 1,
    })
    expect(inventory(/\.delete\s*\(\s*workgroups\s*\)/g)).toEqual({
      'modules/resource-catalog/infrastructure/sqliteWorkgroupRepository.ts': 1,
      'services/workgroups.ts': 1,
    })
  })

  test('member replacement writes cannot grow a second path', () => {
    expect(inventory(/\.insert\s*\(\s*workgroupMembers\s*\)/g)).toEqual({
      'modules/resource-catalog/infrastructure/sqliteWorkgroupRepository.ts': 1,
      'services/workgroups.ts': 1,
    })
    expect(inventory(/\.delete\s*\(\s*workgroupMembers\s*\)/g)).toEqual({
      'modules/resource-catalog/infrastructure/sqliteWorkgroupRepository.ts': 1,
      'services/workgroups.ts': 1,
    })
    expect(inventory(/\.update\s*\(\s*workgroupMembers\s*\)/g)).toEqual({})
  })
})
