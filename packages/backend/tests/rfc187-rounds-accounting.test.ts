// RFC-187 §3-3 (audit design/workgroup-e2e-audit.md §3-3; Codex P1-8) — a workgroup
// host turn that fumbles the envelope/wg-json retries in-place (WG_PROTOCOL_RETRIES,
// raised 1→3 by RFC-186), and EACH attempt mints a fresh __wg_leader__/__wg_member__
// run. `countBudgetUsed` counted them all, so one logical round could burn up to 4 of
// max_rounds. Fix: tag attempt>0 rows `wg-protocol-retry` and exclude that cause from
// the round count (both the lw leader branch AND the fc member branch).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RERUN_CAUSES } from '@agent-workflow/shared'
import { isClarifyRerunCause } from '../src/services/nodeRunMint'

describe('RFC-187 §3-3 — wg-protocol-retry cause', () => {
  test('the cause exists and is NOT a clarify rerun (safe enum default)', () => {
    expect(RERUN_CAUSES).toContain('wg-protocol-retry')
    expect(isClarifyRerunCause('wg-protocol-retry')).toBe(false)
  })
})

describe('RFC-187 §3-3 — source locks', () => {
  const RUNNER = readFileSync(
    resolve(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'resource-catalog',
      'infrastructure',
      'legacy',
      'workgroup',
      'engine.ts',
    ),
    'utf8',
  ).concat(
    readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'resource-catalog',
        'infrastructure',
        'legacy',
        'workgroup',
        'memberTurns.ts',
      ),
      'utf8',
    ),
    readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'services',
        'workgroup',
        'strategies',
        'leaderWorker.ts',
      ),
      'utf8',
    ),
    readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'resource-catalog',
        'infrastructure',
        'legacy',
        'workgroup',
        'strategies',
        'freeCollab.ts',
      ),
      'utf8',
    ),
  )
  // RFC-345 —— provider-neutral 回合账本推导本体。SQLite/PG room adapters
  // 共用 application owner；legacy rounds.ts 只保留 DB read/write mechanics。
  const ROUNDS = readFileSync(
    resolve(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'resource-catalog',
      'application',
      'workgroups',
      'workgroupRoomProjection.ts',
    ),
    'utf8',
  )

  test('protocol retries (attempt>0) mint the wg-protocol-retry cause (leader + assignment)', () => {
    // leader
    expect(RUNNER).toMatch(
      /attempt > 0 \? WG_RERUN_CAUSE\.protocolRetry : WG_RERUN_CAUSE\.leaderRound/,
    )
    // member assignment
    expect(RUNNER).toMatch(
      /attempt > 0 \? WG_RERUN_CAUSE\.protocolRetry : WG_RERUN_CAUSE\.assignment/,
    )
  })

  test('countBudgetUsed excludes wg-protocol-retry in BOTH modes', () => {
    // there must be a rerunCause !== 'wg-protocol-retry' guard for both the lw (leader)
    // and fc (member) counting branches.
    //
    // RFC-345 —— 推导本体搬到 provider-neutral application owner；引擎、
    // SQLite/PG room projection 仍共用一个 exact grammar。
    const occurrences = ROUNDS.split("row.rerunCause !== 'wg-protocol-retry'").length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)
  })
})
