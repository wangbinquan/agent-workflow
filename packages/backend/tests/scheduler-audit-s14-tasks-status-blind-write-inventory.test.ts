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

/** 永久 allowlist：唯一合法的 tasks.status 直写者（setTaskStatus 的 CAS 写）。 */
const STATUS_WRITE_ALLOWLIST: Record<string, number> = {
  'services/lifecycle.ts': 1,
}

/**
 * 非 status 的 `.update(tasks)` 写点快照（精确计数）。
 * 当前唯一一处：limits.ts 在 cancelTask 失败 fallback 后，对已 canceled
 * 任务的 errorSummary/errorMessage 条件覆写（`WHERE status='canceled'`，
 * RFC-097 §2 第 10 行——不翻状态，故不进 status 棘轮）。
 */
const NON_STATUS_UPDATE_TASKS_SNAPSHOT: Record<string, number> = {
  // RFC-164: persistGate writes workgroup_config_json only (gate state on the
  // task's config copy) — never the status column.
  'services/workgroupRunner.ts': 1,
  // RFC-204 T7: the credential sealing gate backfills tasks.cached_repo_id and
  // re-redacts a legacy tasks.repo_url. Both are credential-hygiene columns —
  // the gate never reads or writes `status`.
  'services/repoCredentials.ts': 2,
  'services/limits.ts': 1,
  // RFC-108 T11 (AR-09): circuit-breaker accounting — recordAutoRecoveryAttempt
  // updates auto_recovery_{attempts,window_started_at,suspended};
  // clearAutoRecoverySuspension resets them. Neither touches `status`.
  'services/recoveryBreaker.ts': 2,
  // RFC-165: two-phase workspace tombstone — every writer touches ONLY
  // workspace_pruning_at / workspace_pruned_at (workspace claim /
  // heal-missing-dir / finalize / boot reconcile / iso transient claim +
  // CAS-scoped release). Status flips stay in setTaskStatus; its revive gate
  // READS these columns inside the status CAS.
  'services/gc.ts': 6,
  // RFC-165 (R3-2-r4): the revive gate stamps workspace_pruned_at when the
  // dir vanished pre-tombstone (heal-forward) — companion-column write only.
  'services/lifecycle.ts': 1,
  // RFC-164 PR-3: gate approve/reject + mid-run config edit both rewrite
  // workgroup_config_json (the task-owned runtime copy) — never `status`
  // (the gate's status flip rides transitionTaskStatusByEvent separately).
  // RFC-167 dw-confirm adds NO direct write: approve + reject ride the dw
  // slot through resumeKick's status CAS, and the reject-exhausted round
  // rides it through setTaskStatus extra (Codex impl-gate P1 — the phase
  // and the status can never tear).
  'routes/workgroupTasks.ts': 2,
  // RFC-167: persistDwState writes workgroup_config_json only (dw phase /
  // attempts / generatedDef on the task's config copy) — never `status`
  // (workgroupRunner persistGate 同款).
  'services/dynamicWorkflowRunner.ts': 1,
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

describe('S-14 ratchet: direct tasks.status writes confined to services/lifecycle.ts', () => {
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
      // RFC-097 migration complete — the ratchet is final: any status write
      // outside the allowlist is a violation, full stop.
      violations.push(
        `${file}: ${n} direct tasks.status write(s) outside the allowlist — use setTaskStatus/trySetTaskStatus (services/lifecycle.ts)`,
      )
    }
    expect(violations).toEqual([])
    // allowlist 本身必须被占用：lifecycle.ts 的那 1 处 CAS 写真实存在
    // （防止扫描器失效导致全文件 0 命中的空洞绿）。
    expect(counts.status['services/lifecycle.ts']).toBe(1)
  })

  test('the single allowlisted write carries the rfc097 marker comment', () => {
    const helper = readFileSync(join(BACKEND_SRC, 'services', 'lifecycle.ts'), 'utf8')
    expect(helper).toContain('rfc097-allow-direct-task-status-write')
  })

  test('non-status update(tasks) writes: per-file count snapshot (keep it from creeping)', () => {
    // 红了怎么办：确属必要的非 status 写点（不翻状态、只写伴随列）在
    // 上方 NON_STATUS_UPDATE_TASKS_SNAPSHOT 登记并附理由；翻状态的写点
    // 一律不允许登记，改走 setTaskStatus。
    expect(counts.nonStatus).toEqual(NON_STATUS_UPDATE_TASKS_SNAPSHOT)
  })
})
