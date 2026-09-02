// ALLOWLIST RATCHET — RFC-097 (audit S-14 / WP-4): tasks.status 直写禁令。
//
// 本文件前身是 CURRENT-BEHAVIOR LOCK（27 处 / 15 文件的盲写普查清单 +
// "尚无 task 级 CAS helper" 的 characterization）。RFC-097 落地了
// services/lifecycle.ts 尾部的 setTaskStatus / trySetTaskStatus（转移表 +
// CAS + 终态闸），按原文件头的处置说明，本文件改写为 RFC-053
// lifecycle-grep-guard 同款的 allowlist 棘轮：
//
//   1. 「`.update(tasks)` 且 `.set({...})` 含 `status:`」的直写，唯一的
//      永久 allowlist 是 services/lifecycle.ts 自身（恰 1 处，即
//      setTaskStatus 内部带 `rfc097-allow-direct-task-status-write` 标记的
//      CAS 写）。其余任何 src 文件出现 status 直写 → 本测试红。
//   2. （已收紧）RFC-097 迁移完成，lifecycleRepair 15 处已全部走 setTaskStatus；
//      status 直写（design §2 表 13-27 行）的迁移属并行分域，尚未全部落地。
//      它们以「逐文件上限」登记——计数只许降不许升（棘轮）；迁移落地后
//      计数自然归零仍绿，届时请顺手删掉对应行（收紧棘轮）。
//      **任何新文件、或既有文件计数上升，一律红**——新写点的作者必须改走
//      setTaskStatus / trySetTaskStatus，而不是登记新豁免。
//   3. 非 status 的 `.update(tasks)` 写点（如 limits.ts 对 errorSummary 的
//      `WHERE status='canceled'` 条件覆写）不在 status 棘轮射程内，但做
//      逐文件计数快照防失控：新增非 status 写点也要有意识地登记于此。
//
// 射程为 packages/backend/src/**（生产代码）；测试文件的 setup 直写、
// scripts/fixup-rfc052 等 src 外的修补脚本按 design §6 注明在射程外。
//
// 扫描器说明：先逐行剔除注释行，再对 `.update(tasks)` 逐个匹配点向后找
// `.set(`，用括号配平截取完整实参文本判断是否含 `status:`——多行
// `.set({\n  status: ... })` 链（lifecycleRepair 的典型形态）也能命中，
// 比 rfc053 守卫的单行正则更严。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')

/**
 * Provider-owned lifecycle kernels are the only legal direct task-status writers.
 * SQLite retains its synchronous CAS kernel; PostgreSQL owns equivalent atomic
 * transactions in its infrastructure adapters. Exact counts make this a frozen
 * authority ledger rather than a growth allowance.
 */
const STATUS_WRITE_ALLOWLIST: Record<string, number> = {
  'platform/persistence/sqlite/taskLifecycle.ts': 1,
  'modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts': 2,
  'modules/task-execution/infrastructure/postgresqlRepositoryPreparationRetryCommand.ts': 3,
  'modules/task-execution/infrastructure/postgresqlTaskExecutionShutdownOperations.ts': 1,
  'modules/task-execution/infrastructure/postgresqlFusionEngineTaskOperations.ts': 1,
  'modules/task-execution/infrastructure/postgresqlSourceTerminationParticipant.ts': 1,
  'modules/task-execution/infrastructure/postgresqlTaskRuntimeLifecyclePersistence.ts': 1,
  'modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction.ts': 1,
  'modules/task-execution/infrastructure/postgresqlWorkgroupTaskRoomTaskParticipant.ts': 2,
  'modules/task-execution/infrastructure/postgresqlChildTaskLifecycleParticipant.ts': 2,
}

/**
 * 非 status 的 `.update(tasks)` 写点快照（精确计数）。
 * These are provider-owned companion-column writes; none changes `status`.
 * The exact per-file snapshot catches a new write authority in either provider.
 */
const NON_STATUS_UPDATE_TASKS_SNAPSHOT: Record<string, number> = {
  'modules/resource-catalog/infrastructure/legacy/workgroup/configActions.ts': 1,
  'modules/source-control/infrastructure/postgresqlRepositoryWorkspaceStore.ts': 1,
  'modules/source-control/infrastructure/sqliteRepositoryWorkspaceStore.ts': 1,
  'modules/system-operations/infrastructure/postgresqlResourceLimitPersistence.ts': 1,
  'modules/system-operations/infrastructure/sqliteResourceLimitPersistence.ts': 1,
  'modules/task-execution/infrastructure/postgresqlChildExecutionLaunchOperations.ts': 1,
  'modules/task-execution/infrastructure/postgresqlSourceTerminationParticipant.ts': 2,
  'modules/task-execution/infrastructure/postgresqlTaskExecutionEffectPersistence.ts': 1,
  'modules/task-execution/infrastructure/postgresqlTaskRecoveryOperations.ts': 2,
  'modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts': 1,
  'modules/task-execution/infrastructure/postgresqlTaskRuntimeLifecyclePersistence.ts': 1,
  'modules/task-execution/infrastructure/postgresqlWorkgroupTaskRoomTaskParticipant.ts': 1,
  'modules/task-execution/infrastructure/sqliteSourceTerminationParticipant.ts': 4,
  'modules/task-execution/infrastructure/sqliteTaskExecutionEffectPersistence.ts': 1,
  'modules/task-execution/infrastructure/sqliteTaskRecoveryOperations.ts': 2,
  // RFC-350：不活跃超时收割在**已经落进 canceled** 的行上覆盖终态原因文案
  // （`error_summary` / `error_message`），不翻状态——写入门本身要求
  // `status='canceled' AND error_summary = cancelTask 的默认值`，抢不到就是空操作。
  // 与上面两条 ResourceLimitPersistence 的 writeLimitReason 完全同形。
  'modules/task-execution/infrastructure/taskIdleTimeoutPersistence.ts': 1,
  'platform/persistence/sqlite/systemWorkspaceGc.ts': 8,
  'platform/persistence/sqlite/taskLifecycle.ts': 1,
  'services/task.ts': 3,
  'services/taskDelete.ts': 2,
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsFiles(p))
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

/** 剔除注释行（替换为空行，保留行号结构），避免 doc 注释里的示例字符串误报。 */
function stripCommentLines(content: string): string {
  return content
    .split('\n')
    .map((line) => (isCommentLine(line) ? '' : line))
    .join('\n')
}

/** 从 `from` 起找到下一个 `.set(`，括号配平截取其完整实参文本；找不到返回 null。 */
function extractSetArg(content: string, from: number): string | null {
  const setMatch = /\.set\s*\(/g
  setMatch.lastIndex = from
  const m = setMatch.exec(content)
  if (!m) return null
  let depth = 1
  const start = setMatch.lastIndex
  for (let i = start; i < content.length; i++) {
    const ch = content[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return content.slice(start, i)
    }
  }
  return null
}

interface SiteCounts {
  status: Record<string, number>
  nonStatus: Record<string, number>
}

function countUpdateTasksSites(): SiteCounts {
  const status: Record<string, number> = {}
  const nonStatus: Record<string, number> = {}
  for (const file of walkTsFiles(BACKEND_SRC)) {
    const rel = relative(BACKEND_SRC, file).split(sep).join('/')
    const content = stripCommentLines(readFileSync(file, 'utf8'))
    const updateRe = /\.update\s*\(\s*tasks\s*\)/g
    for (;;) {
      if (updateRe.exec(content) === null) break
      const setArg = extractSetArg(content, updateRe.lastIndex)
      const bucket = setArg !== null && /\bstatus\s*:/.test(setArg) ? status : nonStatus
      bucket[rel] = (bucket[rel] ?? 0) + 1
    }
  }
  return { status, nonStatus }
}

describe('S-14 ratchet: direct tasks.status writes confined to provider lifecycle persistence', () => {
  const counts = countUpdateTasksSites()

  test('status writes: exactly the allowlist, pending-migration files only ratchet DOWN', () => {
    const violations: string[] = []
    for (const [file, n] of Object.entries(counts.status)) {
      const allowed = STATUS_WRITE_ALLOWLIST[file]
      if (allowed !== undefined) {
        if (n !== allowed) {
          violations.push(
            `${file}: ${n} status write(s), allowlist pins exactly ${allowed} — route new writes through setTaskStatus/trySetTaskStatus`,
          )
        }
        continue
      }
      // The ratchet is final: any status writer outside a reviewed provider
      // lifecycle kernel is a violation, full stop.
      violations.push(
        `${file}: ${n} direct tasks.status write(s) outside the provider lifecycle allowlist`,
      )
    }
    expect(violations).toEqual([])
    // allowlist 本身必须被占用：lifecycle.ts 的那 1 处 CAS 写真实存在
    // （防止扫描器失效导致全文件 0 命中的空洞绿）。
    expect(counts.status['platform/persistence/sqlite/taskLifecycle.ts']).toBe(1)
  })

  test('the single allowlisted write carries the rfc097 marker comment', () => {
    const helper = readFileSync(
      join(BACKEND_SRC, 'platform', 'persistence', 'sqlite', 'taskLifecycle.ts'),
      'utf8',
    )
    expect(helper).toContain('rfc097-allow-direct-task-status-write')
  })

  test('non-status update(tasks) writes: per-file count snapshot (keep it from creeping)', () => {
    // 红了怎么办：确属必要的非 status 写点（不翻状态、只写伴随列）在
    // 上方 NON_STATUS_UPDATE_TASKS_SNAPSHOT 登记并附理由；翻状态的写点
    // 一律不允许登记，改走 setTaskStatus。
    expect(counts.nonStatus).toEqual(NON_STATUS_UPDATE_TASKS_SNAPSHOT)
  })
})
