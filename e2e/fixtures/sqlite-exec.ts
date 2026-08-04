#!/usr/bin/env bun
// RFC-254 T29 — fixture SQL executor, run as a Bun CHILD of the Node test process.
//
// Playwright loads `e2e/*.ts` under Node, where the `bun:` module scheme does
// not exist: importing `bun:sqlite` there fails the whole suite at LOAD time
// with "Only URLs with a scheme in: file, data, and node are supported"
// (commit 86ebbf2d took every e2e shard down that way). Bun's embedded SQLite
// is still the right engine — the `sqlite3` CLI is absent from the
// windows-latest image and its default `busy_timeout = 0` caused a real nightly
// flake against the live daemon's write lock — so it runs over here instead,
// one process boundary away.
//
// Usage:
//   bun run sqlite-exec.ts exec  <db-path>            SQL on stdin, no output
//   bun run sqlite-exec.ts query <db-path> [params…]  SQL on stdin, rows as JSON

import { Database } from 'bun:sqlite'

// Matches the daemon's own connection (packages/backend/src/db/client.ts) so a
// fixture write that overlaps a daemon write waits instead of failing instantly
// with "database is locked (5)".
const SQLITE_BUSY_TIMEOUT_MS = 10_000

const [mode, dbPath, ...params] = process.argv.slice(2)
if (dbPath === undefined || dbPath.length === 0 || (mode !== 'exec' && mode !== 'query')) {
  process.stderr.write('sqlite-exec: usage: (exec|query) <db-path> [params…]\n')
  process.exit(2)
}

const sql = await Bun.stdin.text()

// `readwrite` without `create`: the database must already exist. A fixture that
// silently created an empty one would plant its state nowhere and still pass.
const db = new Database(dbPath, { readwrite: true })
try {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`)
  if (mode === 'exec') {
    db.exec(sql)
  } else {
    process.stdout.write(`${JSON.stringify(db.query(sql).all(...params))}\n`)
  }
} finally {
  db.close()
}
