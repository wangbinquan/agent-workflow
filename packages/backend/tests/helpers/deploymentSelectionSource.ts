// RFC-394: preserve root-wiring oracles across the shared selection contract and both spreads.
import { expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { DeploymentSelections } from '@/bootstrap/deploymentProfile'

const read = (path: string) =>
  readFileSync(new URL('../../src/bootstrap/' + path, import.meta.url), 'utf8')
export function expectDeploymentSelection(key: keyof DeploymentSelections, type?: string): void {
  const source = ts.createSourceFile(
    'deploymentProfile.ts',
    read('deploymentProfile.ts'),
    ts.ScriptTarget.Latest,
    true,
  )
  const contract = source.statements
    .filter(ts.isInterfaceDeclaration)
    .filter((node) => node.name.text === 'DeploymentSelections')
  expect(contract).toHaveLength(1)
  const field = contract[0]!.members.find((node) => node.name?.getText(source) === key)
  if (!field || !ts.isPropertySignature(field)) throw new Error('missing selection: ' + key)
  expect(field.questionToken).toBeDefined()
  if (type !== undefined)
    expect(field.type?.getText(source).replace(/\s/g, '')).toBe(type.replace(/\s/g, ''))
  for (const [path, name] of [
    ['daemonSessionInput.ts', 'DaemonProviderSessionComposeInput'],
    ['daemonApplication.ts', 'DaemonApplicationInput'],
  ]) {
    const file = ts.createSourceFile(path!, read(path!), ts.ScriptTarget.Latest, true)
    const input = file.statements
      .filter(ts.isInterfaceDeclaration)
      .find((node) => node.name.text === name)
    expect(
      input?.heritageClauses?.flatMap((clause) =>
        clause.types.map((value) => value.expression.getText(file)),
      ),
    ).toEqual(['DeploymentSelections'])
  }
  expect(read('daemonStart.ts')).toContain('...profile.selections,')
  expect(read('daemonSession.ts')).toContain('...deploymentSelectionsOf(input),')
  expect(read('deploymentSelections.ts')).toContain(key + ': true,')
}
