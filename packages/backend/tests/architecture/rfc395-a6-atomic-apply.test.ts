// RFC-395 II-a A6 — 防止两份状态机、领域反向依赖和异常驱动的旧格式回落重新出现。
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { DAEMON_BOOT_STEPS } from '@/bootstrap/daemonLifecycleProgram'
const root = join(import.meta.dir, '../../src')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const mechanismFiles = [
  ...readdirSync(join(root, 'platform/atomic-apply'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `platform/atomic-apply/${name}`),
  'platform/contracts/atomicApply.ts',
]

function mechanismViolations(files: Readonly<Record<string, string>>) {
  const violations: string[] = []
  for (const [path, source] of Object.entries(files)) {
    if (
      path.startsWith('platform/atomic-apply/') &&
      /(?:from|import\s*\()\s*['"][^'"]*(?:modules|services)\//.test(source)
    )
      violations.push('mechanism depends on scene')
    if (path.endsWith('ApplyEngine.ts') || path.endsWith('PackageAtomicApply.ts')) {
      if (!source.includes('createAtomicApply(')) violations.push('scene bypasses mechanism')
      if (/state:\s*['"](?:prepared|applying|committed|failed)['"]/.test(source))
        violations.push('scene writes lifecycle')
    }
    if (path.endsWith('resourcePackageMaintenance.ts') && /instanceof ZodError/.test(source))
      violations.push('error-driven codec fallback')
  }
  return violations
}

function calls(source: string, name: string): ts.CallExpression[] {
  const unit = ts.createSourceFile('graph.ts', source, ts.ScriptTarget.Latest, true)
  const found: ts.CallExpression[] = []
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(unit)
  return found
}

describe('RFC-395 II-a A6 one AtomicApply mechanism', () => {
  test('both production scenes delegate all lifecycle transitions to platform', () => {
    expect(mechanismFiles.length).toBeGreaterThanOrEqual(6)
    const paths = [
      'modules/intent/infrastructure/intentApplyEngine.ts',
      'modules/resource-catalog/infrastructure/resourcePackageAtomicApply.ts',
      'modules/resource-catalog/composition/resourcePackageMaintenance.ts',
      ...mechanismFiles,
    ]
    expect(
      mechanismViolations(Object.fromEntries(paths.map((path) => [path, read(path)]))),
    ).toEqual([])
    const machine = read('platform/atomic-apply/stateMachine.ts')
    expect(machine).toContain("'prepared',")
    expect(machine).toContain("'applying',")
    expect(machine).toContain('command.commit(tx, journalId, prepared)')
    for (const adapter of [
      'modules/intent/infrastructure/intentApplyJournal.ts',
      'modules/resource-catalog/infrastructure/resourcePackageAtomicJournal.ts',
    ])
      expect(read(adapter)).toContain('.onConflictDoNothing()')
  })
  test('former wiring is rejected without shrinking the guard', () => {
    expect(
      mechanismViolations({
        'platform/atomic-apply/engine.ts':
          "import { scene } from '@/modules/intent/infrastructure/engine'",
      }),
    ).toEqual(['mechanism depends on scene'])
    expect(
      mechanismViolations({
        'modules/intent/infrastructure/intentApplyEngine.ts': "state: 'committed'",
      }),
    ).toEqual(['scene bypasses mechanism', 'scene writes lifecycle'])
    expect(
      mechanismViolations({
        'modules/resource-catalog/composition/resourcePackageMaintenance.ts':
          'error instanceof ZodError',
      }),
    ).toEqual(['error-driven codec fallback'])
  })
  test('one maintenance entry registers both scenes and keeps normal skill-operation recovery ahead of availability and convergence', () => {
    const graph = read('bootstrap/maintenanceWorkerGraph.ts')
    expect(
      calls(graph + '\ncreateAtomicApplyRecovery([])', 'createAtomicApplyRecovery'),
    ).toHaveLength(2)
    const registry = calls(graph, 'createAtomicApplyRecovery')
    expect(registry).toHaveLength(1)
    expect(calls(graph, 'composeIntentApplyRecoveryScene')).toHaveLength(1)
    const scenes = registry[0]!.arguments[0]!
    expect(ts.isArrayLiteralExpression(scenes)).toBe(true)
    if (!ts.isArrayLiteralExpression(scenes)) throw new Error('registry must register scene array')
    expect(scenes.elements).toHaveLength(2)
    expect(
      scenes.elements.map((node) =>
        ts.isCallExpression(node) ? node.expression.getText() : node.getText(),
      ),
    ).toEqual(['composeIntentApplyRecoveryScene', 'resourcePackageRecoveryScene'])
    expect(read('modules/intent/public/commands.ts')).not.toContain('activeBundleApplyIds')
    expect(read('platform/background/maintenanceJobRunner.ts')).toContain("case 'intentRecovery'")
    const steps = DAEMON_BOOT_STEPS.map((step) => step.id)
    expect(steps.filter((id) => id === 'skill-operation-recovery')).toHaveLength(1)
    expect(steps.filter((id) => id === 'maintenance-boot-snapshot')).toHaveLength(1)
    expect(DAEMON_BOOT_STEPS.find((step) => step.id === 'skill-operation-recovery')).toMatchObject({
      phase: 'prepare',
      failure: 'fail-closed',
    })
    expect(steps.indexOf('skill-operation-recovery')).toBeLessThan(
      steps.indexOf('skill-availability-gate'),
    )
    expect(steps.indexOf('skill-operation-recovery')).toBeLessThan(
      steps.indexOf('maintenance-boot-snapshot'),
    )
  })
})
