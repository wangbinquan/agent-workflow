// Test-only preload in the isolated fixture home's bunfig.toml. Both real CLI
// processes inherit that cwd. The start entry and runAutoUpgradeChild are untouched.
// Decorate the real composition ONLY to supply fixture inputs/observe the source;
// native preparation is paused AFTER the real provider/history entry returns.
import { mock } from 'bun:test'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import { supplyMatrixInputs } from './fixtureInputs'
import type { MatrixStartInput } from './startMode'

const inputPath = process.env.AW_RELEASE_UPGRADE_START_INPUT
if (!inputPath) throw new Error('RFC-398 start preload requires independent fixture inputs')
const { built, expected } = deserialize(readFileSync(inputPath)) as MatrixStartInput
if (process.argv.includes('auto')) {
  const composition = await import('@/bootstrap/epochMigration')
  const compose = composition.composeLocalEpochSwitchDependencies
  mock.module('@/bootstrap/epochMigration', () => ({
    ...composition,
    composeLocalEpochSwitchDependencies: (...args: Parameters<typeof compose>) => {
      const epoch = compose(...args)
      supplyMatrixInputs(epoch, built, expected!, (census) => {
        const path = join(built.home, 'matrix-source-census.bin')
        writeFileSync(`${path}.tmp`, serialize(census))
        renameSync(`${path}.tmp`, path)
      })
      return epoch
    },
  }))
} else if (process.argv.includes('start') && built.release.epoch2) {
  const composition = await import('@/modules/system-operations/composition/daemonDatabase')
  const prepare = composition.prepareDaemonDatabaseProviderForBoot
  const { autoUpgradeTestCheckpoint } =
    await import('@/modules/system-operations/infrastructure/local/autoUpgradeTestHooks')
  mock.module('@/modules/system-operations/composition/daemonDatabase', () => ({
    ...composition,
    prepareDaemonDatabaseProviderForBoot: async (...args: Parameters<typeof prepare>) => {
      const prepared = await prepare(...args)
      await autoUpgradeTestCheckpoint('matrix-native-prepared')
      return prepared
    },
  }))
}
