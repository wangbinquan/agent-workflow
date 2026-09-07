// RFC-359 —— **同步 SQLite 事务面**的高水位账本（只降不升）。
//
// 为什么要有这条账本：RFC-359 的目标是「以后不允许再出现两种数据库一个好一个不好的分支」。
// 而制造这种分支最省事的办法，就是在 SQLite 侧写一笔 `dbTxSync`（或它之上的 `withOwnedTaskTx`）——
// 那是 bun:sqlite 独有的**同步**事务面，PostgreSQL 上不存在，于是那条路径天然只有一个 provider
// 能走，另一个引擎要么另写一份（覆盖倒挂、行为漂移），要么干脆没有。本轮实做已经两次撞上它：
//   - W4-D23b：技能机器迁到中立事务后落不了地，因为它的提交面被 bundle apply 的**同步大事务**调用；
//   - 剩余 task-execution 对：同样卡在 `withOwnedTaskTx` 这条同步 owned-write 原语上。
// 也就是说 RFC-359 的剩余工作**不是 N 个独立的 pair 合并**，而是**一件事**：把这 129 个
// 同步调用点迁到已经存在的中立原语（`platform/persistence/databaseTransaction.ts` 的
// `databaseSessionFor` / `withTaskExecutionWrite` / `withTaskExecutionSerializable`），pair 合并会随之落地。
//
// 这条账本把「还剩多少」变成可计数、可防守的量：
//   - **只降不升**（RFC-317 T17 的高水位机制，已在 `architecture/ledger-baselines.json` 注册）：
//     新增一个同步调用点就红，逼你要么用中立原语，要么把新增写进账本并说明为什么；
//   - **逐字相等**：收敛了也要红——把账本一起改小，让每一次减少都留下一次提交记录。
// 计数方式与 `docs/dev-gotchas.md` 里那条一致：按 `dbTxSync(` 与 `withOwnedTaskTx(` 的调用点数，
// 不含它们各自的定义文件。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

/** `<相对 src 的路径>: <同步事务调用点数>`，按路径字典序。只降不升。 */
export const SYNC_TRANSACTION_DEBT: readonly string[] = [
  'modules/collaboration/infrastructure/legacySqliteClarifyRounds.ts: 1',
  'modules/collaboration/infrastructure/legacySqliteTaskCollab.ts: 1',
  'modules/collaboration/infrastructure/legacySqliteTaskQuestions.ts: 3',
  'modules/collaboration/infrastructure/sqliteCollaborationWorkgroupClarify.ts: 1',
  'modules/collaboration/infrastructure/sqliteReviewRepairParticipant.ts: 2',
  'modules/intent/infrastructure/sqliteIntentApplyOperations.ts: 9',
  'modules/intent/infrastructure/sqliteIntentSqlProgramRunner.ts: 2',
  'modules/resource-catalog/infrastructure/legacy/agent.ts: 5',
  'modules/resource-catalog/infrastructure/legacy/importRefs.ts: 1',
  'modules/resource-catalog/infrastructure/legacy/workflow.ts: 2',
  'modules/resource-catalog/infrastructure/legacy/workgroup/state.ts: 1',
  'modules/resource-catalog/infrastructure/legacy/workgroups.ts: 2',
  'modules/task-execution/infrastructure/sqliteProcessEffectObserver.ts: 1',
  'modules/task-execution/infrastructure/sqliteSourceTerminationParticipant.ts: 3',
  'modules/task-execution/infrastructure/sqliteTaskExecutionEffect.ts: 5',
  'modules/task-execution/infrastructure/sqliteTaskExecutionEffectPersistence.ts: 1',
  'modules/task-execution/infrastructure/sqliteTaskExecutionIntent.ts: 1',
  'modules/task-execution/infrastructure/sqliteTaskExecutionIntentAdmission.ts: 1',
  'modules/task-execution/infrastructure/sqliteTaskOwnership.ts: 5',
  'modules/task-execution/infrastructure/sqliteTerminalMaintenance.ts: 5',
  'platform/events/committed/sqliteStore.ts: 2',
  'platform/persistence/sqlite/legacyResourcePackageBundleApply.ts: 4',
  'platform/persistence/sqlite/maintenanceRunStore.ts: 4',
  'platform/persistence/sqlite/systemWorkspaceGc.ts: 1',
  'platform/persistence/sqlite/taskLifecycle.ts: 4',
  'services/task.ts: 3',
  'services/taskArchive.ts: 1',
  'services/taskDelete.ts: 1',
]

function scan(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(rel)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      if (rel === 'db/txSync.ts') continue // 原语自己的家
      const text = readFileSync(join(SRC, rel), 'utf8')
      const sync = (text.match(/\bdbTxSync\(/g) ?? []).length
      const owned =
        rel === 'modules/task-execution/infrastructure/sqliteTaskOwnership.ts'
          ? 0 // 同上：`withOwnedTaskTx` 的定义处
          : (text.match(/\bwithOwnedTaskTx\(/g) ?? []).length
      if (sync + owned > 0) out.push(`${rel}: ${sync + owned}`)
    }
  }
  walk('')
  return out.sort()
}

/** 扫到的全部 backend 源文件——语料下限的分母（RFC-317 T13：扫空 = 假绿）。 */
function corpusFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith('.ts')) out.push(rel)
    }
  }
  walk('')
  return out
}

describe('RFC-359 —— 同步 SQLite 事务面只降不升', () => {
  test('语料非空：确实扫到了整棵 backend 源码树（扫成 0 说明扫描根失效，此刻零预言力）', () => {
    expect(corpusFiles().length).toBeGreaterThanOrEqual(800)
  })

  test('逐文件调用点数与账本逐字相等（增了是新的单引擎分支，减了是收敛，都要改账本）', () => {
    expect(
      scan(),
      '同步事务面（`dbTxSync` / `withOwnedTaskTx`）的逐文件调用点数与账本不符。' +
        '**增**了说明有人在 SQLite 侧新开了一条 PostgreSQL 走不了的路——改用 ' +
        '`databaseSessionFor(db).transaction(...)` 等中立原语；确有理由就把新增写进账本并说明。' +
        '**减**了说明收敛发生了——把账本一起改小，让这次减少留下一次有署名的提交记录。',
    ).toEqual([...SYNC_TRANSACTION_DEBT])
  })

  test('账本按路径字典序、无重复（清点稳定的前提）', () => {
    const paths = SYNC_TRANSACTION_DEBT.map((row) => row.slice(0, row.lastIndexOf(':')))
    expect(new Set(paths).size, '账本里有重复路径').toBe(paths.length)
    expect([...paths].sort()).toEqual(paths)
  })
})
