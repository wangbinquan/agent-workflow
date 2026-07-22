// RFC-217 T8 — migration 0107（真 T17）冻结库回归锁。
//
// WHY THIS FILE EXISTS：0107 是破坏性收口（DROP 两张遗留表 + clarify_rounds
// 重建剥 question_scopes_json）。三个最高风险面各配一组断言：
//   1) 同 ID 双表分歧（设计门 P1——历史修复只写过遗留表）：生命周期字段以
//      遗留表为准 reconcile，统一表独有列（协作草稿/归属）原样保留；
//   2) 仅存在于遗留表的尾数据 INSERT 补齐（0031 前残留形态）；
//   3) RFC-132 两个 boot 垫片折入：answered 未下发的 self 条目补 seal+dispatch
//      并绑 continuation；无 node 级 directive 的 cross stop 补行、已有行
//      （含 canvas re-enable 的 continue）绝不覆盖；
//   4) 重建后 question_scopes_json 消失、RFC-099 协作三列存活、索引齐全。
// 冻结库播种全部用显式列 raw SQL（drizzle HEAD 定义已无遗留表）。

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { LAST_LEGACY_CLARIFY_IDX, MIGRATIONS, freezeAt } from './migration-freeze'

function seedBase(sqlite: Database): void {
  sqlite.run(`INSERT INTO workflows (id, name, definition) VALUES ('wf-x', 'wf-x', '{}')`)
  sqlite.run(
    `INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
       base_branch, branch, status, inputs, started_at)
     VALUES ('t-1', 't-1', 'wf-x', '{}', '/tmp/x', '/tmp/x-wt', 'main', 'aw/t-1', 'running', '{}', 1)`,
  )
  for (const id of ['nr-ask', 'nr-int', 'nr-cont', 'nr-cross-ask', 'nr-cross-int']) {
    sqlite.run(
      `INSERT INTO node_runs (id, task_id, node_id, status, retry_index, iteration, rerun_cause, parent_node_run_id)
       VALUES (?, 't-1', ?, 'done', 0, 0, ?, NULL)`,
      [
        id,
        id === 'nr-cont'
          ? 'asker'
          : id.includes('cross')
            ? 'questioner'
            : id === 'nr-ask'
              ? 'asker'
              : 'clarify-1',
        id === 'nr-cont' ? 'clarify-answer' : 'initial',
      ],
    )
  }
}

describe('rfc217 — migration 0107（T17）', () => {
  test('分歧 reconcile + 尾数据补 INSERT + 垫片折入 + 重建剥列', () => {
    const sqlite = new Database(':memory:')
    const db = drizzle(sqlite)
    migrate(db, { migrationsFolder: freezeAt(LAST_LEGACY_CLARIFY_IDX) }) // through 0106 — 双表仍在
    seedBase(sqlite)

    // A) 同 ID 双表分歧：遗留表 status=awaiting_human（修复重开过），统一表
    //    stale answered；统一表独有列 draft_answers_json 带值须存活。
    sqlite.run(
      `INSERT INTO clarify_sessions (id, task_id, source_agent_node_id, source_agent_node_run_id,
         clarify_node_id, clarify_node_run_id, iteration_index, questions_json, status, answers_json, created_at)
       VALUES ('r-div', 't-1', 'asker', 'nr-ask', 'clarify-1', 'nr-int', 0, '[]', 'awaiting_human', NULL, 10)`,
    )
    sqlite.run(
      `INSERT INTO clarify_rounds (id, task_id, kind, asking_node_id, asking_node_run_id,
         intermediary_node_id, intermediary_node_run_id, loop_iter, iteration, questions_json,
         status, answers_json, answered_at, answered_by, created_at, draft_answers_json)
       VALUES ('r-div', 't-1', 'self', 'asker', 'nr-ask', 'clarify-1', 'nr-int', 0, 0, '[]',
         'answered', '["stale"]', 99, 'user-42', 10, '{"q1":"draft"}')`,
    )

    // B) 仅遗留表有的尾行。
    sqlite.run(
      `INSERT INTO clarify_sessions (id, task_id, source_agent_node_id, source_agent_node_run_id,
         clarify_node_id, clarify_node_run_id, iteration_index, questions_json, status, created_at)
       VALUES ('r-only-legacy', 't-1', 'asker', 'nr-ask', 'clarify-1', 'nr-int', 1, '[]', 'answered', 11)`,
    )

    // C) 垫片 3a：answered round 的 self 条目未下发 + 存在 continuation run。
    sqlite.run(
      `INSERT INTO clarify_rounds (id, task_id, kind, asking_node_id, asking_node_run_id,
         intermediary_node_id, intermediary_node_run_id, loop_iter, iteration, questions_json,
         status, answers_json, answered_at, created_at)
       VALUES ('r-imm', 't-1', 'self', 'asker', 'nr-ask', 'clarify-1', 'nr-int', 0, 0, '[]',
         'answered', '[]', 50, 12)`,
    )
    sqlite.run(
      `INSERT INTO task_questions (id, task_id, origin_node_run_id, role_kind, source_kind,
         question_id, question_title, created_at, updated_at)
       VALUES ('tq-1', 't-1', 'nr-int', 'self', 'self', 'q1', 't', 1, 1)`,
    )

    // D) 垫片 3b：cross stop 无 node 级 directive → 补；另一个已有 continue 的
    //    questioner 绝不被覆盖。
    sqlite.run(
      `INSERT INTO cross_clarify_sessions (id, task_id, cross_clarify_node_id, cross_clarify_node_run_id,
         source_questioner_node_id, source_questioner_node_run_id, loop_iter, iteration,
         questions_json, directive, status, created_at)
       VALUES ('r-cross-stop', 't-1', 'cc-1', 'nr-cross-int', 'questioner', 'nr-cross-ask', 0, 0,
         '[]', 'stop', 'answered', 13),
              ('r-cross-keep', 't-1', 'cc-2', 'nr-cross-int', 'q-keep', 'nr-cross-ask', 0, 0,
         '[]', 'stop', 'answered', 14),
              ('r-cross-shardonly', 't-1', 'cc-3', 'nr-cross-int', 'q-shardonly', 'nr-cross-ask', 0, 0,
         '[]', 'stop', 'answered', 15)`,
    )
    sqlite.run(
      `INSERT INTO task_node_clarify_directives (task_id, node_id, shard_key, directive, updated_at)
       VALUES ('t-1', 'q-keep', '', 'continue', 1),
              ('t-1', 'q-shardonly', 'asker-1', 'continue', 1)`,
    )

    migrate(db, { migrationsFolder: MIGRATIONS }) // applies 0107

    const row = (id: string): Record<string, unknown> =>
      sqlite.query('SELECT * FROM clarify_rounds WHERE id = ?').get(id) as Record<string, unknown>

    // A) 分歧行：生命周期字段回到遗留权威（awaiting_human、答案清空），协作列存活。
    expect(row('r-div').status).toBe('awaiting_human')
    expect(row('r-div').answers_json).toBeNull()
    expect(row('r-div').draft_answers_json).toBe('{"q1":"draft"}')
    // Codex impl-gate P2-1：answered_by 是 RFC-099 归属，reconcile 不覆盖——
    // 遗留修复路径从不维护它（NULL），拷贝会不可逆抹掉真实提交人。
    expect(row('r-div').answered_by).toBe('user-42')
    // B) 尾行补齐。
    expect(row('r-only-legacy').kind).toBe('self')
    expect(row('r-only-legacy').iteration).toBe(1)
    // C) 垫片 3a：条目补 seal+dispatch 并绑 continuation。
    const tq = sqlite.query('SELECT * FROM task_questions WHERE id = ?').get('tq-1') as Record<
      string,
      unknown
    >
    expect(tq.dispatched_at).not.toBeNull()
    expect(tq.sealed_by).toBe('rfc132-migration')
    expect(tq.trigger_run_id).toBe('nr-cont')
    // D) 垫片 3b：补 stop；既有 continue 不被覆盖。
    const dir = (node: string): string | undefined =>
      (
        sqlite
          .query(
            "SELECT directive FROM task_node_clarify_directives WHERE task_id = ? AND node_id = ? AND shard_key = ''",
          )
          .get('t-1', node) as { directive: string } | null
      )?.directive
    expect(dir('questioner')).toBe('stop')
    expect(dir('q-keep')).toBe('continue')
    // Codex impl-gate P2-2：只有 GLOBAL（shard_key=''）行才算覆盖——只有
    // shard 级行的 stopped questioner 仍须补全局 stop 行（resolveCrossNodeStopped
    // 无 shard 读取），且既有 shard 行原样保留。
    expect(dir('q-shardonly')).toBe('stop')
    const shardRow = sqlite
      .query(
        "SELECT directive FROM task_node_clarify_directives WHERE task_id = 't-1' AND node_id = 'q-shardonly' AND shard_key = 'asker-1'",
      )
      .get() as { directive: string } | null
    expect(shardRow?.directive).toBe('continue')
    // 4) 表面收口：遗留表消失、scopes 列消失、协作列存活、索引齐全。
    const tables = sqlite
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('clarify_sessions','cross_clarify_sessions')",
      )
      .all()
    expect(tables).toEqual([])
    const cols = sqlite.query("SELECT name FROM pragma_table_info('clarify_rounds')").all() as {
      name: string
    }[]
    const names = cols.map((c) => c.name)
    expect(names).not.toContain('question_scopes_json')
    for (const keep of ['submitted_by_role', 'answer_attributions_json', 'draft_answers_json'])
      expect(names).toContain(keep)
    const idx = sqlite
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='clarify_rounds' AND name LIKE 'idx_%'",
      )
      .all() as { name: string }[]
    expect(idx.map((i) => i.name).sort()).toEqual([
      'idx_clarify_rounds_asking',
      'idx_clarify_rounds_intermediary',
      'idx_clarify_rounds_kind_status',
      'idx_clarify_rounds_target_consumer',
      'idx_clarify_rounds_task',
    ])
  })
})
