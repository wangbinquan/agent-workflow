// RFC-224 T25 — source reachability ratchet.
//
// A generic Bun.spawn is allowed to execute a RuntimeDriver SpawnPlan. What is
// forbidden is a second OpenCode argv/config assembler that can route around
// the official snapshot + verified launcher boundary.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC_ROOT = resolve(import.meta.dir, '..', 'src')

function source(path: string): string {
  return readFileSync(join(SRC_ROOT, path), 'utf8')
}

function allTypeScriptSources(): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = []
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (statSync(path).isDirectory()) {
        walk(path)
      } else if (name.endsWith('.ts')) {
        files.push({ path: relative(SRC_ROOT, path), text: readFileSync(path, 'utf8') })
      }
    }
  }
  walk(SRC_ROOT)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

describe('RFC-224 verified OpenCode source reachability', () => {
  test('runner, distiller, and smoke execute only driver-produced plans', () => {
    const executors = [
      ['services/runner.ts', 'driver.buildBusinessSpawn({'],
      ['services/memoryDistiller.ts', 'driver.buildSpawn({'],
      ['services/runtimeSmoke.ts', 'getRuntimeDriver(protocol).buildSpawn({'],
    ] as const

    for (const [path, builder] of executors) {
      const text = source(path)
      expect(text).toContain(builder)
      expect(text).toContain('Bun.spawn({')
      expect(text).not.toMatch(
        /from\s+['"][^'"]*services\/runtime\/opencode\/(?:spawn|verifiedLauncher)['"]/,
      )
      expect(text).not.toMatch(/\bbuildOpencodeSpawn\s*\(/)
      expect(text).not.toMatch(/['"]serve['"]\s*,/)
    }
  })

  test('system entrypoints convert verified launcher stderr into identity outcomes', () => {
    const distiller = source('services/memoryDistiller.ts')
    expect(distiller).toContain('parseExecutionIdentityFailureOutput(stderr)')
    expect(distiller).toContain('throw new ExecutionIdentityFailure(launcherFailure)')

    const smoke = source('services/runtimeSmoke.ts')
    expect(smoke).toContain('parseExecutionIdentityFailureOutput(stderrText)')
    expect(smoke).toContain("outcome: 'execution-identity-failed'")
    expect(smoke).toContain('failureCode: launcherFailure')
  })

  test('boot recovery consumes only the fail-closed orphan-reap capability before HTTP', () => {
    const start = source('cli/start.ts')
    const reap = start.indexOf('await reapOrphanRunsForStoreRecovery(db, lock)')
    const capabilityBinding = start.lastIndexOf('const { reap, priorDaemonSandboxDead }', reap)
    const recover = start.indexOf('await recoverOpencodeStoresOnBoot({', reap)
    const http = start.indexOf('const app = createApp', recover)
    expect(reap).toBeGreaterThan(-1)
    expect(recover).toBeGreaterThan(reap)
    expect(http).toBeGreaterThan(recover)
    expect(capabilityBinding).toBeGreaterThan(-1)
    expect(start.slice(capabilityBinding, recover)).not.toContain('catch')
    expect(start.slice(capabilityBinding, recover)).toContain('priorDaemonSandboxDead')

    const orphans = source('services/orphans.ts')
    expect(orphans).toContain("killOutcome === 'kill-failed'")
    expect(orphans).toContain('throw new Error(')
    expect(orphans).toContain('issuePriorDaemonSandboxDeadCapability(currentDaemonLock)')
  })

  test('the legacy run builder is reachable only behind the driver test seams', () => {
    const files = allTypeScriptSources()
    const callOrDefinition = files
      .filter(({ text }) => /\bbuildOpencodeSpawn\s*\(/.test(text))
      .map(({ path }) => path)
    expect(callOrDefinition).toEqual([
      'services/runtime/opencode/driver.ts',
      'services/runtime/opencode/spawn.ts',
    ])

    const driver = source('services/runtime/opencode/driver.ts')
    // RFC-234: the system gate mirrors the business `usesLegacyTestOpencodePath`
    // shape — explicit test flag OR an UNBRANDED injected command (branding is
    // compiled out only in unit tests / the e2e binary; production commands are
    // marked at the config boundary, so this cannot widen a production escape).
    expect(driver).toContain('const legacyTestPath =')
    expect(driver).toContain('ctx.testOnlyUnverifiedRuntime === true ||')
    expect(driver).toContain(
      '(ctx.opencodeCmd !== undefined && !isProductionOpencodeCommand(ctx.opencodeCmd))',
    )
    expect(driver).toContain('if (!legacyTestPath) {')
    expect(driver).toContain('return buildVerifiedOpencodeSystemPlan(ctx, head)')
    expect(driver).toContain('if (!usesLegacyTestOpencodePath(ctx)) {')
    expect(driver).toContain(
      "return buildVerifiedOpencodeBusinessPlan(ctx, businessHead ?? ['opencode'])",
    )

    const seamFiles = files
      .filter(({ text }) => text.includes('testOnlyUnverifiedRuntime'))
      .map(({ path }) => path)
    expect(seamFiles).toEqual([
      'services/changeNarrative.ts',
      'services/runner.ts',
      // RFC-237: the claude declared-control branch skips its binary seal
      // behind the SAME explicit seam (mock-binary tests only; production
      // callers never set it), mirroring opencode's legacy-spawn gate.
      'services/runtime/claudeCode/driver.ts',
      'services/runtime/opencode/driver.ts',
      'services/runtime/opencode/verifiedPlan.ts',
      'services/runtime/types.ts',
      'services/runtimeSmoke.ts',
      // RFC-234: runSystemAgent forwards the seam flag exactly like
      // runtimeSmoke (mock-binary tests only; production callers never set it —
      // the intent turn engine does not reference the seam at all).
      'services/systemAgentRun.ts',
    ])
  })

  test('opencode serve has one production argv owner: the verified launcher', () => {
    const owners = allTypeScriptSources()
      .filter(({ text }) => /['"]serve['"]\s*,/.test(text))
      .map(({ path }) => path)
    expect(owners).toEqual(['services/runtime/opencode/verifiedLauncher.ts'])

    const launcher = source('services/runtime/opencode/verifiedLauncher.ts')
    expect(launcher).toContain('await verifySnapshot(manifest.binaryPath')
    expect(launcher.indexOf('await verifySnapshot(manifest.binaryPath')).toBeLessThan(
      launcher.indexOf("manifest.binaryPath,\n        'serve'"),
    )
  })

  test('business and system invocations share one verified admission builder', () => {
    const files = allTypeScriptSources()
    const business = source('services/runtime/opencode/verifiedPlan.ts')
    const system = source('services/runtime/opencode/verifiedSystemPlan.ts')
    const core = source('services/runtime/opencode/verifiedPlanCore.ts')

    const callSites = (pattern: RegExp) =>
      files.filter(({ text }) => pattern.test(text)).map(({ path }) => path)
    expect(callSites(/\bbuildVerifiedOpencodePlan\s*\(/)).toEqual([
      'services/runtime/opencode/verifiedMcpTestPlan.ts',
      'services/runtime/opencode/verifiedPlan.ts',
      'services/runtime/opencode/verifiedPlanCore.ts',
      'services/runtime/opencode/verifiedSystemPlan.ts',
    ])
    expect(callSites(/\bprepareHermeticOpencodeLayout\s*\(/)).toEqual([
      'services/runtime/opencode/hermetic.ts',
      'services/runtime/opencode/verifiedPlanCore.ts',
    ])
    expect(callSites(/\bmaterializeFffCapabilityProbe\s*\(/)).toEqual([
      'services/runtime/opencode/fffCapability.ts',
      'services/runtime/opencode/verifiedPlanCore.ts',
    ])
    // RFC-237: the seal implementation moved VERBATIM to the runtime-neutral
    // binarySnapshot module (runtimeBinary.ts is a legacy-name re-export). The
    // legacy spelling has ZERO direct call sites; the neutral spelling is
    // callable only from the shared implementation itself and the claude
    // declared-control seal.
    expect(callSites(/\bsnapshotRuntimeOpencodeBinary\s*\(/)).toEqual([])
    expect(callSites(/\bsnapshotRuntimeBinary\s*\(/)).toEqual([
      'services/runtime/binarySnapshot.ts',
      'services/runtime/claudeCode/driver.ts',
      'services/runtime/claudeCode/mcpTest.ts',
      'services/runtime/mcpTestExecutionMaterial.ts',
    ])

    expect(business).not.toMatch(/\bprepareHermeticOpencodeLayout\s*\(/)
    expect(system).not.toMatch(/\bprepareHermeticOpencodeLayout\s*\(/)
    expect(core).toContain('dependencies.snapshotBinary ?? snapshotRuntimeOpencodeBinary')
    // RFC-233: exact provider qualification moved ahead of the shared
    // OpenCode builder. The core consumes the frozen admission and must never
    // rediscover or requalify bwrap.
    expect(core).toContain('admission: RuntimeContainmentAdmission')
    expect(core).not.toContain('requireRootOwnedBwrap')
  })

  test('model and status diagnostics execute only a byte-frozen runtime snapshot', () => {
    const models = source('routes/runtime.ts')
    expect(models).toContain('withRuntimeOpencodeSnapshot([binary], async (snapshot) =>')
    expect(models).toContain('const result = await driver.listModels(snapshot, {')
    expect(models).toContain('const sourceBefore = await scanOpencodeProjectSurface(cwd)')
    expect(models).toContain('cwd,')
    expect(models).toContain('OPENCODE_TEST_MANAGED_CONFIG_DIR: managedConfig')
    expect(models).toContain('beforeCacheWrite: async () => {')
    expect(models).toContain('assertSourceFingerprintUnchanged(sourceBefore, sourceAfter)')

    const status = source('routes/runtimes.ts')
    expect(status).toContain('withRuntimeOpencodeSnapshot([binary], async (snapshot) =>')
    expect(status).toContain('getRuntimeDriver(row.protocol).probe(snapshot, {')
    expect(status).toContain('isExecutionIdentityFailureCode(error.code)')
    expect(status).toContain(": 'execution-identity-untrusted-binary'")
    expect(status).toContain('incompatibleReason: code')

    // RFC-237: the snapshot-then-verify-then-execute discipline lives in the
    // runtime-neutral module now; the opencode file keeps the legacy names as
    // aliases and delegates its diagnostic helper to the shared one.
    const binarySnapshot = source('services/runtime/binarySnapshot.ts')
    expect(binarySnapshot).toContain('await snapshotRuntimeBinary({ command, snapshotPath })')
    expect(binarySnapshot).toContain('await verifyRuntimeBinarySnapshot(snapshotPath')
    expect(binarySnapshot).toContain('return await callback(snapshotPath, identity)')
    const runtimeBinary = source('services/runtime/opencode/runtimeBinary.ts')
    expect(runtimeBinary).toContain('snapshotRuntimeBinary as snapshotRuntimeOpencodeBinary')
    expect(runtimeBinary).toContain("withRuntimeBinarySnapshot(command, callback, 'opencode')")
  })

  test('config-derived launch heads keep their production provenance brand', () => {
    const utility = source('util/opencode.ts')
    expect(utility).toContain('return markProductionOpencodeCommand([cfg.opencodePath])')

    expect(source('cli/start.ts')).toContain('markProductionOpencodeCommand([config.opencodePath])')
    expect(source('services/autoRepair.ts')).toContain(
      'markProductionOpencodeCommand([cfg.opencodePath])',
    )

    const schedule = source('services/scheduleLaunch.ts')
    expect(schedule).toContain("import { resolveOpencodeCmd } from '@/util/opencode'")
    expect(schedule).toContain('resolveOpencodeCmd(configPath),')
    expect(schedule).toContain('containmentCoordinator,')
  })
})
