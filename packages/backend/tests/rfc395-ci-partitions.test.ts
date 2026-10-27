// RFC-395 CIP-A: file sharding must keep every matrix dimension exactly once.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { EPOCH_SWITCH_PHASES } from '@/modules/system-operations/domain/epochSwitch/model'

function partitions(pattern: RegExp, helper: string): string[] {
  const selected: string[] = []
  for (const name of readdirSync(import.meta.dir).filter((name) => pattern.test(name))) {
    const source = ts.createSourceFile(
      name,
      readFileSync(join(import.meta.dir, name), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const argumentsInFile: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === helper
      ) {
        expect(node.arguments).toHaveLength(1)
        const value = node.arguments[0]!
        expect(ts.isStringLiteral(value)).toBe(true)
        if (ts.isStringLiteral(value)) argumentsInFile.push(value.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(argumentsInFile).toHaveLength(1)
    selected.push(...argumentsInFile)
  }
  return selected.sort()
}
test('Q-3 file partitions cover every durable phase exactly once', () => {
  expect(partitions(/^rfc395-q3-phase-.*\.test\.ts$/, 'describeQ3PhaseBoundary')).toEqual(
    [...EPOCH_SWITCH_PHASES].sort(),
  )
})
test('native and cross-provider switch scenario partitions keep every original journey', () => {
  expect(
    partitions(/^rfc395-v3-switch-(?:.*-)?providers\.test\.ts$/, 'describeV3SwitchJourney'),
  ).toEqual(['activate', 'missing-at-freeze', 'missing-at-plan', 'rollback-before-activation-meta'])
})
