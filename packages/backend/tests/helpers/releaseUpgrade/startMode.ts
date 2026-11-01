// RFC-398 §7.3 nightly: real start -> db migration auto child, then the SAME
// strict oracle before any daemon business writes, then A1 on that same daemon.
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import { readAutoUpgradeSessions } from '@/modules/system-operations/infrastructure/local/autoUpgradeState'
import { parseEpochSwitchJournal } from '@/modules/system-operations/domain/epochSwitch/model'
import type { BuiltRelease } from './build'
import type { SourceCensus } from './source'
import { checkEpoch1 } from './oracle'
import { checkNativeHistory } from './nativeChecks'
import { startSourceDaemon, type sourceCli } from './daemon'
import { equal, invariant, type Snapshot } from './data'
import { epochOperations } from './upgrade'

export interface MatrixStartInput {
  built: Pick<BuiltRelease, 'home' | 'release' | 'provider' | 'before' | 'seeds' | 'contract'>
  expected?: { rows: Snapshot }
}
interface Event {
  point: string
  pid: number
  parent: number
}

async function reached(
  hooks: string,
  point: string,
  child: ReturnType<typeof sourceCli>,
): Promise<Event[]> {
  return new Promise((resolve, reject) => {
    let settled = false
    const watcher = watch(hooks, inspect)
    // macOS may notify before the append completes; no busy polling of a child.
    const fallback = setInterval(inspect, 200)
    const deadline = setTimeout(
      () => finish(new Error(`start barrier ${point} timed out\n${child.output}`)),
      180_000,
    )
    function finish(error: Error | null, events?: Event[]) {
      if (settled) return
      settled = true
      watcher.close()
      clearInterval(fallback)
      clearTimeout(deadline)
      if (error) reject(error)
      else resolve(events!)
    }
    function inspect() {
      try {
        const path = join(hooks, 'events.jsonl')
        if (!existsSync(path)) return
        const events = readFileSync(path, 'utf8')
          .split('\n')
          .slice(0, -1)
          .map((line) => JSON.parse(line) as Event)
        if (events.some((e) => e.point === point)) finish(null, events)
      } catch (error) {
        finish(error as Error)
      }
    }
    void child.exited.then(
      (code) => finish(new Error(`start exited ${code} before ${point}\n${child.output}`)),
      (error) => finish(error as Error),
    )
    inspect()
  })
}

export async function startUpgradeAndCheck(built: BuiltRelease, expected?: { rows: Snapshot }) {
  const hooks = join(built.home, 'matrix-start-hooks')
  mkdirSync(hooks)
  const point = built.release.epoch1 ? 'completed' : 'matrix-native-prepared'
  writeFileSync(join(hooks, 'barriers.json'), JSON.stringify([point]))
  const input: MatrixStartInput = {
    built: {
      home: built.home,
      release: built.release,
      provider: built.provider,
      before: built.before,
      seeds: built.seeds,
      contract: built.contract,
    },
    expected,
  }
  built.env.AGENT_WORKFLOW_TEST_EPOCH_UPGRADE = hooks
  built.env.AW_RELEASE_UPGRADE_START_INPUT = join(built.home, 'matrix-start-input.bin')
  writeFileSync(built.env.AW_RELEASE_UPGRADE_START_INPUT, serialize(input))
  writeFileSync(
    join(built.home, 'bunfig.toml'),
    `preload = [${JSON.stringify(join(import.meta.dir, 'startPreload.ts'))}]\n`,
  )
  const initial = epochOperations(built.home)
  try {
    return await startSourceDaemon(built, {
      cwd: built.home,
      async beforeReady(child) {
        try {
          const events = await reached(hooks, point, child)
          invariant(
            !existsSync(join(built.home, '.daemon.info')),
            'strict checks must precede daemon readiness/writes',
          )
          if (built.release.epoch1) {
            const delegated = events.filter((e) => e.point === 'delegated')
            equal(delegated.length, 1, 'start delegates to exactly one production auto child')
            equal(
              delegated[0]!.parent,
              child.process.pid,
              'auto child belongs to this start process',
            )
            invariant(delegated[0]!.pid !== child.process.pid, 'auto upgrade must run in a child')
            equal(
              events.find((e) => e.point === point)!.pid,
              delegated[0]!.pid,
              'real auto child completed',
            )
            const sessions = readAutoUpgradeSessions(built.home)
            equal(sessions.length, 1, 'start completed one automatic session')
            equal(sessions[0]!.outcome, 'completed', 'automatic session completed')
            const journal = parseEpochSwitchJournal(
              readFileSync(
                join(
                  built.home,
                  'database-migrations',
                  sessions[0]!.operationId,
                  'epoch-switch.json',
                ),
                'utf8',
              ),
            )
            equal(journal.payload.phase, 'verified', 'start upgrade verified before strict checks')
            const census = deserialize(
              readFileSync(join(built.home, 'matrix-source-census.bin')),
            ) as SourceCensus
            await checkEpoch1(built, census, await built.snapshotTarget())
          } else {
            equal(
              events.filter((e) => e.point === 'delegated'),
              [],
              'native start creates no auto child',
            )
            equal(
              events.find((e) => e.point === point)!.pid,
              child.process.pid,
              'native history prepared by real start',
            )
            equal(epochOperations(built.home), initial, 'native start creates no conversion')
            checkNativeHistory(built, await built.snapshotTarget())
          }
          console.info(
            `RFC-398 start strict checks passed before daemon writes: ${built.release.tag}/${built.provider}`,
          )
        } finally {
          // Also unblock failures before startSourceDaemon terminates its parent.
          writeFileSync(join(hooks, `${point}.release`), '')
        }
      },
    })
  } finally {
    delete built.env.AGENT_WORKFLOW_TEST_EPOCH_UPGRADE
    delete built.env.AW_RELEASE_UPGRADE_START_INPUT
  }
}
