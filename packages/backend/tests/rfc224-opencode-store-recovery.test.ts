// RFC-224 T5/T14/T21 — boot recovery may clear a persistent OpenCode store
// only after the exact terminal node-run's host-side outer process group is
// proven dead. The PID recorded inside the bwrap namespace is never host
// liveness evidence. Recovery must preserve every lock/lease on ambiguity,
// scrub the pinned account schema before reuse, and repair leases by triple CAS.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, opencodeSessionOwners, tasks, workflows } from '../src/db/schema'
import {
  OPENCODE_STORE_ORPHAN_MIN_AGE_MS,
  inspectTaskOpencodeStores,
  recoverOpencodeStoresOnBoot,
  removeTaskOpencodeStores,
  runOpencodeStoreOrphanGc,
} from '../src/services/opencodeStoreRecovery'
import { reapOrphanRunsForStoreRecovery } from '../src/services/orphans'
import { acquireLock, type Lock } from '../src/util/lock'
import { prepareHermeticOpencodeLayout } from '../src/services/runtime/opencode/hermetic'
import {
  inspectAbandonedOpencodeStoreLock,
  OPENCODE_STORE_LOCK_BASENAME,
  type OpencodeStoreServerBinding,
} from '../src/services/runtime/opencode/storeHygiene'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const BUILD_DIGEST = 'a'.repeat(64)
const HOST_SPAWN_PATH = '/opt/agent-workflow/bin/agent-workflow'
const STORE_UNSAFE = { code: 'execution-identity-store-unsafe' } as const
const tempRoots: string[] = []
const materializedStoreRoots: string[] = []
const daemonLocks: Lock[] = []

function businessKey(char: string): string {
  return `b_${char.repeat(43)}`
}

function systemKey(char: string): string {
  return `s_${char.repeat(43)}`
}

function nonceDigest(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex')
}

async function fixtureAppHome(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rfc224-store-recovery-')))
  tempRoots.push(root)
  return join(root, 'app-home')
}

async function reopenSealedRoots(storeRoot: string): Promise<void> {
  for (const path of [
    join(storeRoot, 'xdg-config', 'opencode'),
    join(storeRoot, 'test-home', '.opencode'),
    join(storeRoot, 'explicit-config'),
  ]) {
    await chmod(path, 0o700).catch(() => undefined)
  }
}

afterEach(async () => {
  for (const lock of daemonLocks.splice(0)) lock.release()
  await Promise.all(materializedStoreRoots.splice(0).map(reopenSealedRoots))
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function bootRecoveryCapability(db: DbClient, appHome: string) {
  const lock = acquireLock(join(appHome, `.daemon-test-${daemonLocks.length}.lock`))
  daemonLocks.push(lock)
  return (await reapOrphanRunsForStoreRecovery(db, lock)).priorDaemonSandboxDead
}

async function seedTask(db: DbClient): Promise<void> {
  await db.insert(workflows).values({
    id: 'workflow-a',
    name: 'workflow-a',
    definition: '{}',
  })
  await db.insert(tasks).values({
    id: 'task-a',
    name: 'task-a',
    workflowId: 'workflow-a',
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: 'aw/task-a',
    status: 'running',
    inputs: '{}',
    startedAt: 1,
  })
}

async function seedRun(
  db: DbClient,
  input: {
    id: string
    status?: 'running' | 'done' | 'failed' | 'canceled' | 'interrupted'
    pid?: number | null
    spawnBinaryPath?: string | null
  },
): Promise<void> {
  await db.insert(nodeRuns).values({
    id: input.id,
    taskId: 'task-a',
    nodeId: 'node-a',
    status: input.status ?? 'failed',
    pid: input.pid === undefined ? 424_242 : input.pid,
    spawnBinaryPath: input.spawnBinaryPath === undefined ? HOST_SPAWN_PATH : input.spawnBinaryPath,
  })
}

async function seedOwner(
  db: DbClient,
  input: {
    storeKey: string
    sessionId?: string
    runtimeBinaryDigest?: string
    lease?: { nodeRunId: string; nonceDigest: string } | null
  },
): Promise<void> {
  await db.insert(opencodeSessionOwners).values({
    sessionId: input.sessionId ?? `session-${input.storeKey.slice(-4)}`,
    taskId: 'task-a',
    nodeId: 'node-a',
    createdNodeRunId: input.lease?.nodeRunId ?? 'logical-created-run',
    identityDigest: 'identity-digest',
    runtimeBinaryDigest: input.runtimeBinaryDigest ?? BUILD_DIGEST,
    sessionContractDigest: 'session-contract-digest',
    sessionStoreKey: input.storeKey,
    projectId: 'project-a',
    protocolCodec: 'opencode-direct-v1',
    reportedVersion: '1.18.3',
    leaseNodeRunId: input.lease?.nodeRunId ?? null,
    leaseNonceDigest: input.lease?.nonceDigest ?? null,
    leasedAt: input.lease === null || input.lease === undefined ? null : 123,
  })
}

async function materializeStore(
  appHome: string,
  kind: 'business' | 'system-ephemeral',
  key: string,
): Promise<{ root: string; dbPath: string }> {
  const root = join(appHome, 'opencode-stores', kind, key)
  const layout = await prepareHermeticOpencodeLayout(root)
  materializedStoreRoots.push(root)
  return { root, dbPath: layout.sessionDbPath }
}

function createPinnedAccountDatabase(dbPath: string, withRows = true): void {
  const sqlite = new Database(dbPath, { create: true })
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA foreign_keys = ON')
  sqlite.exec(`
    CREATE TABLE account (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      url TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_expiry INTEGER,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE account_state (
      id INTEGER PRIMARY KEY,
      active_account_id TEXT,
      active_org_id TEXT,
      FOREIGN KEY (active_account_id) REFERENCES account(id) ON DELETE SET NULL
    );
    CREATE TABLE control_account (
      email TEXT NOT NULL,
      url TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_expiry INTEGER,
      active INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      PRIMARY KEY (email, url)
    );
  `)
  if (withRows) {
    sqlite.exec(`
      INSERT INTO account
        (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated)
      VALUES ('acct', 'a@example.test', 'https://control.test', 'secret-a', 'secret-r', 42, 1, 2);
      INSERT INTO account_state (id, active_account_id, active_org_id)
      VALUES (1, 'acct', 'org');
      INSERT INTO control_account
        (email, url, access_token, refresh_token, token_expiry, active, time_created, time_updated)
      VALUES ('a@example.test', 'https://control.test', 'secret-c', 'secret-cr', 42, 1, 1, 2);
    `)
  }
  sqlite.close()
}

async function preparePinnedBusinessStore(
  appHome: string,
  key: string,
): Promise<{ root: string; dbPath: string }> {
  const store = await materializeStore(appHome, 'business', key)
  await mkdir(dirname(store.dbPath), { recursive: true, mode: 0o700 })
  createPinnedAccountDatabase(store.dbPath)
  return store
}

async function writeAbandonedLock(input: {
  dbPath: string
  nonce: string
  server: OpencodeStoreServerBinding | null
}): Promise<void> {
  await mkdir(dirname(input.dbPath), { recursive: true, mode: 0o700 })
  await writeFile(
    join(dirname(input.dbPath), OPENCODE_STORE_LOCK_BASENAME),
    `${JSON.stringify({ codec: 2, nonce: input.nonce, server: input.server })}\n`,
    { flag: 'wx', mode: 0o600 },
  )
}

function businessServer(input: {
  storeKey: string
  nodeRunId: string
  nonceMode?: 'new' | 'resume'
  pidNamespace?: number
  runtimeBinaryDigest?: string
}): OpencodeStoreServerBinding {
  return {
    // This is intentionally different from node_runs.pid. It is an inner PID
    // namespace value and must never reach host liveness proof.
    pidNamespace: input.pidNamespace ?? 7,
    binaryPath: '/private/runtime-seal/opencode',
    runtimeBinaryDigest: input.runtimeBinaryDigest ?? BUILD_DIGEST,
    startedAt: 100,
    sessionStoreKey: input.storeKey,
    scope: {
      kind: 'business',
      mode: input.nonceMode ?? 'resume',
      nodeRunId: input.nodeRunId,
    },
  }
}

function accountCounts(dbPath: string): Record<string, number> {
  const sqlite = new Database(dbPath, { readonly: true })
  try {
    return Object.fromEntries(
      ['account_state', 'account', 'control_account'].map((table) => [
        table,
        (
          sqlite.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number
          }
        ).count,
      ]),
    )
  } finally {
    sqlite.close()
  }
}

describe('RFC-224 OpenCode boot store recovery', () => {
  test('recovery rejects forged, reused, or lock-released boot capabilities', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = await fixtureAppHome()
    await expect(
      recoverOpencodeStoresOnBoot({
        db,
        appHome,
        priorDaemonSandboxDead: true as never,
      }),
    ).rejects.toMatchObject(STORE_UNSAFE)

    const releasedLock = acquireLock(join(appHome, '.released-daemon.lock'))
    const releasedCapability = (await reapOrphanRunsForStoreRecovery(db, releasedLock))
      .priorDaemonSandboxDead
    releasedLock.release()
    await expect(
      recoverOpencodeStoresOnBoot({
        db,
        appHome,
        priorDaemonSandboxDead: releasedCapability,
      }),
    ).rejects.toMatchObject(STORE_UNSAFE)

    const capability = await bootRecoveryCapability(db, appHome)
    await expect(
      recoverOpencodeStoresOnBoot({
        db,
        appHome,
        priorDaemonSandboxDead: capability,
      }),
    ).resolves.toEqual({
      businessStoresScanned: 0,
      systemStoresScanned: 0,
      leasesRepaired: 0,
      storesScrubbed: 0,
      storesRemoved: 0,
    })
    await expect(
      recoverOpencodeStoresOnBoot({
        db,
        appHome,
        priorDaemonSandboxDead: capability,
      }),
    ).rejects.toMatchObject(STORE_UNSAFE)
  })

  test('dead host outer group scrubs the pinned store, triple-CAS repairs its lease, and is idempotent', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await seedRun(db, { id: 'run-crashed', pid: 424_242 })
    const appHome = await fixtureAppHome()
    const key = businessKey('a')
    const store = await preparePinnedBusinessStore(appHome, key)
    const nonce = 'N'.repeat(43)
    const digest = nonceDigest(nonce)
    await seedOwner(db, {
      storeKey: key,
      sessionId: 'session-a',
      lease: { nodeRunId: 'run-crashed', nonceDigest: digest },
    })
    await writeAbandonedLock({
      dbPath: store.dbPath,
      nonce,
      server: businessServer({
        storeKey: key,
        nodeRunId: 'run-crashed',
        pidNamespace: 7,
      }),
    })

    const hostProofs: Array<{ id: string; pid: number | null; spawnBinaryPath: string | null }> = []
    await expect(
      recoverOpencodeStoresOnBoot({
        db,
        appHome,
        priorDaemonSandboxDead: await bootRecoveryCapability(db, appHome),
        dependencies: {
          outerProcessGroupDead: (run) => {
            hostProofs.push({
              id: run.id,
              pid: run.pid,
              spawnBinaryPath: run.spawnBinaryPath,
            })
            return true
          },
        },
      }),
    ).resolves.toEqual({
      businessStoresScanned: 1,
      systemStoresScanned: 0,
      leasesRepaired: 1,
      storesScrubbed: 1,
      storesRemoved: 0,
    })

    // Lock binding pidNamespace=7 is metadata only. Both proofs come from the
    // terminal host node-run and therefore see its persisted outer PID/path.
    expect(hostProofs).toEqual([
      { id: 'run-crashed', pid: 424_242, spawnBinaryPath: HOST_SPAWN_PATH },
      { id: 'run-crashed', pid: 424_242, spawnBinaryPath: HOST_SPAWN_PATH },
    ])
    expect(await inspectAbandonedOpencodeStoreLock(store.dbPath)).toBeNull()
    expect(accountCounts(store.dbPath)).toEqual({
      account_state: 0,
      account: 0,
      control_account: 0,
    })
    expect(
      await db
        .select({
          nodeRunId: opencodeSessionOwners.leaseNodeRunId,
          nonce: opencodeSessionOwners.leaseNonceDigest,
          leasedAt: opencodeSessionOwners.leasedAt,
        })
        .from(opencodeSessionOwners)
        .where(eq(opencodeSessionOwners.sessionId, 'session-a'))
        .get(),
    ).toEqual({ nodeRunId: null, nonce: null, leasedAt: null })

    await expect(
      recoverOpencodeStoresOnBoot({
        db,
        appHome,
        priorDaemonSandboxDead: await bootRecoveryCapability(db, appHome),
        dependencies: {
          outerProcessGroupDead: () => {
            throw new Error('an already-repaired store must not ask for liveness again')
          },
        },
      }),
    ).resolves.toEqual({
      businessStoresScanned: 1,
      systemStoresScanned: 0,
      leasesRepaired: 0,
      storesScrubbed: 0,
      storesRemoved: 0,
    })
  })

  test.each([
    { label: 'live', pid: 51_234 },
    { label: 'unknown', pid: null },
  ])('$label outer group preserves lock, lease, and account state', async ({ pid }) => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await seedRun(db, { id: 'run-not-provably-dead', pid })
    const appHome = await fixtureAppHome()
    const key = businessKey(pid === null ? 'u' : 'l')
    const store = await preparePinnedBusinessStore(appHome, key)
    const nonce = 'L'.repeat(43)
    const digest = nonceDigest(nonce)
    await seedOwner(db, {
      storeKey: key,
      lease: { nodeRunId: 'run-not-provably-dead', nonceDigest: digest },
    })
    await writeAbandonedLock({
      dbPath: store.dbPath,
      nonce,
      server: businessServer({ storeKey: key, nodeRunId: 'run-not-provably-dead' }),
    })

    await expect(
      recoverOpencodeStoresOnBoot({
        db,
        appHome,
        priorDaemonSandboxDead: await bootRecoveryCapability(db, appHome),
        dependencies: {
          outerProcessGroupDead: (run) => {
            expect(run.pid).toBe(pid)
            return false
          },
        },
      }),
    ).rejects.toMatchObject(STORE_UNSAFE)

    expect(await inspectAbandonedOpencodeStoreLock(store.dbPath)).not.toBeNull()
    expect(accountCounts(store.dbPath)).toEqual({
      account_state: 1,
      account: 1,
      control_account: 1,
    })
    expect(
      await db
        .select({
          nodeRunId: opencodeSessionOwners.leaseNodeRunId,
          nonce: opencodeSessionOwners.leaseNonceDigest,
        })
        .from(opencodeSessionOwners)
        .where(eq(opencodeSessionOwners.sessionStoreKey, key))
        .get(),
    ).toEqual({ nodeRunId: 'run-not-provably-dead', nonce: digest })
  })

  test.each([
    {
      label: 'binary digest',
      ownerDigest: 'b'.repeat(64),
      lockDigest: BUILD_DIGEST,
      lockStoreKey: undefined,
      ownerNonceDigest: undefined,
    },
    {
      label: 'lock-bound store',
      ownerDigest: undefined,
      lockDigest: undefined,
      lockStoreKey: businessKey('z'),
      ownerNonceDigest: undefined,
    },
    {
      label: 'lease nonce',
      ownerDigest: undefined,
      lockDigest: undefined,
      lockStoreKey: undefined,
      ownerNonceDigest: 'f'.repeat(64),
    },
  ])('$label drift fails closed before cleanup', async (drift) => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await seedRun(db, { id: 'run-drift' })
    const appHome = await fixtureAppHome()
    const key = businessKey('d')
    const store = await preparePinnedBusinessStore(appHome, key)
    const nonce = 'D'.repeat(43)
    const digest = nonceDigest(nonce)
    await seedOwner(db, {
      storeKey: key,
      runtimeBinaryDigest: drift.ownerDigest,
      lease: {
        nodeRunId: 'run-drift',
        nonceDigest: drift.ownerNonceDigest ?? digest,
      },
    })
    await writeAbandonedLock({
      dbPath: store.dbPath,
      nonce,
      server: businessServer({
        storeKey: drift.lockStoreKey ?? key,
        nodeRunId: 'run-drift',
        runtimeBinaryDigest: drift.lockDigest ?? drift.ownerDigest,
      }),
    })

    await expect(
      recoverOpencodeStoresOnBoot({
        db,
        appHome,
        priorDaemonSandboxDead: await bootRecoveryCapability(db, appHome),
        dependencies: {
          outerProcessGroupDead: () => true,
        },
      }),
    ).rejects.toMatchObject(STORE_UNSAFE)
    expect(await inspectAbandonedOpencodeStoreLock(store.dbPath)).not.toBeNull()
    expect(accountCounts(store.dbPath)).toEqual({
      account_state: 1,
      account: 1,
      control_account: 1,
    })
    expect(
      await db
        .select({ nodeRunId: opencodeSessionOwners.leaseNodeRunId })
        .from(opencodeSessionOwners)
        .where(eq(opencodeSessionOwners.sessionStoreKey, key))
        .get(),
    ).toEqual({ nodeRunId: 'run-drift' })
  })

  test('system-ephemeral boot remnants are deleted after the prior-daemon barrier', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = await fixtureAppHome()
    const key = systemKey('s')
    const store = await materializeStore(appHome, 'system-ephemeral', key)
    const sentinel = join(store.root, 'tmp', 'secret-remnant')
    await writeFile(sentinel, 'delete-me', { mode: 0o600 })
    await writeAbandonedLock({
      dbPath: store.dbPath,
      nonce: 'S'.repeat(43),
      server: {
        pidNamespace: 11,
        binaryPath: '/private/runtime-seal/opencode',
        runtimeBinaryDigest: BUILD_DIGEST,
        startedAt: 100,
        sessionStoreKey: key,
        scope: { kind: 'system-ephemeral', invocationId: key },
      },
    })

    await expect(
      recoverOpencodeStoresOnBoot({
        db,
        appHome,
        priorDaemonSandboxDead: await bootRecoveryCapability(db, appHome),
        dependencies: {
          outerProcessGroupDead: () => {
            throw new Error('system remnants rely on the once-only boot barrier')
          },
        },
      }),
    ).resolves.toEqual({
      businessStoresScanned: 0,
      systemStoresScanned: 1,
      leasesRepaired: 0,
      storesScrubbed: 0,
      storesRemoved: 1,
    })
    await expect(lstat(store.root)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('RFC-224 OpenCode store orphan GC', () => {
  test('keeps anchored, locked, and young stores while deleting only old ownerless stores', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    const appHome = await fixtureAppHome()
    const anchoredKey = businessKey('a')
    const lockedKey = businessKey('l')
    const youngKey = businessKey('y')
    const oldBusinessKey = businessKey('o')
    const oldSystemKey = systemKey('s')
    const stores = {
      anchored: await materializeStore(appHome, 'business', anchoredKey),
      locked: await materializeStore(appHome, 'business', lockedKey),
      young: await materializeStore(appHome, 'business', youngKey),
      oldBusiness: await materializeStore(appHome, 'business', oldBusinessKey),
      oldSystem: await materializeStore(appHome, 'system-ephemeral', oldSystemKey),
    }
    await seedOwner(db, { storeKey: anchoredKey, lease: null })
    await writeAbandonedLock({
      dbPath: stores.locked.dbPath,
      nonce: 'G'.repeat(43),
      server: null,
    })

    const now = 10 * OPENCODE_STORE_ORPHAN_MIN_AGE_MS
    const old = new Date(now - OPENCODE_STORE_ORPHAN_MIN_AGE_MS - 1)
    const young = new Date(now - OPENCODE_STORE_ORPHAN_MIN_AGE_MS + 1)
    for (const store of [stores.anchored, stores.locked, stores.oldBusiness, stores.oldSystem]) {
      await utimes(store.root, old, old)
    }
    await utimes(stores.young.root, young, young)

    await expect(runOpencodeStoreOrphanGc(db, appHome, now)).resolves.toEqual({
      scanned: 5,
      removed: [oldBusinessKey, oldSystemKey],
    })
    expect(
      await readFile(join(dirname(stores.locked.dbPath), OPENCODE_STORE_LOCK_BASENAME), 'utf8'),
    ).toContain('"server":null')
    for (const store of [stores.anchored, stores.locked, stores.young]) {
      expect((await lstat(store.root)).isDirectory()).toBe(true)
    }
    for (const store of [stores.oldBusiness, stores.oldSystem]) {
      await expect(lstat(store.root)).rejects.toMatchObject({ code: 'ENOENT' })
    }

    await expect(runOpencodeStoreOrphanGc(db, appHome, now)).resolves.toEqual({
      scanned: 3,
      removed: [],
    })
  })

  test('task cleanup enumerates exact owners and refuses leased or locked stores', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    const appHome = await fixtureAppHome()
    const unlockedKey = businessKey('u')
    const lockedKey = businessKey('l')
    const leasedKey = businessKey('e')
    const unlocked = await materializeStore(appHome, 'business', unlockedKey)
    const locked = await materializeStore(appHome, 'business', lockedKey)
    await materializeStore(appHome, 'business', leasedKey)
    await seedOwner(db, { storeKey: unlockedKey, lease: null })
    await seedOwner(db, { storeKey: lockedKey, lease: null })
    await seedOwner(db, {
      storeKey: leasedKey,
      lease: { nodeRunId: 'run-active', nonceDigest: 'e'.repeat(64) },
    })
    await writeAbandonedLock({
      dbPath: locked.dbPath,
      nonce: 'L'.repeat(43),
      server: null,
    })

    await expect(inspectTaskOpencodeStores(db, appHome, 'task-a')).resolves.toEqual({
      keys: [leasedKey, lockedKey, unlockedKey].sort(),
      hasLease: true,
      hasLock: true,
    })
    await removeTaskOpencodeStores(appHome, [unlockedKey])
    await expect(lstat(unlocked.root)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(removeTaskOpencodeStores(appHome, [lockedKey])).rejects.toMatchObject(STORE_UNSAFE)
    expect((await lstat(locked.root)).isDirectory()).toBe(true)
  })
})
