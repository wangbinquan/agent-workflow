// RFC-351 —— SQLite 写事务必须先预占 writer。
//
// 这条测试锁的是 2026-09-02 主干 CI run `33638907352` 上那次「玄学红」：
// `e2e/rfc319-digital-employee-p1.spec.ts` 的 beforeAll 两次
// `POST …/work-items/…/tools/{id}/publish` 都返回 500 `internal-error`，而绿的
// `78dcc5999` 与红的 `f663be47c` 之间生产代码 diff 只有一段注释。
//
// 机制：store 层用的是**裸 deferred** 事务（`db.transaction((tx) => …)`）。它先 SELECT
// 取读快照，再 INSERT/UPDATE 去升级；只要另一个连接在这中间完成一次短提交，升级就以
// `SQLITE_BUSY_SNAPSHOT` **立即**失败——`db/txSync.ts:51-57`（RFC-338 AC-2）写明它会
// **绕过 busy_timeout**，实测 0ms。裸 `SQLiteError` 不是 `DomainError`，于是
// `util/errors.ts` 把它兜成 500 `internal-error`，调用方只看到「内部服务器错误」。
//
// `dbTxSync` 传 `{ behavior: 'immediate' }`，在事务边界就取 writer：竞争者还在写时它
// 在 BEGIN 处等（此时 busy_timeout 生效），拿到锁后读到的是最新快照，不存在升级这一步。
//
// 改造前本文件红（publishTool 抛 SQLITE_BUSY_SNAPSHOT），改造后绿。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '@/db/client'
import { employeeToolRegistrations } from '@/db/schema'
import { createSqliteDigitalEmployeeAuthoringStore } from '@/modules/digital-employee/infrastructure/sqliteAuthoringStore'
import { MIGRATIONS } from './migration-freeze'

const TOOL_ID = 'rfc351-contended'

/** 与出事路径同形的最小 publish 载荷：一条草稿 + 一次发布。 */
function publishInput() {
  const content = {
    schemaVersion: 1 as const,
    typeRef: { typeId: 'development', revision: 10 },
    workItemRef: 'analyze-implement',
    workContractRef: { contractId: 'development.implement-change', version: 1 },
    roleRef: 'primary',
    displayName: 'RFC-351 contended tool',
    description: 'fixture',
    implementation: { kind: 'agent' as const, agentRef: { id: 'agent-1', revision: 1 } },
    connectionRef: null,
  }
  return {
    ref: { id: TOOL_ID, revision: 1 },
    content,
    contentDigest: 'sha256:fixture',
    validationReceipt: {
      schemaVersion: 1 as const,
      status: 'valid' as const,
      checks: [],
      contractRef: { contractId: 'development.implement-change', version: 1 },
      implementationDigest: 'sha256:impl',
      receiptDigest: 'sha256:receipt',
      checkedAt: 1,
    },
    state: 'published' as const,
    publishedAt: 2,
    publishedBy: null,
  }
}

describe('RFC-351 —— 竞争提交下的 store 写事务', () => {
  test('工具发布在另一连接提交的窗口里不再以 SQLITE_BUSY_SNAPSHOT 收场', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc351-contention-'))
    const dbPath = join(root, 'db.sqlite')
    const db = openDb({
      path: dbPath,
      migrationsFolder: MIGRATIONS,
      skipIntegrityCheck: true,
      slowQueryMs: 0,
      // 竞争者只持锁 100ms；1s 足够 BEGIN IMMEDIATE 等到它释放，
      // 又不至于让「真的卡住」这种回归悄悄拖成慢测试。
      busyTimeoutMs: 1_000,
    })
    db.insert(employeeToolRegistrations)
      .values({
        id: TOOL_ID,
        typeId: 'development',
        typeRevision: 10,
        workItemRef: 'analyze-implement',
        draftJson: JSON.stringify({ content: publishInput().content, validationReceipt: null }),
        name: 'RFC-351 contended tool',
        createdAt: 1,
        updatedAt: 1,
      })
      .run()

    const store = createSqliteDigitalEmployeeAuthoringStore(db)
    const worker = new Worker(
      new URL('./fixtures/rfc351-write-contention-worker.ts', import.meta.url).href,
    )
    const nextMessage = (): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => resolve(event.data)
        worker.onerror = (event) => reject(new Error(event.message))
      })

    try {
      const locked = nextMessage()
      worker.postMessage({ dbPath })
      expect(await locked).toEqual({ type: 'locked' })

      const released = nextMessage()
      const startedAt = performance.now()
      // 改造前：这里抛 SQLiteError code=SQLITE_BUSY_SNAPSHOT（0ms，不等 busy_timeout），
      // 经 util/errors.ts 兜底就是一个没有任何解释的 500。
      expect(() => store.publishTool(publishInput())).not.toThrow()
      expect(performance.now() - startedAt).toBeLessThan(1_000)
      expect(await released).toEqual({ type: 'released' })

      const rows = db
        .select({ publishedRevision: employeeToolRegistrations.publishedRevision })
        .from(employeeToolRegistrations)
        .all()
      expect(rows[0]?.publishedRevision).toBe(1)
    } finally {
      worker.terminate()
      ;(db as unknown as { $client: { close(): void } }).$client.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
