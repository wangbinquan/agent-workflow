// RFC-311 §6.6 —— 「备份进行中，task-operations catalog 仍然快」。
//
// 这条验收此前**结构成立但零测试**（bench-results §G4 如实记账过），而它恰恰是本
// RFC 自己一度重新引入的形态：C5 把 WAL checkpoint 循环改成默认开，
// `PRAGMA wal_checkpoint(TRUNCATE)` 撞上备份的活跃 reader 时会阻塞满 busy_timeout
// （实测 5310ms），且跑在 daemon 的**同步主连接**上——那 5 秒整站冻结，正是 §6.6
// 要消灭的事。修复（快照期间 checkpoint 让路 + VACUUM INTO 移出主线程）落在实现门
// 里，但没有护栏：没有测试的话，下一个人把 `isDbSnapshotInProgress()` 这层判断删掉
// 不会有任何信号。
//
// 本文件锁三件事：
//   1. 快照进行中时 checkpoint tick **跳过**而不是阻塞；
//   2. 快照期间照常取页，且耗时不被快照拖住（真做一次 VACUUM INTO 计时）；
//   3. 快照结束后 checkpoint 恢复正常执行（让路是临时的，不是永久关闭）。

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildActor, type Actor } from '../src/auth/actor'
import { openDb } from '../src/db/client'
import { tasks, users, workflows } from '../src/db/schema'
import { isDbSnapshotInProgress, vacuumIntoOffThread } from '../src/services/backup'
import { runWalCheckpointTick } from '../src/services/backupScheduler'
import { listTaskOperationsPage } from '../src/services/taskOperations'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function admin(): Actor {
  return buildActor({
    user: { id: 'admin', username: 'admin', displayName: 'admin', role: 'admin', status: 'active' },
    source: 'session',
  })
}

describe('RFC-311 §6.6 — a running backup must not freeze the task list', () => {
  test('checkpoint yields during a snapshot, the page still answers, and checkpoint resumes after', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aw-rfc311-backup-'))
    try {
      const dbPath = join(home, 'db.sqlite')
      const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
      await db.insert(users).values({
        id: 'admin',
        username: 'admin',
        displayName: 'admin',
        role: 'admin',
        createdAt: 1,
        updatedAt: 1,
      })
      await db.insert(workflows).values({ id: 'wf1', name: 'wf', definition: '{}' })
      // 够多的行，让 VACUUM INTO 真的要干活（而不是瞬间返回）。
      for (let i = 0; i < 400; i += 1) {
        await db.insert(tasks).values({
          id: `t${String(i).padStart(4, '0')}`,
          name: `task ${i}`,
          workflowId: 'wf1',
          workflowSnapshot: '{}',
          repoPath: '/tmp/never-read',
          worktreePath: '/tmp/never-read',
          baseBranch: 'main',
          branch: `agent-workflow/t${i}`,
          status: i % 3 === 0 ? 'running' : 'done',
          inputs: '{}',
          startedAt: 1_000 + i,
          finishedAt: i % 3 === 0 ? null : 2_000 + i,
          runningMs: 0,
          ownerUserId: 'admin',
          launchOrigin: 'manual',
          branchStartedAt: 1_000 + i,
          rootTaskId: `t${String(i).padStart(4, '0')}`,
        })
      }

      expect(isDbSnapshotInProgress()).toBe(false)
      expect(runWalCheckpointTick(db)).toBe('checkpointed')

      // 真做一次快照，并在**快照进行中**打页面 + 打 checkpoint。
      const sqlite = new Database(dbPath)
      const dest = join(home, 'snapshot.sqlite')
      let duringSnapshot: { tick: string; pageMs: number; items: number } | null = null
      const snapshot = vacuumIntoOffThread(sqlite, dbPath, dest).finally(() => {
        sqlite.close()
      })
      // 快照期间(计数器 >0)取一次页并给 checkpoint 一拍。
      while (!isDbSnapshotInProgress()) await new Promise((r) => setTimeout(r, 1))
      const tick = runWalCheckpointTick(db)
      const t0 = performance.now()
      const page = await listTaskOperationsPage(db, admin(), { limit: '50' })
      const pageMs = performance.now() - t0
      duringSnapshot = { tick, pageMs, items: page.items.length }
      await snapshot

      // ① checkpoint 让路而不是阻塞满 busy_timeout。
      expect(duringSnapshot.tick).toBe('skipped-snapshot')
      // ② 页面照常回答，且没有被快照拖住(阻塞形态是秒级；这里给 2s 的宽裕上限,
      //    它抓的是「冻结」而不是「慢一点」)。
      expect(duringSnapshot.items).toBe(50)
      expect(duringSnapshot.pageMs).toBeLessThan(2_000)
      // ③ 让路是临时的:快照结束后 checkpoint 必须恢复执行。
      expect(isDbSnapshotInProgress()).toBe(false)
      expect(runWalCheckpointTick(db)).toBe('checkpointed')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
