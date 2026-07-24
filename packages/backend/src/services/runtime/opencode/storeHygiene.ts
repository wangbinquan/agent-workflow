// RFC-224 T5/T14 — private OpenCode store ownership and account hygiene.
//
// This module is deliberately independent from the launcher. A caller must
// first prove the OpenCode server is stopped, then hold this O_EXCL lifecycle
// lock for the entire server lifetime. Account cleanup is only accepted through
// that live lock, so no helper can casually open a resumable store.

import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, parse, relative, sep } from 'node:path'
import { Database } from 'bun:sqlite'
import { ExecutionIdentityFailure, executionIdentityFailure } from './failure'

export const OPENCODE_STORE_LOCK_BASENAME = '.agent-workflow-store.lock'
const LEGACY_STORE_LOCK_CODEC = 1 as const
const STORE_LOCK_CODEC = 2 as const
const ACCOUNT_TABLES = ['account_state', 'account', 'control_account'] as const

type AccountTable = (typeof ACCOUNT_TABLES)[number]

interface ColumnShape {
  name: string
  type: string
  notnull: 0 | 1
  defaultValue: string | null
  pk: number
}

const PINNED_ACCOUNT_SCHEMA: Readonly<Record<AccountTable, readonly ColumnShape[]>> = Object.freeze(
  {
    account_state: [
      { name: 'id', type: 'INTEGER', notnull: 0, defaultValue: null, pk: 1 },
      { name: 'active_account_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
      { name: 'active_org_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    ],
    account: [
      { name: 'id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 },
      { name: 'email', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
      { name: 'url', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
      { name: 'access_token', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
      { name: 'refresh_token', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
      { name: 'token_expiry', type: 'INTEGER', notnull: 0, defaultValue: null, pk: 0 },
      { name: 'time_created', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
      { name: 'time_updated', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
    ],
    control_account: [
      { name: 'email', type: 'TEXT', notnull: 1, defaultValue: null, pk: 1 },
      { name: 'url', type: 'TEXT', notnull: 1, defaultValue: null, pk: 2 },
      { name: 'access_token', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
      { name: 'refresh_token', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
      { name: 'token_expiry', type: 'INTEGER', notnull: 0, defaultValue: null, pk: 0 },
      { name: 'active', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
      { name: 'time_created', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
      { name: 'time_updated', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
    ],
  },
)

const activeLocks = new WeakSet<OpencodeStoreLifecycleLock>()

export interface OpencodeStoreLifecycleLock {
  /** Exact frozen DB locator this lock authorizes. */
  readonly dbPath: string
  readonly lockPath: string
  /** SHA-256 only; the raw lock/lease nonce is never exposed from this object. */
  readonly nonceDigest: string
  release(): Promise<void>
}

interface InternalLock extends OpencodeStoreLifecycleLock {
  readonly handle: FileHandle
  readonly nonce: string
  payload: string
  serverBound: boolean
  released: boolean
}

export interface OpencodeStoreServerBinding {
  /** PID as observed inside the RFC-205 bwrap PID namespace. */
  pidNamespace: number
  binaryPath: string
  runtimeBinaryDigest: string
  startedAt: number
  sessionStoreKey: string
  scope:
    | {
        kind: 'business'
        mode: 'new' | 'resume'
        nodeRunId: string
      }
    | {
        kind: 'system-ephemeral'
        invocationId: string
      }
}

export interface AbandonedOpencodeStoreLock {
  dbPath: string
  lockPath: string
  nonceDigest: string
  server: OpencodeStoreServerBinding | null
}

interface StoreLockPayload {
  codec: typeof STORE_LOCK_CODEC
  nonce: string
  server: OpencodeStoreServerBinding | null
}

export interface ScrubOpencodeStoreInput {
  dbPath: string
  /**
   * `existing` is a persistent business resume store. `fresh` may legitimately
   * have no DB before first serve.
   */
  kind: 'fresh' | 'existing'
  lock: OpencodeStoreLifecycleLock
}

export interface ScrubOpencodeStoreResult {
  databasePresent: boolean
}

function unsafe(): never {
  return executionIdentityFailure('execution-identity-store-unsafe')
}

function validateAbsoluteNormalizedPath(path: string): void {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path === parse(path).root
  ) {
    unsafe()
  }
}

async function ensureNoSymlinkDirectory(path: string): Promise<void> {
  validateAbsoluteNormalizedPath(path)
  const root = parse(path).root
  const components = relative(root, path).split(sep).filter(Boolean)
  let cursor = root
  for (const component of components) {
    cursor = join(cursor, component)
    let metadata: Stats
    try {
      metadata = await lstat(cursor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(cursor, { mode: 0o700 })
      metadata = await lstat(cursor)
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) unsafe()
  }
  const resolved = await realpath(path)
  if (resolved !== path) unsafe()
}

async function regularArtifact(path: string): Promise<Stats | null> {
  let metadata: Stats
  try {
    metadata = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) unsafe()
  return metadata
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

async function readHandleExactly(handle: FileHandle, bytes: number): Promise<string> {
  const buffer = Buffer.alloc(bytes)
  const result = await handle.read(buffer, 0, bytes, 0)
  if (result.bytesRead !== bytes) unsafe()
  return buffer.toString('utf8')
}

function validateNonce(nonce: string): void {
  if (nonce.length < 32 || nonce.length > 128 || !/^[A-Za-z0-9_-]+$/.test(nonce)) unsafe()
}

function digestNonce(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex')
}

function serializeLockPayload(payload: StoreLockPayload): string {
  return `${JSON.stringify(payload)}\n`
}

function parseLockPayload(raw: string): StoreLockPayload {
  try {
    if (!raw.endsWith('\n') || raw.length > 4_096) unsafe()
    const value = JSON.parse(raw.slice(0, -1)) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) unsafe()
    const record = value as Record<string, unknown>
    if (
      Object.keys(record).sort().join(',') !== 'codec,nonce,server' ||
      (record.codec !== STORE_LOCK_CODEC && record.codec !== LEGACY_STORE_LOCK_CODEC) ||
      typeof record.nonce !== 'string'
    ) {
      unsafe()
    }
    validateNonce(record.nonce)
    if (record.server === null) {
      return { codec: STORE_LOCK_CODEC, nonce: record.nonce, server: null }
    }
    if (
      record.server === undefined ||
      typeof record.server !== 'object' ||
      Array.isArray(record.server)
    ) {
      unsafe()
    }
    const server = record.server as Record<string, unknown>
    const legacy = record.codec === LEGACY_STORE_LOCK_CODEC
    const digestKey = legacy ? 'officialBuildDigest' : 'runtimeBinaryDigest'
    const runtimeBinaryDigest = server[digestKey]
    if (
      Object.keys(server).sort().join(',') !==
        (legacy
          ? 'binaryPath,officialBuildDigest,pidNamespace,scope,sessionStoreKey,startedAt'
          : 'binaryPath,pidNamespace,runtimeBinaryDigest,scope,sessionStoreKey,startedAt') ||
      !Number.isSafeInteger(server.pidNamespace) ||
      (server.pidNamespace as number) <= 0 ||
      typeof server.binaryPath !== 'string' ||
      typeof runtimeBinaryDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(runtimeBinaryDigest) ||
      !Number.isSafeInteger(server.startedAt) ||
      (server.startedAt as number) < 0 ||
      typeof server.sessionStoreKey !== 'string' ||
      server.sessionStoreKey.length === 0 ||
      server.sessionStoreKey.length > 256 ||
      server.sessionStoreKey.includes('\0') ||
      server.scope === null ||
      typeof server.scope !== 'object' ||
      Array.isArray(server.scope)
    ) {
      unsafe()
    }
    validateAbsoluteNormalizedPath(server.binaryPath)
    const scope = server.scope as Record<string, unknown>
    let parsedScope: OpencodeStoreServerBinding['scope']
    if (scope.kind === 'business') {
      if (
        Object.keys(scope).sort().join(',') !== 'kind,mode,nodeRunId' ||
        (scope.mode !== 'new' && scope.mode !== 'resume') ||
        typeof scope.nodeRunId !== 'string' ||
        scope.nodeRunId.length === 0 ||
        scope.nodeRunId.length > 256 ||
        scope.nodeRunId.includes('\0')
      ) {
        unsafe()
      }
      parsedScope = {
        kind: 'business',
        mode: scope.mode,
        nodeRunId: scope.nodeRunId,
      }
    } else if (scope.kind === 'system-ephemeral') {
      if (
        Object.keys(scope).sort().join(',') !== 'invocationId,kind' ||
        typeof scope.invocationId !== 'string' ||
        scope.invocationId.length === 0 ||
        scope.invocationId.length > 256 ||
        scope.invocationId.includes('\0')
      ) {
        unsafe()
      }
      parsedScope = {
        kind: 'system-ephemeral',
        invocationId: scope.invocationId,
      }
    } else {
      unsafe()
    }
    return {
      codec: STORE_LOCK_CODEC,
      nonce: record.nonce,
      server: {
        pidNamespace: server.pidNamespace as number,
        binaryPath: server.binaryPath,
        runtimeBinaryDigest,
        startedAt: server.startedAt as number,
        sessionStoreKey: server.sessionStoreKey,
        scope: parsedScope,
      },
    }
  } catch (error) {
    if (error instanceof ExecutionIdentityFailure) throw error
    unsafe()
  }
}

async function readRegularLockPayload(
  lockPath: string,
): Promise<{ payload: StoreLockPayload; metadata: Stats }> {
  const before = await regularArtifact(lockPath)
  if (before === null || (before.mode & 0o777) !== 0o600 || before.size > 4_096) unsafe()
  const handle = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const descriptor = await handle.stat()
    const current = await regularArtifact(lockPath)
    if (
      current === null ||
      !sameFile(before, descriptor) ||
      !sameFile(descriptor, current) ||
      descriptor.size !== before.size
    ) {
      unsafe()
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength !== before.size) unsafe()
    return {
      payload: parseLockPayload(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      metadata: descriptor,
    }
  } catch (error) {
    if (error instanceof ExecutionIdentityFailure) throw error
    unsafe()
  } finally {
    await handle.close()
  }
}

async function writeInternalLockPayload(
  lock: InternalLock,
  payload: StoreLockPayload,
): Promise<void> {
  const serialized = serializeLockPayload(payload)
  const bytes = Buffer.from(serialized, 'utf8')
  const descriptorBefore = await lock.handle.stat()
  const pathnameBefore = await regularArtifact(lock.lockPath)
  if (
    pathnameBefore === null ||
    !sameFile(descriptorBefore, pathnameBefore) ||
    (pathnameBefore.mode & 0o777) !== 0o600
  ) {
    unsafe()
  }
  await lock.handle.truncate(0)
  const result = await lock.handle.write(bytes, 0, bytes.byteLength, 0)
  if (result.bytesWritten !== bytes.byteLength) unsafe()
  await lock.handle.sync()
  const descriptorAfter = await lock.handle.stat()
  const pathnameAfter = await regularArtifact(lock.lockPath)
  if (
    pathnameAfter === null ||
    !sameFile(descriptorBefore, descriptorAfter) ||
    !sameFile(descriptorAfter, pathnameAfter) ||
    descriptorAfter.size !== bytes.byteLength ||
    pathnameAfter.size !== bytes.byteLength ||
    (pathnameAfter.mode & 0o777) !== 0o600 ||
    (await readHandleExactly(lock.handle, bytes.byteLength)) !== serialized
  ) {
    unsafe()
  }
  lock.payload = serialized
}

/**
 * Acquire the lifecycle lock before any auth cleanup, SQLite open, or server
 * spawn. `nonce` should be the runner's lease nonce for a resumable business
 * store; callers may omit it for an ephemeral system store.
 */
export async function acquireOpencodeStoreLifecycleLock(
  dbPath: string,
  nonce = randomBytes(32).toString('base64url'),
): Promise<OpencodeStoreLifecycleLock> {
  try {
    validateAbsoluteNormalizedPath(dbPath)
    if (basename(dbPath) !== 'opencode.db') unsafe()
    validateNonce(nonce)
    const storeDir = dirname(dbPath)
    await ensureNoSymlinkDirectory(storeDir)
    await chmod(storeDir, 0o700)
    const lockPath = join(storeDir, OPENCODE_STORE_LOCK_BASENAME)
    const handle = await open(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      const payload = serializeLockPayload({ codec: STORE_LOCK_CODEC, nonce, server: null })
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
      const descriptor = await handle.stat()
      const pathname = await lstat(lockPath)
      if (
        !descriptor.isFile() ||
        !pathname.isFile() ||
        pathname.isSymbolicLink() ||
        !sameFile(descriptor, pathname) ||
        descriptor.size !== Buffer.byteLength(payload) ||
        pathname.size !== Buffer.byteLength(payload) ||
        (pathname.mode & 0o777) !== 0o600
      ) {
        unsafe()
      }

      const lock: InternalLock = {
        dbPath,
        lockPath,
        nonce,
        nonceDigest: digestNonce(nonce),
        handle,
        payload,
        serverBound: false,
        released: false,
        async release(): Promise<void> {
          if (lock.released) return
          lock.released = true
          activeLocks.delete(lock)
          let valid = false
          try {
            const descriptorNow = await lock.handle.stat()
            const pathnameNow = await regularArtifact(lock.lockPath)
            valid =
              pathnameNow !== null &&
              sameFile(descriptorNow, pathnameNow) &&
              descriptorNow.size === Buffer.byteLength(lock.payload) &&
              pathnameNow.size === Buffer.byteLength(lock.payload) &&
              (await readHandleExactly(lock.handle, Buffer.byteLength(lock.payload))) ===
                lock.payload
            if (valid) await unlink(lock.lockPath)
          } finally {
            await lock.handle.close()
          }
          if (!valid) unsafe()
        },
      }
      activeLocks.add(lock)
      return lock
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(lockPath).catch(() => undefined)
      throw error
    }
  } catch (error) {
    if (error instanceof ExecutionIdentityFailure) throw error
    unsafe()
  }
}

/**
 * Bind the O_EXCL store lock to the exact inner server before any listen line
 * or session work is accepted. `pidNamespace` is deliberately labelled: the
 * launcher runs under RFC-205 bwrap and this PID must never be used as a host
 * PID during boot recovery. Boot instead proves the persisted outer bwrap
 * group/namespace is gone, then uses this record only as the store/scope seal.
 */
export async function bindOpencodeStoreServerProcess(
  candidate: OpencodeStoreLifecycleLock,
  binding: OpencodeStoreServerBinding,
): Promise<void> {
  const lock = await assertLiveLock(candidate.dbPath, candidate)
  if (lock.serverBound) unsafe()
  const parsed = parseLockPayload(
    serializeLockPayload({
      codec: STORE_LOCK_CODEC,
      nonce: lock.nonce,
      server: binding,
    }),
  )
  if (parsed.server === null) unsafe()
  await writeInternalLockPayload(lock, parsed)
  lock.serverBound = true
}

/** Inspect a lock left by a crashed prior daemon without following links. */
export async function inspectAbandonedOpencodeStoreLock(
  dbPath: string,
): Promise<AbandonedOpencodeStoreLock | null> {
  validateAbsoluteNormalizedPath(dbPath)
  if (basename(dbPath) !== 'opencode.db') unsafe()
  const lockPath = join(dirname(dbPath), OPENCODE_STORE_LOCK_BASENAME)
  const metadata = await regularArtifact(lockPath)
  if (metadata === null) return null
  const { payload } = await readRegularLockPayload(lockPath)
  return {
    dbPath,
    lockPath,
    nonceDigest: digestNonce(payload.nonce),
    server: payload.server,
  }
}

/**
 * Remove a prior-daemon lock only after the boot recovery barrier has proved
 * the outer RFC-205 bwrap process group (and therefore its PID namespace) dead.
 * The expected nonce/scope are re-read immediately before the inode-checked
 * unlink, so a changed holder cannot be cleared.
 */
export async function removeAbandonedOpencodeStoreLock(input: {
  dbPath: string
  expectedNonceDigest: string
  expectedServer: OpencodeStoreServerBinding | null
  outerSandboxProcessGroupDead: true
}): Promise<boolean> {
  if (
    input.outerSandboxProcessGroupDead !== true ||
    !/^[0-9a-f]{64}$/.test(input.expectedNonceDigest)
  ) {
    unsafe()
  }
  const inspected = await inspectAbandonedOpencodeStoreLock(input.dbPath)
  if (inspected === null) return false
  if (
    inspected.nonceDigest !== input.expectedNonceDigest ||
    JSON.stringify(inspected.server) !== JSON.stringify(input.expectedServer)
  ) {
    unsafe()
  }
  const before = await regularArtifact(inspected.lockPath)
  if (before === null || (before.mode & 0o777) !== 0o600) unsafe()
  const handle = await open(inspected.lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const descriptor = await handle.stat()
    const current = await regularArtifact(inspected.lockPath)
    if (current === null || !sameFile(before, descriptor) || !sameFile(descriptor, current)) {
      unsafe()
    }
    const payload = parseLockPayload(
      new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile()),
    )
    if (
      digestNonce(payload.nonce) !== input.expectedNonceDigest ||
      JSON.stringify(payload.server) !== JSON.stringify(input.expectedServer)
    ) {
      unsafe()
    }
    await unlink(inspected.lockPath)
    return true
  } catch (error) {
    if (error instanceof ExecutionIdentityFailure) throw error
    unsafe()
  } finally {
    await handle.close()
  }
}

/** Destructive store cleanup is forbidden while any lifecycle lock remains. */
export async function assertOpencodeStoreUnlocked(dbPath: string): Promise<void> {
  if ((await inspectAbandonedOpencodeStoreLock(dbPath)) !== null) unsafe()
}

async function assertLiveLock(
  dbPath: string,
  candidate: OpencodeStoreLifecycleLock,
): Promise<InternalLock> {
  if (!activeLocks.has(candidate) || candidate.dbPath !== dbPath) unsafe()
  const lock = candidate as InternalLock
  if (lock.released) unsafe()
  const descriptor = await lock.handle.stat()
  const pathname = await regularArtifact(lock.lockPath)
  if (
    pathname === null ||
    !sameFile(descriptor, pathname) ||
    descriptor.size !== Buffer.byteLength(lock.payload) ||
    pathname.size !== Buffer.byteLength(lock.payload) ||
    (await readHandleExactly(lock.handle, Buffer.byteLength(lock.payload))) !== lock.payload
  ) {
    unsafe()
  }
  return lock
}

async function unlinkRegularNoFollow(path: string): Promise<void> {
  const before = await regularArtifact(path)
  if (before === null) return
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const descriptor = await handle.stat()
    const current = await regularArtifact(path)
    if (
      current === null ||
      !descriptor.isFile() ||
      !sameFile(before, descriptor) ||
      !sameFile(descriptor, current)
    ) {
      unsafe()
    }
    await unlink(path)
  } finally {
    await handle.close()
  }
}

interface TableInfoRow {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

function assertPinnedAccountSchema(db: Database): void {
  for (const table of ACCOUNT_TABLES) {
    const schemaEntry = db
      .query('SELECT type, tbl_name AS tableName FROM sqlite_schema WHERE name = ?')
      .get(table) as { type?: unknown; tableName?: unknown } | null
    if (schemaEntry?.type !== 'table' || schemaEntry.tableName !== table) {
      unsafe()
    }
    const actual = db.query(`PRAGMA table_info(${table})`).all() as TableInfoRow[]
    const expected = PINNED_ACCOUNT_SCHEMA[table]
    if (actual.length !== expected.length) unsafe()
    for (let i = 0; i < expected.length; i++) {
      const got = actual[i]!
      const want = expected[i]!
      if (
        got.name !== want.name ||
        got.type.toUpperCase() !== want.type ||
        got.notnull !== want.notnull ||
        got.dflt_value !== want.defaultValue ||
        got.pk !== want.pk
      ) {
        unsafe()
      }
    }
  }
  const foreignKeys = db.query('PRAGMA foreign_key_list(account_state)').all() as Array<
    Record<string, unknown>
  >
  if (
    foreignKeys.length !== 1 ||
    foreignKeys[0]!.table !== 'account' ||
    foreignKeys[0]!.from !== 'active_account_id' ||
    foreignKeys[0]!.to !== 'id' ||
    foreignKeys[0]!.on_update !== 'NO ACTION' ||
    foreignKeys[0]!.on_delete !== 'SET NULL' ||
    foreignKeys[0]!.match !== 'NONE'
  ) {
    unsafe()
  }
  const trigger = db
    .query(
      `SELECT 1 AS found
       FROM sqlite_schema
       WHERE type = 'trigger'
         AND tbl_name IN ('account_state', 'account', 'control_account')
       LIMIT 1`,
    )
    .get() as { found?: unknown } | null
  if (trigger !== null) unsafe()
}

function assertCheckpointSucceeded(db: Database): void {
  const result = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: unknown } | null
  if (result === null || result.busy !== 0) unsafe()
}

function assertAccountRowsEmpty(db: Database): void {
  for (const table of ACCOUNT_TABLES) {
    const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count?: unknown
    } | null
    if (row === null || row.count !== 0) unsafe()
  }
}

function scrubDatabase(dbPath: string): void {
  let db: Database | null = null
  let inTransaction = false
  try {
    db = new Database(dbPath, { create: false, readwrite: true })
    db.exec('PRAGMA busy_timeout = 0')
    db.exec('PRAGMA foreign_keys = ON')
    const journal = db.query('PRAGMA journal_mode').get() as {
      journal_mode?: unknown
    } | null
    if (journal?.journal_mode !== 'wal') unsafe()
    assertPinnedAccountSchema(db)
    assertCheckpointSucceeded(db)
    db.exec('BEGIN IMMEDIATE')
    inTransaction = true
    db.exec('DELETE FROM account_state')
    db.exec('DELETE FROM account')
    db.exec('DELETE FROM control_account')
    assertAccountRowsEmpty(db)
    db.exec('COMMIT')
    inTransaction = false
    assertCheckpointSucceeded(db)
  } catch (error) {
    if (db !== null && inTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the fail-closed identity error below.
      }
    }
    if (error instanceof ExecutionIdentityFailure) throw error
    unsafe()
  } finally {
    db?.close()
  }
}

function verifyClosedDatabase(dbPath: string): void {
  let db: Database | null = null
  try {
    db = new Database(dbPath, { create: false, readonly: true })
    assertPinnedAccountSchema(db)
    assertAccountRowsEmpty(db)
  } catch (error) {
    if (error instanceof ExecutionIdentityFailure) throw error
    unsafe()
  } finally {
    db?.close()
  }
}

/**
 * Remove all account-bearing state while the server is stopped and the exact
 * store lifecycle lock is held. No global HOME/XDG resolver is accepted.
 */
export async function scrubOpencodeStoreAccountState(
  input: ScrubOpencodeStoreInput,
): Promise<ScrubOpencodeStoreResult> {
  try {
    validateAbsoluteNormalizedPath(input.dbPath)
    if (basename(input.dbPath) !== 'opencode.db') unsafe()
    if (input.kind !== 'fresh' && input.kind !== 'existing') unsafe()
    await assertLiveLock(input.dbPath, input.lock)

    const storeDir = dirname(input.dbPath)
    await ensureNoSymlinkDirectory(storeDir)
    await unlinkRegularNoFollow(join(storeDir, 'auth.json'))

    const db = await regularArtifact(input.dbPath)
    const wal = await regularArtifact(`${input.dbPath}-wal`)
    const shm = await regularArtifact(`${input.dbPath}-shm`)
    if (db === null) {
      if (input.kind === 'existing' || wal !== null || shm !== null) unsafe()
      return { databasePresent: false }
    }

    scrubDatabase(input.dbPath)
    await regularArtifact(input.dbPath)
    await regularArtifact(`${input.dbPath}-wal`)
    await regularArtifact(`${input.dbPath}-shm`)
    verifyClosedDatabase(input.dbPath)
    await regularArtifact(input.dbPath)
    await regularArtifact(`${input.dbPath}-wal`)
    await regularArtifact(`${input.dbPath}-shm`)
    await assertLiveLock(input.dbPath, input.lock)
    return { databasePresent: true }
  } catch (error) {
    if (error instanceof ExecutionIdentityFailure) throw error
    unsafe()
  }
}
