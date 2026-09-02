// RFC-349 — crash-safe raw SQLite rollback snapshot. The heavy VACUUM INTO and
// the equally heavy `PRAGMA quick_check` both run on the existing backup
// worker; the operation directory receives the file only after integrity
// verification and atomic replacement.

import { Database } from 'bun:sqlite'
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseMigrationSafetyBackupPort } from '../application/databaseMigrationRunner'
import { quickCheckOffThread, vacuumIntoOffThread } from '@/services/backup'
import { createSha256DigestBuilder } from '@/util/hash'

async function digestFile(path: string): Promise<string> {
  const hash = createSha256DigestBuilder()
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return `sha256:${hash.digestHex()}`
}

function fsyncDirectory(path: string): void {
  try {
    const handle = openSync(path, 'r')
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
  } catch {
    // Some Windows/filesystem combinations cannot fsync a directory.
  }
}

/**
 * RFC-349 —— 校验必须离开主线程。
 *
 * `PRAGMA quick_check` 要把整个文件读一遍，bun:sqlite 又是同步的：本机对 4.2GB 的库
 * 实测单次 4.4 秒。这里原本还跑**两遍**（临时文件一遍、改名后的目标再一遍，而改名不改
 * 一个字节），于是一次大迁移的安全备份把 daemon 的事件循环按住 —— 本机全量取证实测
 * 停顿 18.1 秒、托管 Linux 上 11.1 秒，期间 100 个客户端的 status 轮询集体超时
 * （`migration status errors=101 ≈ 100 客户端 × 1 次停顿`）。
 *
 * 现在：只在**发布前**校验一次（临时文件），并且走 backup worker。
 */
async function verifySqlite(path: string): Promise<void> {
  try {
    await quickCheckOffThread(path)
  } catch (error) {
    throw new Error('SQLite migration safety backup failed quick_check', { cause: error })
  }
}

export function createSqliteMigrationSafetyBackup(): DatabaseMigrationSafetyBackupPort {
  const port: DatabaseMigrationSafetyBackupPort = {
    async create(input) {
      const destination = join(input.operationRoot, 'source-backup', 'db.sqlite')
      if (existsSync(destination)) {
        await verifySqlite(destination)
        return { path: destination, digest: await digestFile(destination) }
      }
      mkdirSync(dirname(destination), { recursive: true })
      const temporary = `${destination}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`
      const source = new Database(input.sourcePath, { readonly: true })
      try {
        await vacuumIntoOffThread(source, input.sourcePath, temporary)
      } finally {
        source.close()
      }
      try {
        await verifySqlite(temporary)
        // Windows FlushFileBuffers requires a write-capable file handle.
        const handle = openSync(temporary, 'r+')
        try {
          fsyncSync(handle)
        } finally {
          closeSync(handle)
        }
        renameSync(temporary, destination)
        try {
          chmodSync(destination, 0o600)
        } catch {
          // Non-POSIX filesystems still retain the atomic snapshot contract.
        }
        fsyncDirectory(dirname(destination))
        // No second quick_check here: `renameSync` moves the very bytes that were
        // just verified, so re-reading the whole multi-GB file proves nothing and
        // costs another full-file stall.
        return { path: destination, digest: await digestFile(destination) }
      } finally {
        if (existsSync(temporary)) rmSync(temporary, { force: true })
      }
    },
  }
  return Object.freeze(port)
}
