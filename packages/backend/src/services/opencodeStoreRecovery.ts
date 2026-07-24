// RFC-224 T5/T14/T21 — prior-daemon OpenCode store recovery and retention GC.
//
// Every verified launcher is owned by the daemon's platform containment
// provider/process group. At boot the daemon already owns the single-instance
// lock and `reapOrphanRuns` has killed/reaped the persisted outer group. Only
// then may this barrier remove the exact fsynced store lock, scrub account
// state, and repair the session lease by its session/run/nonce triple.

import { eq } from 'drizzle-orm'
import { lstat, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { TERMINAL_NODE_RUN_STATUSES } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRuns, opencodeSessionOwners } from '@/db/schema'
import {
  consumePriorDaemonSandboxDeadCapability,
  type PriorDaemonSandboxDeadCapability,
} from '@/services/orphans'
import { repairOpencodeSessionLease } from '@/services/opencodeSessionOwner'
import { executionIdentityFailure } from '@/services/runtime/opencode/failure'
import {
  deriveHermeticOpencodeLayout,
  removeHermeticOpencodeLayout,
} from '@/services/runtime/opencode/hermetic'
import {
  acquireOpencodeStoreLifecycleLock,
  inspectAbandonedOpencodeStoreLock,
  removeAbandonedOpencodeStoreLock,
  scrubOpencodeStoreAccountState,
  type AbandonedOpencodeStoreLock,
} from '@/services/runtime/opencode/storeHygiene'

const BUSINESS_KEY_RE = /^b_[A-Za-z0-9_-]{43}$/
const SYSTEM_KEY_RE = /^s_[A-Za-z0-9_-]{43}$/
const TERMINAL_NODE_RUN_STATUS_SET: ReadonlySet<string> = new Set(TERMINAL_NODE_RUN_STATUSES)
const HOUR_MS = 60 * 60 * 1000

export const OPENCODE_STORE_ORPHAN_MIN_AGE_MS = 24 * HOUR_MS

interface StoreDirectory {
  key: string
  root: string
  dbPath: string
}

interface RecoveryRun {
  id: string
  status: string
  pid: number | null
  spawnBinaryPath: string | null
}

export interface OpencodeStoreRecoveryDependencies {
  outerProcessGroupDead?: (run: RecoveryRun) => boolean
}

export interface OpencodeStoreRecoveryReport {
  businessStoresScanned: number
  systemStoresScanned: number
  leasesRepaired: number
  storesScrubbed: number
  storesRemoved: number
}

function unsafe(): never {
  return executionIdentityFailure('execution-identity-store-unsafe')
}

function storeRoots(appHome: string): { business: string; system: string } {
  if (
    !isAbsolute(appHome) ||
    resolve(appHome) !== appHome ||
    appHome.includes('\0') ||
    appHome === resolve(appHome, '..')
  ) {
    unsafe()
  }
  const base = join(appHome, 'opencode-stores')
  return {
    business: join(base, 'business'),
    system: join(base, 'system-ephemeral'),
  }
}

async function listStoreDirectories(root: string, keyPattern: RegExp): Promise<StoreDirectory[]> {
  const rootMetadata = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (rootMetadata === null) return []
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) unsafe()
  const entries = await readdir(root, { withFileTypes: true })
  const stores: StoreDirectory[] = []
  for (const entry of entries) {
    if (!keyPattern.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) unsafe()
    const storeRoot = join(root, entry.name)
    const metadata = await lstat(storeRoot)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) unsafe()
    stores.push({
      key: entry.name,
      root: storeRoot,
      dbPath: deriveHermeticOpencodeLayout(storeRoot).sessionDbPath,
    })
  }
  return stores.sort((left, right) => left.key.localeCompare(right.key))
}

function defaultOuterProcessGroupDead(run: RecoveryRun): boolean {
  if (
    !Number.isSafeInteger(run.pid) ||
    (run.pid as number) <= 0 ||
    typeof run.spawnBinaryPath !== 'string' ||
    run.spawnBinaryPath.length === 0
  ) {
    return false
  }
  try {
    process.kill(-(run.pid as number), 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function assertPriorOuterGroupDead(input: {
  db: DbClient
  nodeRunId: string
  outerProcessGroupDead: (run: RecoveryRun) => boolean
}): Promise<RecoveryRun> {
  const run = await input.db
    .select({
      id: nodeRuns.id,
      status: nodeRuns.status,
      pid: nodeRuns.pid,
      spawnBinaryPath: nodeRuns.spawnBinaryPath,
    })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, input.nodeRunId))
    .get()
  if (
    run === undefined ||
    !TERMINAL_NODE_RUN_STATUS_SET.has(run.status) ||
    typeof run.spawnBinaryPath !== 'string' ||
    !isAbsolute(run.spawnBinaryPath) ||
    resolve(run.spawnBinaryPath) !== run.spawnBinaryPath ||
    !input.outerProcessGroupDead(run)
  ) {
    unsafe()
  }
  return run
}

async function removePriorLock(
  store: StoreDirectory,
  lock: AbandonedOpencodeStoreLock,
): Promise<void> {
  const removed = await removeAbandonedOpencodeStoreLock({
    dbPath: store.dbPath,
    expectedNonceDigest: lock.nonceDigest,
    expectedServer: lock.server,
    outerSandboxProcessGroupDead: true,
  })
  if (!removed) unsafe()
}

async function scrubRecoveredBusinessStore(store: StoreDirectory): Promise<void> {
  const lock = await acquireOpencodeStoreLifecycleLock(store.dbPath)
  try {
    await scrubOpencodeStoreAccountState({
      dbPath: store.dbPath,
      kind: 'existing',
      lock,
    })
  } finally {
    await lock.release()
  }
}

/**
 * Boot barrier. Call exactly once after orphan reap and before auto-resume,
 * schedulers, workers, or HTTP. `priorDaemonSandboxDead` is an opaque, one-shot
 * capability minted only by a successful orphan reap while the new daemon's
 * single-instance lock is live.
 */
export async function recoverOpencodeStoresOnBoot(input: {
  db: DbClient
  appHome: string
  priorDaemonSandboxDead: PriorDaemonSandboxDeadCapability
  dependencies?: OpencodeStoreRecoveryDependencies
}): Promise<OpencodeStoreRecoveryReport> {
  if (!consumePriorDaemonSandboxDeadCapability(input.priorDaemonSandboxDead)) unsafe()
  const roots = storeRoots(input.appHome)
  const [businessStores, systemStores] = await Promise.all([
    listStoreDirectories(roots.business, BUSINESS_KEY_RE),
    listStoreDirectories(roots.system, SYSTEM_KEY_RE),
  ])
  const report: OpencodeStoreRecoveryReport = {
    businessStoresScanned: businessStores.length,
    systemStoresScanned: systemStores.length,
    leasesRepaired: 0,
    storesScrubbed: 0,
    storesRemoved: 0,
  }
  if (businessStores.length === 0 && systemStores.length === 0) return report
  const outerProcessGroupDead =
    input.dependencies?.outerProcessGroupDead ?? defaultOuterProcessGroupDead
  for (const store of businessStores) {
    const owner = await input.db
      .select()
      .from(opencodeSessionOwners)
      .where(eq(opencodeSessionOwners.sessionStoreKey, store.key))
      .get()
    const abandonedLock = await inspectAbandonedOpencodeStoreLock(store.dbPath)

    if (owner === undefined) {
      if (abandonedLock?.server !== null && abandonedLock?.server !== undefined) {
        const server = abandonedLock.server
        if (
          server.scope.kind !== 'business' ||
          server.scope.mode !== 'new' ||
          server.sessionStoreKey !== store.key
        ) {
          unsafe()
        }
        await assertPriorOuterGroupDead({
          db: input.db,
          nodeRunId: server.scope.nodeRunId,
          outerProcessGroupDead,
        })
      }
      if (abandonedLock !== null) await removePriorLock(store, abandonedLock)
      await removeHermeticOpencodeLayout(store.root)
      report.storesRemoved += 1
      continue
    }

    if (owner.sessionStoreKey !== store.key) {
      unsafe()
    }
    if (abandonedLock !== null) {
      const server = abandonedLock.server
      if (server !== null) {
        if (
          server.scope.kind !== 'business' ||
          server.sessionStoreKey !== store.key ||
          server.runtimeBinaryDigest !== owner.runtimeBinaryDigest
        ) {
          unsafe()
        }
        await assertPriorOuterGroupDead({
          db: input.db,
          nodeRunId: server.scope.nodeRunId,
          outerProcessGroupDead,
        })
        if (
          owner.leaseNodeRunId !== null &&
          (owner.leaseNodeRunId !== server.scope.nodeRunId ||
            owner.leaseNonceDigest !== abandonedLock.nonceDigest)
        ) {
          unsafe()
        }
      }
      await removePriorLock(store, abandonedLock)
    }

    if (owner.leaseNodeRunId !== null) {
      if (owner.leaseNonceDigest === null || owner.leasedAt === null) unsafe()
      await assertPriorOuterGroupDead({
        db: input.db,
        nodeRunId: owner.leaseNodeRunId,
        outerProcessGroupDead,
      })
    }

    if (abandonedLock !== null || owner.leaseNodeRunId !== null) {
      await scrubRecoveredBusinessStore(store)
      report.storesScrubbed += 1
    }
    if (owner.leaseNodeRunId !== null) {
      const repaired = repairOpencodeSessionLease(input.db, {
        sessionId: owner.sessionId,
        nodeRunId: owner.leaseNodeRunId,
        leaseNonceDigest: owner.leaseNonceDigest as string,
        processGroupDead: true,
      })
      if (!repaired) unsafe()
      report.leasesRepaired += 1
    }
  }

  for (const store of systemStores) {
    const abandonedLock = await inspectAbandonedOpencodeStoreLock(store.dbPath)
    if (abandonedLock?.server !== null && abandonedLock?.server !== undefined) {
      const server = abandonedLock.server
      if (
        server.scope.kind !== 'system-ephemeral' ||
        server.scope.invocationId !== store.key ||
        server.sessionStoreKey !== store.key
      ) {
        unsafe()
      }
    }
    if (abandonedLock !== null) await removePriorLock(store, abandonedLock)
    await removeHermeticOpencodeLayout(store.root)
    report.storesRemoved += 1
  }

  return report
}

/**
 * Live-daemon retention backstop. It never removes a locked store and observes
 * a 24h age floor, covering task-delete cleanup failures without racing a
 * fresh store before its session-ready owner transaction.
 */
export async function runOpencodeStoreOrphanGc(
  db: DbClient,
  appHome: string,
  now = Date.now(),
): Promise<{ scanned: number; removed: string[] }> {
  const roots = storeRoots(appHome)
  const [businessStores, systemStores, owners] = await Promise.all([
    listStoreDirectories(roots.business, BUSINESS_KEY_RE),
    listStoreDirectories(roots.system, SYSTEM_KEY_RE),
    db.select({ key: opencodeSessionOwners.sessionStoreKey }).from(opencodeSessionOwners),
  ])
  const anchored = new Set(owners.map((owner) => owner.key))
  const removed: string[] = []
  for (const store of [...businessStores, ...systemStores]) {
    if (anchored.has(store.key)) continue
    if ((await inspectAbandonedOpencodeStoreLock(store.dbPath)) !== null) continue
    const metadata = await stat(store.root)
    if (now - metadata.mtimeMs < OPENCODE_STORE_ORPHAN_MIN_AGE_MS) continue
    await removeHermeticOpencodeLayout(store.root)
    removed.push(store.key)
  }
  return { scanned: businessStores.length + systemStores.length, removed }
}

/** Read all persistent store keys for exact task-delete cleanup. */
export async function inspectTaskOpencodeStores(
  db: DbClient,
  appHome: string,
  taskId: string,
): Promise<{ keys: string[]; hasLease: boolean; hasLock: boolean }> {
  const rows = await db
    .select({
      key: opencodeSessionOwners.sessionStoreKey,
      leaseNodeRunId: opencodeSessionOwners.leaseNodeRunId,
    })
    .from(opencodeSessionOwners)
    .where(eq(opencodeSessionOwners.taskId, taskId))
  const keys = rows.map((row) => row.key).sort()
  const businessRoot = storeRoots(appHome).business
  const lockStates = await Promise.all(
    keys.map((key) => {
      if (!BUSINESS_KEY_RE.test(key)) unsafe()
      return inspectAbandonedOpencodeStoreLock(
        deriveHermeticOpencodeLayout(join(businessRoot, key)).sessionDbPath,
      )
    }),
  )
  return {
    keys,
    hasLease: rows.some((row) => row.leaseNodeRunId !== null),
    hasLock: lockStates.some((lock) => lock !== null),
  }
}

export async function removeTaskOpencodeStores(
  appHome: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return
  const roots = storeRoots(appHome)
  if (new Set(keys).size !== keys.length || keys.some((key) => !BUSINESS_KEY_RE.test(key))) unsafe()
  for (const key of keys) {
    const storeRoot = join(roots.business, key)
    await removeHermeticOpencodeLayout(storeRoot)
  }
}
