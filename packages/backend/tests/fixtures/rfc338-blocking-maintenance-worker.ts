import { Database } from 'bun:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

declare const self: Worker

self.onmessage = (event: MessageEvent<{ root: string; durationMs: number }>) => {
  const { root, durationMs } = event.data
  const db = new Database(join(root, 'worker.sqlite'))
  const file = join(root, 'worker-payload.txt')
  db.exec(
    "CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO probe(value) VALUES ('x');",
  )
  writeFileSync(file, 'maintenance-worker-probe')
  postMessage({ type: 'started', at: Date.now() })

  const waitCell = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + durationMs
  let slices = 0
  while (Date.now() < deadline) {
    db.query('SELECT count(*) AS n FROM probe').get()
    readFileSync(file)
    slices += 1
    // Synchronously hold this Worker for the whole fixture window without
    // saturating a CPU core and turning shared-runner load into test noise.
    Atomics.wait(waitCell, 0, 0, 5)
  }
  db.close()
  postMessage({ type: 'done', at: Date.now(), slices })
}
