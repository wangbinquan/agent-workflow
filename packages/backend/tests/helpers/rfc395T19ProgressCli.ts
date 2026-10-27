// Child-process fixture: use the real CLI renderer and synchronous stderr writer.
import { writeSync } from 'node:fs'
import { epochMigrationCommand } from '@/cli/epochMigration'
import type { EpochSwitchApplication } from '@/modules/system-operations/public/commands'
import { createMigrationProgressReporter } from '@/platform/persistence/migration/run/progress'

const progress = process.argv.includes('--progress')
  ? createMigrationProgressReporter(
      (line) => {
        writeSync(2, line)
      },
      { now: () => 1000 },
    )
  : undefined
const application = new Proxy({} as EpochSwitchApplication, {
  get(_object, method) {
    return async () => {
      progress?.({
        phase: method === 'verify' ? 'validation' : 'conversion',
        detail: String(method),
        completed: 3,
        boundary: true,
      })
      return { method, result: 'unchanged', count: 3 }
    }
  },
})
for (const verb of ['plan', 'run', 'verify']) {
  const result = await epochMigrationCommand(
    [verb, ...(verb === 'plan' ? [] : ['operation']), '--json'],
    { application },
  )
  if (result.status !== 'ok') throw new Error(result.output)
  writeSync(1, result.output + '\n')
}
