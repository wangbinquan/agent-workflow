import { Database } from 'bun:sqlite'

import { instrumentSlowStatements } from '../../src/db/client'

const sleepWithoutCpu = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const idleSeen: Array<{ ms: number; cpuMs: number }> = []
let sleepMs = 40
const fake = {
  prepare: () => ({
    all: () => {
      sleepWithoutCpu(sleepMs)
      return []
    },
  }),
  query: () => ({ all: () => [] }),
  exec: () => undefined,
}
instrumentSlowStatements(fake as never, 100, (ms, _sql, cpuMs) => idleSeen.push({ ms, cpuMs }))
const runIdle = (): void => {
  ;(fake.prepare as unknown as (sql: string) => { all: () => unknown[] })('SELECT 1').all()
}

// Pay Bun/JIT/getrusage startup costs before the measured window. The warm-up may itself cross the
// slow threshold on a loaded host, so it is deliberately discarded rather than asserted on.
runIdle()
idleSeen.length = 0
sleepMs = 300
runIdle()
if (idleSeen.length !== 1) throw new Error(`idle probe emitted ${idleSeen.length} records`)

const sqlite = new Database(':memory:')
const busySeen: Array<{ ms: number; cpuMs: number }> = []
instrumentSlowStatements(sqlite, 5, (ms, _sql, cpuMs) => busySeen.push({ ms, cpuMs }))
sqlite
  .prepare(
    'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 300000) SELECT count(*) AS n FROM c',
  )
  .all()
sqlite.close()
if (busySeen.length < 1) throw new Error('busy probe emitted no records')

process.stdout.write(JSON.stringify({ idle: idleSeen[0], busy: busySeen[0] }))
