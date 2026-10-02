import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DaemonStartupLease } from '../src/modules/system-operations/composition'
import { createNativeDaemonStartupLease } from '../src/modules/system-operations/infrastructure/local/nativeDaemonStartupLease'
import {
  createDaemonLockProof,
  createDaemonRecoveryAuthorityProof,
} from '../src/modules/task-execution/composition/bootRecovery'

const roots: string[] = []
const leases: DaemonStartupLease[] = []
afterEach(() => {
  for (const lease of leases.splice(0).reverse()) lease.releaseOnExit()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(maxWaitMs = 0) {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc370-startup-lease-'))
  roots.push(root)
  const lockPath = join(root, 'daemon.lock')
  const messages: string[] = []
  const provider = createNativeDaemonStartupLease({
    lockPath,
    controlPath: join(root, 'daemon.control'),
    maxWaitMs,
    log: {
      info(message) {
        messages.push(message)
      },
      error(message) {
        throw new Error('unexpected native startup refusal: ' + message)
      },
    },
  })
  return { root, lockPath, messages, provider }
}

test('native PID file and recovery digest retain the exact standalone representation', async () => {
  const f = fixture()
  const lease = await f.provider.acquire()
  leases.push(lease)
  expect(readFileSync(f.lockPath, 'utf8')).toBe(String(process.pid))
  expect(lease.diagnostics).toEqual({ pid: process.pid, lock: f.lockPath })
  const receipt = await lease.recoveryAuthority({
    daemonGeneration: 'original-generation',
    now: 42,
  })
  const proof = createDaemonRecoveryAuthorityProof(receipt)
  const original = createDaemonLockProof({
    lockPath: f.lockPath,
    lockPid: process.pid,
    daemonGeneration: 'original-generation',
    now: 42,
  })
  expect(proof.daemonGeneration).toBe(original.daemonGeneration)
  expect(proof.acquiredAt).toBe(original.acquiredAt)
  expect(proof.lockReceiptDigest).toBe(original.lockReceiptDigest)
  await lease.release()
  expect(existsSync(f.lockPath)).toBe(false)
  await lease.release()
  lease.releaseOnExit()
  expect(existsSync(f.lockPath)).toBe(false)
}, 20_000)

test('explicit dev handoff still adopts the current process lock and reports that action', async () => {
  const f = fixture(5_000)
  const old = await f.provider.acquire()
  leases.push(old)
  const successor = await f.provider.acquire()
  leases.push(successor)
  expect(successor.diagnostics).toEqual(old.diagnostics)
  expect(readFileSync(f.lockPath, 'utf8')).toBe(String(process.pid))
  expect(f.messages).toEqual(['adopted current-process lock for Bun watch generation'])
  await successor.release()
  expect(existsSync(f.lockPath)).toBe(false)
}, 20_000)
