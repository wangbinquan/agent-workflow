// RFC-349 — application-owned filesystem assets for PostgreSQL restore.
//
// A portable archive may have been produced by another provider. Restoring its
// config must therefore retain the already-admitted PostgreSQL target profile;
// otherwise a successful logical restore could reboot onto SQLite or the
// source server. Skills and captured worktrees retain the existing restore
// semantics, while task rows are resolved from the restored PostgreSQL target.
//
// RFC-359 W9 —— 为什么这份文件**没有**被合掉，只被削薄
// ====================================================
// 它此前有两半，只有一半是 provider 固有的：
//
//   · 削掉的一半：按 task id 取 worktree 行。原本是手写 SQL（手写 schema 限定名、
//     手写列别名），与 SQLite 侧 `reconstructWorktrees` 是同一条查询；现在两侧共用
//     `portableApplicationAssets.ts` 的中立实现。
//   · 留下的一半：**恢复 config 时把 `database` 段钉回已准入的 PostgreSQL profile**。
//     这一条是真差异，不能拉平：SQLite 的冷还原只接受 `database.provider === 'sqlite'`
//     的归档（`sqlite/systemProviderRestore.ts#verifyPortableDatabasePayload` 直接拒），
//     所以它拷回来的 config 天然指向自己；PostgreSQL 的逻辑还原**接受另一个 provider
//     产出的归档**，原样拷回去就会让还原成功的实例下次启动时连到 SQLite 或备份作者的
//     那台服务器上。两侧因此在同一个用户可见契约（还原完成后实例仍连着自己的库）下
//     采用不同机制。

import { ConfigSchema, type DatabaseConfig } from '@agent-workflow/shared'
import { cpSync, existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { saveConfigRaw } from '@/config'
import type { ProviderNeutralDatabase } from '@/db/query'
import { reconstructWorktrees } from '@/platform/persistence/portableApplicationAssets'
import type { PortableRestoreFilesystemAssets } from './portableDatabaseRestore'

type PostgresqlDatabaseConfig = Extract<DatabaseConfig, { provider: 'postgresql' }>
type ReconstructWorktrees = typeof reconstructWorktrees

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

export function createPostgresqlProviderRestoreApplicationAssets(input: {
  /** Provider-neutral client over the restored target. */
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  /** The already-verified target profile, never the profile stored in the backup. */
  readonly databaseConfig: PostgresqlDatabaseConfig
  /** Infrastructure test seam; production uses provider-neutral reconstruction. */
  readonly reconstructWorktrees?: ReconstructWorktrees
}): PortableRestoreFilesystemAssets {
  const reconstruct = input.reconstructWorktrees ?? reconstructWorktrees
  return Object.freeze({
    async apply({
      stagingDirectory,
      manifest,
    }: Parameters<PortableRestoreFilesystemAssets['apply']>[0]) {
      let config = false
      const stagedConfig = join(stagingDirectory, 'config.json')
      if (existsSync(stagedConfig)) {
        const raw = JSON.parse(readFileSync(stagedConfig, 'utf8')) as unknown
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new Error('portable restore config must be an object')
        }
        const restored = ConfigSchema.parse({
          ...raw,
          database: input.databaseConfig,
        })
        saveConfigRaw(join(input.appHome, 'config.json'), restored)
        config = true
      }

      const stagedSkills = join(stagingDirectory, 'skills')
      const liveSkills = join(input.appHome, 'skills')
      rmSync(liveSkills, { recursive: true, force: true })
      const skills = isRealDirectory(stagedSkills)
      if (skills) cpSync(stagedSkills, liveSkills, { recursive: true })

      if (manifest.includesWorktrees) {
        await reconstruct(input.db, stagingDirectory)
      }
      return Object.freeze({ config, skills })
    },
  })
}
