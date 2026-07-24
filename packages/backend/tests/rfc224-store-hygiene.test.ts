// RFC-224 T5/T14 — account-bearing OpenCode stores are private, single-writer,
// no-symlink, and scrubbed only while the server is stopped under an O_EXCL
// lifecycle lock. The rollback case prevents a partial credential cleanup from
// being mistaken for a clean store.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  acquireOpencodeStoreLifecycleLock,
  bindOpencodeStoreServerProcess,
  inspectAbandonedOpencodeStoreLock,
  scrubOpencodeStoreAccountState,
  type OpencodeStoreLifecycleLock,
} from '../src/services/runtime/opencode/storeHygiene'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixturePath(): Promise<{ root: string; dbPath: string; storeDir: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rfc224-store-')))
  roots.push(root)
  const storeDir = join(root, 'opencode')
  return { root, storeDir, dbPath: join(storeDir, 'opencode.db') }
}

function createPinnedDatabase(
  dbPath: string,
  options: { omit?: 'account_state' | 'account' | 'control_account'; drift?: boolean } = {},
): Database {
  const db = new Database(dbPath, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  if (options.omit !== 'account') {
    db.exec(`
      CREATE TABLE account (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        url TEXT NOT NULL,
        access_token TEXT ${options.drift ? '' : 'NOT NULL'},
        refresh_token TEXT NOT NULL,
        token_expiry INTEGER,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )
    `)
  }
  if (options.omit !== 'account_state') {
    db.exec(`
      CREATE TABLE account_state (
        id INTEGER PRIMARY KEY,
        active_account_id TEXT,
        active_org_id TEXT,
        FOREIGN KEY (active_account_id) REFERENCES account(id) ON DELETE SET NULL
      )
    `)
  }
  if (options.omit !== 'control_account') {
    db.exec(`
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
      )
    `)
  }
  db.exec('CREATE TABLE unrelated (value TEXT NOT NULL)')
  return db
}

function insertAccountRows(db: Database): void {
  db.exec(`
    INSERT INTO account
      (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated)
    VALUES ('acct', 'a@example.test', 'https://control.test', 'secret-a', 'secret-r', 42, 1, 2);
    INSERT INTO account_state (id, active_account_id, active_org_id)
    VALUES (1, 'acct', 'org');
    INSERT INTO control_account
      (email, url, access_token, refresh_token, token_expiry, active, time_created, time_updated)
    VALUES ('a@example.test', 'https://control.test', 'secret-c', 'secret-cr', 42, 1, 1, 2);
    INSERT INTO unrelated (value) VALUES ('keep');
  `)
}

const STORE_UNSAFE = { code: 'execution-identity-store-unsafe' } as const

describe('RFC-224 OpenCode store lifecycle lock', () => {
  test('creates a private O_EXCL lock, serializes contenders, and permits reacquire after release', async () => {
    const { dbPath } = await fixturePath()
    const nonce = 'A'.repeat(43)
    const lock = await acquireOpencodeStoreLifecycleLock(dbPath, nonce)
    expect(lock.nonceDigest).toHaveLength(64)
    expect((await lstat(lock.lockPath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse((await readFile(lock.lockPath, 'utf8')).trim())).toEqual({
      codec: 2,
      nonce,
      server: null,
    })

    await expect(acquireOpencodeStoreLifecycleLock(dbPath, 'B'.repeat(43))).rejects.toMatchObject(
      STORE_UNSAFE,
    )
    await lock.release()
    await lock.release() // cleanup is idempotent for the holder
    const next = await acquireOpencodeStoreLifecycleLock(dbPath, 'C'.repeat(43))
    await next.release()
  })

  test('fsync-binds a strict namespace server/scope seal into the live lock', async () => {
    const { dbPath } = await fixturePath()
    const lock = await acquireOpencodeStoreLifecycleLock(dbPath, 'D'.repeat(43))
    const server = {
      pidNamespace: 17,
      binaryPath: '/private/runtime-seal/opencode',
      runtimeBinaryDigest: 'a'.repeat(64),
      startedAt: 123,
      sessionStoreKey: 'b_chain',
      scope: { kind: 'business' as const, mode: 'resume' as const, nodeRunId: 'run-2' },
    }
    await bindOpencodeStoreServerProcess(lock, server)
    await expect(bindOpencodeStoreServerProcess(lock, server)).rejects.toMatchObject(STORE_UNSAFE)
    await expect(inspectAbandonedOpencodeStoreLock(dbPath)).resolves.toEqual({
      dbPath,
      lockPath: lock.lockPath,
      nonceDigest: lock.nonceDigest,
      server,
    })
    await lock.release()
  })

  test('rejects a symlinked store ancestor and an attacker-created lock symlink', async () => {
    const { root } = await fixturePath()
    const realStore = join(root, 'real-store')
    await mkdir(realStore)
    const linkedStore = join(root, 'linked-store')
    await symlink(realStore, linkedStore)
    await expect(
      acquireOpencodeStoreLifecycleLock(join(linkedStore, 'opencode.db')),
    ).rejects.toMatchObject(STORE_UNSAFE)

    const dbPath = join(realStore, 'opencode.db')
    await symlink(join(root, 'missing-target'), join(realStore, '.agent-workflow-store.lock'))
    await expect(acquireOpencodeStoreLifecycleLock(dbPath)).rejects.toMatchObject(STORE_UNSAFE)
  })

  test('detects lock pathname replacement before hygiene or release', async () => {
    const { dbPath } = await fixturePath()
    const lock = await acquireOpencodeStoreLifecycleLock(dbPath)
    await rm(lock.lockPath)
    await writeFile(lock.lockPath, 'replacement\n', { mode: 0o600 })
    await expect(
      scrubOpencodeStoreAccountState({ dbPath, kind: 'fresh', lock }),
    ).rejects.toMatchObject(STORE_UNSAFE)
    await expect(lock.release()).rejects.toMatchObject(STORE_UNSAFE)
  })
})

describe('RFC-224 OpenCode account hygiene', () => {
  test('fresh store may lack a DB and removes only a regular auth.json under a live lock', async () => {
    const { dbPath, storeDir } = await fixturePath()
    const lock = await acquireOpencodeStoreLifecycleLock(dbPath)
    await writeFile(join(storeDir, 'auth.json'), '{"secret":true}', { mode: 0o600 })
    try {
      await expect(
        scrubOpencodeStoreAccountState({ dbPath, kind: 'fresh', lock }),
      ).resolves.toEqual({ databasePresent: false })
      await expect(lstat(join(storeDir, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await lock.release()
    }
  })

  test('existing store may not silently fall back to a missing DB', async () => {
    const { dbPath } = await fixturePath()
    const lock = await acquireOpencodeStoreLifecycleLock(dbPath)
    try {
      await expect(
        scrubOpencodeStoreAccountState({ dbPath, kind: 'existing', lock }),
      ).rejects.toMatchObject(STORE_UNSAFE)
    } finally {
      await lock.release()
    }
  })

  test('rejects forged or already-released lock capabilities before touching auth', async () => {
    const { dbPath, storeDir } = await fixturePath()
    const live = await acquireOpencodeStoreLifecycleLock(dbPath)
    await writeFile(join(storeDir, 'auth.json'), 'keep', { mode: 0o600 })
    const forged: OpencodeStoreLifecycleLock = {
      dbPath,
      lockPath: live.lockPath,
      nonceDigest: live.nonceDigest,
      release: async () => undefined,
    }
    await expect(
      scrubOpencodeStoreAccountState({ dbPath, kind: 'fresh', lock: forged }),
    ).rejects.toMatchObject(STORE_UNSAFE)
    expect(await readFile(join(storeDir, 'auth.json'), 'utf8')).toBe('keep')
    await live.release()
    await expect(
      scrubOpencodeStoreAccountState({ dbPath, kind: 'fresh', lock: live }),
    ).rejects.toMatchObject(STORE_UNSAFE)
  })

  test.each(['symlink', 'directory'] as const)('rejects a %s auth.json', async (kind) => {
    const { root, dbPath, storeDir } = await fixturePath()
    const lock = await acquireOpencodeStoreLifecycleLock(dbPath)
    const authPath = join(storeDir, 'auth.json')
    if (kind === 'symlink') {
      const target = join(root, 'outside-auth')
      await writeFile(target, 'do-not-delete')
      await symlink(target, authPath)
    } else {
      await mkdir(authPath)
    }
    try {
      await expect(
        scrubOpencodeStoreAccountState({ dbPath, kind: 'fresh', lock }),
      ).rejects.toMatchObject(STORE_UNSAFE)
    } finally {
      await lock.release()
    }
  })

  test.each(['db-symlink', 'db-directory', 'orphan-wal-symlink', 'orphan-shm-directory'] as const)(
    'rejects unsafe SQLite artifact: %s',
    async (kind) => {
      const { root, dbPath } = await fixturePath()
      const lock = await acquireOpencodeStoreLifecycleLock(dbPath)
      if (kind === 'db-symlink') {
        const target = join(root, 'outside.db')
        await writeFile(target, '')
        await symlink(target, dbPath)
      } else if (kind === 'db-directory') {
        await mkdir(dbPath)
      } else if (kind === 'orphan-wal-symlink') {
        await symlink(join(root, 'outside-wal'), `${dbPath}-wal`)
      } else {
        await mkdir(`${dbPath}-shm`)
      }
      try {
        await expect(
          scrubOpencodeStoreAccountState({ dbPath, kind: 'fresh', lock }),
        ).rejects.toMatchObject(STORE_UNSAFE)
      } finally {
        await lock.release()
      }
    },
  )

  test.each(['account_state', 'account', 'control_account'] as const)(
    'existing DB missing pinned %s table fails closed',
    async (omit) => {
      const { dbPath } = await fixturePath()
      const lock = await acquireOpencodeStoreLifecycleLock(dbPath)
      createPinnedDatabase(dbPath, { omit }).close()
      try {
        await expect(
          scrubOpencodeStoreAccountState({ dbPath, kind: 'existing', lock }),
        ).rejects.toMatchObject(STORE_UNSAFE)
      } finally {
        await lock.release()
      }
    },
  )

  test('rejects pinned-table column drift instead of best-effort deleting known names', async () => {
    const { dbPath } = await fixturePath()
    const lock = await acquireOpencodeStoreLifecycleLock(dbPath)
    createPinnedDatabase(dbPath, { drift: true }).close()
    try {
      await expect(
        scrubOpencodeStoreAccountState({ dbPath, kind: 'existing', lock }),
      ).rejects.toMatchObject(STORE_UNSAFE)
    } finally {
      await lock.release()
    }
  })

  test('rejects executable trigger drift on an account-bearing table', async () => {
    const { dbPath } = await fixturePath()
    const lock = await acquireOpencodeStoreLifecycleLock(dbPath)
    const db = createPinnedDatabase(dbPath)
    db.exec(`
      CREATE TRIGGER copy_deleted_token
      AFTER DELETE ON account
      BEGIN
        INSERT INTO unrelated (value) VALUES (OLD.access_token);
      END
    `)
    db.close()
    try {
      await expect(
        scrubOpencodeStoreAccountState({ dbPath, kind: 'existing', lock }),
      ).rejects.toMatchObject(STORE_UNSAFE)
    } finally {
      await lock.release()
    }
  })

  test('transactionally clears all three account surfaces, verifies zero rows, and preserves unrelated data', async () => {
    const { dbPath, storeDir } = await fixturePath()
    const lock = await acquireOpencodeStoreLifecycleLock(dbPath)
    const db = createPinnedDatabase(dbPath)
    insertAccountRows(db)
    db.close()
    await writeFile(join(storeDir, 'auth.json'), '{"legacy":"secret"}', { mode: 0o600 })
    try {
      await expect(
        scrubOpencodeStoreAccountState({ dbPath, kind: 'existing', lock }),
      ).resolves.toEqual({ databasePresent: true })
      const check = new Database(dbPath, { readonly: true })
      try {
        for (const table of ['account_state', 'account', 'control_account']) {
          expect(check.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
        }
        expect(check.query('SELECT value FROM unrelated').get()).toEqual({ value: 'keep' })
      } finally {
        check.close()
      }
      await expect(lstat(join(storeDir, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        const metadata = await lstat(path).catch(() => null)
        if (metadata !== null) {
          expect(metadata.isFile()).toBe(true)
          expect(metadata.isSymbolicLink()).toBe(false)
        }
      }
    } finally {
      await lock.release()
    }
  })

  test('rolls back earlier deletes if any account table cleanup fails', async () => {
    const { dbPath } = await fixturePath()
    const lock = await acquireOpencodeStoreLifecycleLock(dbPath)
    const db = createPinnedDatabase(dbPath)
    insertAccountRows(db)
    db.exec(`
      CREATE TABLE control_account_reference (
        email TEXT NOT NULL,
        url TEXT NOT NULL,
        FOREIGN KEY (email, url) REFERENCES control_account(email, url)
      );
      INSERT INTO control_account_reference (email, url)
      VALUES ('a@example.test', 'https://control.test');
    `)
    db.close()
    try {
      await expect(
        scrubOpencodeStoreAccountState({ dbPath, kind: 'existing', lock }),
      ).rejects.toMatchObject(STORE_UNSAFE)
      const check = new Database(dbPath, { readonly: true })
      try {
        for (const table of ['account_state', 'account', 'control_account']) {
          expect(check.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 1 })
        }
      } finally {
        check.close()
      }
    } finally {
      await lock.release()
    }
  })
})
