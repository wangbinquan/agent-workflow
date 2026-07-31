import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC_ROOT = resolve(import.meta.dir, '..', 'src')
const source = (path: string): string => readFileSync(join(SRC_ROOT, path), 'utf8')

function allProductionTypeScript(): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
      } else if (entry.endsWith('.ts')) {
        files.push({ path: relative(SRC_ROOT, path), text: readFileSync(path, 'utf8') })
      }
    }
  }
  walk(SRC_ROOT)
  return files
}

describe('RFC-233 containment architecture source guard', () => {
  test('production has no module-global provider or legacy admission writer', () => {
    const offenders = allProductionTypeScript()
      .filter(
        ({ text }) =>
          /\b(?:getSandboxProvider|setSandboxProvider|admitRuntimeContainment|inspectRuntimeContainment)\b/.test(
            text,
          ) || text.includes('execution-identity-sandbox-required'),
      )
      .map(({ path }) => path)

    expect(offenders).toEqual([])
  })

  test('OpenCode core consumes a prepared plan and cannot rediscover platform/provider truth', () => {
    const consumers = [
      'services/runtime/opencode/containment.ts',
      'services/runtime/opencode/verifiedPlan.ts',
      'services/runtime/opencode/verifiedPlanCore.ts',
      'services/runtime/opencode/verifiedSystemPlan.ts',
    ]
    for (const path of consumers) {
      const text = source(path)
      expect(text).not.toContain('process.platform')
      expect(text).not.toContain('probeSandboxMechanism')
      expect(text).not.toContain('requireRootOwnedBwrap')
      expect(text).not.toContain('admitRuntimeContainment')
    }
    expect(source('services/runtime/opencode/verifiedPlanCore.ts')).toContain(
      'admission: RuntimeContainmentAdmission',
    )
  })

  test('the coordinator is runtime-agnostic and exact built-ins live in one composition root', () => {
    const coordinator = source('services/sandbox/containmentCoordinator.ts')
    expect(coordinator).not.toContain('runtime/opencode')
    expect(coordinator).not.toContain("profileId === 'opencode'")

    const composition = source('services/containmentComposition.ts')
    expect(composition).toContain('requireRootOwnedBwrap')
    expect(composition).toContain("qualifyBwrap('filesystem'")
    expect(composition).toContain("qualifyBwrap('full'")

    for (const path of ['cli/start.ts', 'cli/sandbox.ts', 'cli/doctor.ts']) {
      expect(source(path)).toContain('createBuiltinContainmentCoordinator')
    }
    for (const path of [
      'services/runner.ts',
      'services/runtimeSmoke.ts',
      'services/memoryDistiller.ts',
    ]) {
      const text = source(path)
      expect(text).toContain('containmentCoordinator')
      expect(text).not.toContain('getSandboxStatus')
      expect(text).not.toContain('getSandboxProvider')
      expect(text).not.toContain(
        'sandboxTopology: plan.sandboxTopology ?? preparedContainment.spawnTopology',
      )
      expect(text).not.toContain(
        'sandboxTopology: plan.sandboxTopology ?? input.containment.spawnTopology',
      )
      expect(text).toMatch(/sandboxTopology:\s*(?:\w+\.)+spawnTopology/)
    }
  })

  test('config update linearizes policy only after persistence and all scheduler spawns receive the authority', () => {
    const configRoute = source('routes/config.ts')
    expect(configRoute.indexOf('applyConfigPatch(')).toBeGreaterThanOrEqual(0)
    expect(configRoute.indexOf('containmentCoordinator?.setMode(')).toBeGreaterThan(
      configRoute.indexOf('applyConfigPatch('),
    )

    const scheduler = source('services/scheduler.ts')
    const runNodeCalls = scheduler.match(/\bawait runNode\(\{/g) ?? []
    const coordinatorInjections =
      scheduler.match(
        /\{ containmentCoordinator: (?:opts|state\.opts)\.containmentCoordinator \}/g,
      ) ?? []
    expect(runNodeCalls).toHaveLength(6)
    // RFC-242: the call node's child-deps assembly (buildChildDeps) threads
    // the SAME daemon authority into the child task's runTask — a 7th
    // injection site without a runNode call of its own (the child's nodes
    // spawn through their own runTask → runNode chain).
    expect(coordinatorInjections).toHaveLength(runNodeCalls.length + 1)
  })
})
