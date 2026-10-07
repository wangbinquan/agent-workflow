import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '@/db/client'
import { originalNativeUsageBaseline } from '@/modules/task-execution/infrastructure/nativeUsageBaselineSnapshot'
import { persistNativeUsagePass } from '@/modules/runtime-management/application/persistNativeUsagePass'
import { originalNativeLedgerFixture } from './rfc371NativeLedgerFixture'
import { MIGRATIONS } from '../migration-freeze'
import type { ProviderHarness } from './eachProvider'

/** Actual original files and Task-owned pages; the fixture does not execute a model. */
export async function originalBaselineWorkerFixture(
  size = 2501,
  harness?: Pick<ProviderHarness, 'db'>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'aw-native-before-worker-')),
    path = join(directory, 'native.db'),
    native = new Database(path)
  let ledger: ReturnType<typeof openDb> | undefined
  try {
    native.exec(
      'PRAGMA journal_mode=WAL;CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER);CREATE INDEX session_parent ON session(parent_id,id);CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);CREATE INDEX part_session ON part(session_id,id);',
    )
    native.run('INSERT INTO session VALUES (?,?,?)', ['root', null, Date.now()])
    native.run('INSERT INTO message VALUES (?,?,?)', [
      'message',
      'root',
      JSON.stringify({ role: 'assistant', providerID: 'actual-provider', modelID: 'actual-model' }),
    ])
    const step = (n: number) => 'step-' + String(n).padStart(8, '0')
    const add = (from: number, through: number) =>
      native.transaction(() => {
        for (let n = from; n < through; n++)
          native.run('INSERT INTO part VALUES (?,?,?,?,?)', [
            step(n),
            'root',
            'message',
            Date.now(),
            JSON.stringify({
              type: 'step-finish',
              tokens: { input: n + 1, output: 5, reasoning: 0, cache: { read: 7, write: 11 } },
            }),
          ])
      })()
    add(0, size)
    if (!harness)
      ledger = openDb({
        path: join(directory, 'original-task-ledger.db'),
        migrationsFolder: MIGRATIONS,
      })
    const f = await originalNativeLedgerFixture(harness ?? { db: ledger! }, 'resume', false)
    await persistNativeUsagePass(f.open(path, f.identity('baseline'), 31), f.owner())
    const original = await originalNativeUsageBaseline({
      db: f.db,
      binding: f.binding,
      before: f.before,
    })
    if (!original) throw new Error('Actual original baseline is unavailable')
    return {
      f,
      original,
      path,
      step,
      add,
      ledger,
      readBinding: {
        taskId: f.binding.taskId,
        nodeRunId: f.binding.nodeRunId,
        invocationId: f.binding.invocationId,
      },
      close() {
        native.close()
        ledger?.$client.close()
        rmSync(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    native.close()
    ledger?.$client.close()
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
