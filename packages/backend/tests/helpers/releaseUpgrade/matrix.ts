// RFC-398 T9: one build/provider per file bounds the §7.8 shard budget without dropping tags.
import { test } from 'bun:test'
import { performance } from 'node:perf_hooks'
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRegistry } from '../../../../../scripts/release-upgrade/lib/io'
import { resolveTestProviders } from '../eachProvider'
import { matrixCases } from './cases'
import { buildReleaseHome, buildExpectedCurrent } from './build'
import { automaticUpgrade, epochOperations, prepareNativeHistory } from './upgrade'
import { checkEpoch1 } from './oracle'
import { checkNativeHistory } from './nativeChecks'
import {
  checkApiExpectations,
  checkDoctor,
  installMockRuntime,
  newTaskToDone,
  startSourceDaemon,
  type MatrixDaemon,
} from './daemon'
import { equal, invariant } from './data'
import { missingAliasProof, missingBridgeProof } from './negative'
import { startUpgradeAndCheck } from './startMode'

export function matrixUpgradeMode(
  value = process.env.AW_RELEASE_UPGRADE_MODE,
): 'in-process' | 'start' {
  invariant(
    value === undefined || value === 'in-process' || value === 'start',
    `unknown L1 upgrade mode: ${value}`,
  )
  return value ?? 'in-process'
}

export function registerMatrixCase(id: (typeof matrixCases)[number]['id']): void {
  const item = matrixCases.find((c) => c.id === id)!
  const enabled = resolveTestProviders(process.env).includes(item.provider)
  const mode = matrixUpgradeMode()
  ;(enabled ? test : test.skip)(
    `RFC-398 ${item.tags.join(', ')} -> ${item.buildKey} / ${item.provider} / ${mode}`,
    async () => {
      const started = performance.now()
      const release = readRegistry().releases.find((r) => r.tag === item.representative)!
      equal(release.buildKey, item.buildKey, 'executed registry build identity')
      const built = await buildReleaseHome(release, item.provider)
      let daemon: MatrixDaemon | undefined
      try {
        let mock: string | undefined
        if (mode === 'start') mock = await installMockRuntime(built, built.before)
        if (release.epoch1) {
          await missingAliasProof(built)
          await missingBridgeProof(built)
          const expected = await buildExpectedCurrent(built)
          if (mode === 'start') daemon = await startUpgradeAndCheck(built, expected)
          else {
            const { census } = await automaticUpgrade(built, expected)
            await checkEpoch1(built, census, await built.snapshotTarget())
          }
        } else {
          if (mode === 'start') daemon = await startUpgradeAndCheck(built)
          else {
            await prepareNativeHistory(built)
            checkNativeHistory(built, await built.snapshotTarget())
          }
        }
        // Both modes finish strict checks before daemon business writes. Start
        // mode releases its real CLI barrier only after those checks succeed.
        const operations = epochOperations(built.home)
        mock ??= await installMockRuntime(built)
        daemon ??= await startSourceDaemon(built)
        await checkApiExpectations(built, daemon)
        const taskId = await newTaskToDone(built, daemon, mock)
        await daemon.stop()
        daemon = undefined
        daemon = await startSourceDaemon(built)
        const task = (await daemon.request(`/api/tasks/${taskId}`)) as { status: string }
        equal(task.status, 'done', 'task remains done after restart')
        await checkApiExpectations(built, daemon)
        await daemon.stop()
        daemon = undefined
        await checkDoctor(built)
        if (release.epoch2) {
          equal(epochOperations(built.home), operations, 'native daemon creates no conversion')
          checkNativeHistoryReceiptsOnly(built, await built.snapshotTarget())
        }
      } catch (error) {
        await daemon?.stop()
        daemon = undefined
        // Preserve the actual failed candidate, including validation receipts,
        // before the isolated fixture cleanup removes the home.
        const evidence = mkdtempSync(join(tmpdir(), `rfc398-failed-${id}-`))
        cpSync(built.home, join(evidence, 'home'), { recursive: true })
        console.error(`RFC-398 failure evidence: ${evidence}`)
        throw error
      } finally {
        await daemon?.stop()
        await built.close()
      }
      invariant(
        performance.now() - started <= 240_000,
        `§7.8 shard exceeded four minutes: ${id}; split additional work, retain this case`,
      )
    },
    240_000,
  )
}
function checkNativeHistoryReceiptsOnly(
  built: Awaited<ReturnType<typeof buildReleaseHome>>,
  snapshot: Awaited<ReturnType<typeof built.snapshotTarget>>,
) {
  equal(
    snapshot.get('aw_meta_migration_operations') ?? [],
    [],
    'native restart created no epoch conversion operation',
  )
}
