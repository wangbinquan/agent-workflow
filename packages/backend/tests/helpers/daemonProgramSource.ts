// RFC-379: source locks inspect real implementation records and the canonical program.
import { expect } from 'bun:test'
import ts from 'typescript'
import { DAEMON_BOOT_STEPS, type DaemonBootStepId } from '../../src/cli/daemonLifecycleProgram'

export function expectBootOrder(ids: readonly DaemonBootStepId[]): void {
  let previous = -1
  for (const id of ids) {
    const at = DAEMON_BOOT_STEPS.findIndex((step) => step.id === id)
    expect(at, `missing or unordered step ${id}`).toBeGreaterThan(previous)
    previous = at
  }
}
export function propertyBodies(source: string, name: string): string[] {
  const file = ts.createSourceFile(
    'root.ts',
    source.trimStart().startsWith('{') ? `const record = ${source}` : source,
    ts.ScriptTarget.Latest,
    true,
  )
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name)) &&
      node.name.text === name
    )
      found.push(node.initializer.getText(file))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}
export function bootImplementation(source: string, name: DaemonBootStepId): string {
  const found = propertyBodies(source, name).filter((value) => value !== 'NotApplicable')
  expect(found, `implementation for ${name}`).toHaveLength(1)
  return found[0]!
}
export function bootDeclaration(id: DaemonBootStepId) {
  const declaration = DAEMON_BOOT_STEPS.find((step) => step.id === id)
  expect(declaration).toBeDefined()
  return declaration!
}
