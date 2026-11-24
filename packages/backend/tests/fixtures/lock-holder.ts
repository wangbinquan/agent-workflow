// Test fixture: takes a lock at the given path and waits forever.
// Used by tests/lock.test.ts to verify cross-process lock contention.

import { acquireLock } from '../../src/platform/execution/local/daemonLock'

const path = process.argv[2]
if (!path) {
  console.error('usage: lock-holder.ts <lock-path>')
  process.exit(2)
}

const lock = acquireLock(path)
// Signal readiness on stdout; the parent test reads stdout to know when to attempt acquire.
process.stdout.write(`ready pid=${lock.pid}\n`)

// Hold indefinitely until killed. setInterval keeps the event loop alive.
setInterval(() => {
  /* heartbeat */
}, 1_000_000)
