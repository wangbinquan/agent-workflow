// RFC-398 T9 / §7.5 negative proof 3: autoEpochMigration=false preserves manual-mode start refusal and guidance.
import { setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readRegistry } from '../../../scripts/release-upgrade/lib/io'
import { buildReleaseHome } from './helpers/releaseUpgrade/build'
import { sourceCli } from './helpers/releaseUpgrade/daemon'
import { equal, invariant } from './helpers/releaseUpgrade/data'
import { epochOperations } from './helpers/releaseUpgrade/upgrade'

setDefaultTimeout(120_000)
test('manual start refuses the built v0.19.2 source and creates no operation', async () => {
  const built = await buildReleaseHome(
    readRegistry().releases.find((r) => r.tag === 'v0.19.2')!,
    'sqlite',
  )
  const configPath = join(built.home, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      ...(JSON.parse(readFileSync(configPath, 'utf8')) as object),
      autoEpochMigration: false,
    }),
  )
  const bytes = readFileSync(built.sourcePath),
    child = sourceCli(built, ['start', '--host', '127.0.0.1', '--port', '0'])
  const timer = setTimeout(() => child.process.kill('SIGKILL'), 60_000)
  try {
    equal(await child.exited, 1, `manual refusal\n${child.output}`)
    invariant(
      child.output.includes('db migration plan'),
      'manual refusal omitted existing migration guidance',
    )
    equal(epochOperations(built.home), [], 'manual refusal created no conversion')
    equal(
      existsSync(join(built.home, 'database-generation.json')),
      false,
      'manual refusal created no pointer',
    )
    equal(readFileSync(built.sourcePath), bytes, 'manual refusal changed source')
  } finally {
    clearTimeout(timer)
    child.process.kill('SIGKILL')
    await child.exited
    await built.close()
  }
})
