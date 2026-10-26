import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import roles from '../fixtures/rfc395-nonruntime-source-roles.json'
import { sourceUnit } from './census'
import { nonruntimeSourceRole } from './nonruntimeSourceRoles'

const root = resolve(import.meta.dir, '../../../..')
test('every exact non-runtime source role still has its reviewed source and evidence', () => {
  expect(roles.entries).toHaveLength(18)
  expect(new Set(roles.entries.map((entry) => entry.path)).size).toBe(18)
  for (const entry of roles.entries) {
    const text = readFileSync(resolve(root, entry.path), 'utf8')
    const unit = sourceUnit(entry.path, text)
    expect(nonruntimeSourceRole(unit), entry.path).toBe(entry.role)
    expect(entry.evidence.length).toBeGreaterThan(60)
    expect(
      nonruntimeSourceRole(sourceUnit(entry.path, text + '\nreadBusinessRows()')),
    ).toBeUndefined()
    expect(
      nonruntimeSourceRole(sourceUnit(entry.path.replace('.ts', 'Copy.ts'), text)),
    ).toBeUndefined()
    if (entry.role === 'schema-declaration')
      expect(
        unit.source.statements.every(
          (node) => ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined,
        ),
      ).toBe(true)
    if (entry.role === 'frozen-epoch1') expect(entry.path).toContain('/migration/')
    if (entry.role === 'maintenance-command')
      expect(readFileSync(resolve(root, 'packages/backend/package.json'), 'utf8')).toContain(
        entry.path.replace('packages/backend/', ''),
      )
  }
})

test('an unreferenced production implementation does not become test support merely by location', () => {
  expect(
    nonruntimeSourceRole(
      sourceUnit(
        'packages/backend/src/modules/collaboration/infrastructure/fsHumanGateArtifactStore.ts',
        'export function write() {}',
      ),
    ),
  ).toBeUndefined()
})
