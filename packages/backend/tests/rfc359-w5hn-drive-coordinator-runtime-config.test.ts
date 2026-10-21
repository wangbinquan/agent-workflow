// RFC-359 / RFC-382: the sole session coordinator must project the full live launch configuration, never raw nested settings.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const SRC = resolve(import.meta.dir, '..', 'src')
function carriesConfiguration(source: string, factory: string) {
  return (
    /await taskLaunchConfiguration\.start\(\)/.test(source) &&
    /runtimeConfigOpts\(\{\s*\.\.\.fresh,\s*memoryDistillEnqueuer:/.test(source) &&
    /const live = await options\.runConfiguration\(\)/.test(factory) &&
    /pickInheritableRunConfig\(profile.runConfig.parent\)/.test(factory) &&
    source.includes('const coordinator = coordinatorFactory.session')
  )
}
test('all root callers share one coordinator with the complete live projection', () => {
  for (const root of ['server.ts', 'cli/start.ts', 'cli/postgresqlDaemonApplication.ts']) {
    const source = readFileSync(resolve(SRC, root), 'utf8')
    expect(source.match(/composeDaemonTaskExecutionModules\(/g)).toHaveLength(1)
    expect(source).not.toMatch(/(?:createTaskDriveCoordinator|new DefaultTaskDriveCoordinator)\(/)
  }
  const bundle = readFileSync(resolve(SRC, 'cli/daemonModules/taskExecution.ts'), 'utf8')
  const factory = readFileSync(
    resolve(SRC, 'modules/task-execution/application/drive/taskDriveCoordinatorFactory.ts'),
    'utf8',
  )
  expect(bundle.match(/createTaskDriveCoordinatorFactory\(/g)).toHaveLength(1)
  expect(factory.match(/new DefaultTaskDriveCoordinator\(/g)).toHaveLength(1)
  expect(carriesConfiguration(bundle, factory)).toBe(true)
  expect(carriesConfiguration(bundle.replace('...fresh,', ''), factory)).toBe(false)
  expect(
    carriesConfiguration(bundle.replace('await taskLaunchConfiguration.start()', '{}'), factory),
  ).toBe(false)
})
