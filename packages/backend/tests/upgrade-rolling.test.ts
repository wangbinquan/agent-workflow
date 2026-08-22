// RFC-054 W1-6 — rolling upgrade test.
//
// LOCKS: a daemon home stopped at an old migration must (a) accept the
// current migrations folder on startup and apply the missing migrations
// idempotently, (b) end up with the HEAD schema (all 29 entries in
// `__drizzle_migrations` + all current tables present), and (c) remain
// operationally functional — a fresh task driven by the scheduler runs
// through to `done`. A regression in any of these three means existing
// users can't upgrade past whatever migration broke the chain.
//
// Strategy (RFC-054-T6): the test generates the "old home" fixtures
// **at runtime** by truncating drizzle's `_journal.json` to the first
// N entries and running `migrate()` against that partial folder. The
// migration SQL files in `packages/backend/db/migrations/` are by policy
// append-only / immutable (per CLAUDE.md), so the byte-identical SQL
// re-application produces a deterministic schema state at any freeze
// point — no committed fixture files are needed, and the test never
// ages out of step with the SQL.
//
// Three freeze targets per W1-6 plan:
//   - journal idx 1  (0001_cold_sentry)         — earliest schema
//   - journal idx 13 (0014_rfc031_plugins)      — mid-period plugins
//   - journal idx 19 (0020_rfc036_task_collab)  — late, just pre RFC-037

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { eq } from 'drizzle-orm'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { openDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface FreezeTarget {
  /** Drizzle journal idx (0-indexed into `entries[]`). */
  idx: number
  /** Migration `tag` for readable test names. */
  tag: string
}

const FREEZE_TARGETS: FreezeTarget[] = [
  { idx: 1, tag: '0001_cold_sentry' },
  { idx: 13, tag: '0014_rfc031_plugins' },
  { idx: 19, tag: '0020_rfc036_task_collab' },
  { idx: 160, tag: '0161_rfc304_capability_templates' },
]

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

interface Journal {
  version: string
  dialect: string
  entries: JournalEntry[]
}

/** Create a partial migrations folder + apply just the first `idx + 1` migrations
 *  to a fresh sqlite at `outDbPath`. The DB is closed before return.
 */
function freezeAt(idx: number, outDbPath: string): void {
  const fullJournal = JSON.parse(
    readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf-8'),
  ) as Journal
  if (idx < 0 || idx >= fullJournal.entries.length) {
    throw new Error(`freezeAt: idx ${idx} out of range [0, ${fullJournal.entries.length})`)
  }
  const partialMigDir = mkdtempSync(join(tmpdir(), 'aw-rolling-partial-mig-'))
  try {
    mkdirSync(join(partialMigDir, 'meta'), { recursive: true })
    const partialJournal: Journal = {
      ...fullJournal,
      entries: fullJournal.entries.slice(0, idx + 1),
    }
    writeFileSync(
      join(partialMigDir, 'meta', '_journal.json'),
      JSON.stringify(partialJournal, null, 2),
      'utf-8',
    )
    for (const entry of partialJournal.entries) {
      const sqlFile = `${entry.tag}.sql`
      copyFileSync(join(MIGRATIONS, sqlFile), join(partialMigDir, sqlFile))
      const snap = `${String(entry.idx).padStart(4, '0')}_snapshot.json`
      const snapSrc = join(MIGRATIONS, 'meta', snap)
      if (existsSync(snapSrc)) {
        copyFileSync(snapSrc, join(partialMigDir, 'meta', snap))
      }
    }
    const sqlite = new Database(outDbPath, { create: true })
    sqlite.exec('PRAGMA foreign_keys = ON;')
    const db = drizzle(sqlite, {})
    migrate(db, { migrationsFolder: partialMigDir })
    sqlite.close()
  } finally {
    rmSync(partialMigDir, { recursive: true, force: true })
  }
}

function countAppliedMigrations(dbPath: string): number {
  const sqlite = new Database(dbPath, { readonly: true })
  try {
    const row = sqlite.query('SELECT count(*) AS n FROM __drizzle_migrations').get() as {
      n: number
    } | null
    return row?.n ?? 0
  } finally {
    sqlite.close()
  }
}

function listTables(dbPath: string): Set<string> {
  const sqlite = new Database(dbPath, { readonly: true })
  try {
    const rows = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    return new Set(rows.map((r) => r.name))
  } finally {
    sqlite.close()
  }
}

const HEAD_TOTAL_MIGRATIONS = JSON.parse(
  readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf-8'),
).entries.length as number

interface Harness {
  home: string
  cleanup: () => void
}

function buildHarness(label: string): Harness {
  const home = mkdtempSync(join(tmpdir(), `aw-rolling-${label}-`))
  return {
    home,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    },
  }
}

async function seedToyAgent(db: DbClient, name = 'rolling-agent'): Promise<string> {
  const id = ulid()
  await db.insert(agents).values({
    id,
    name,
    description: 'rolling-upgrade test stub',
    outputs: JSON.stringify(['out']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
  return id
}

async function seedToyTask(
  db: DbClient,
  worktreePath: string,
  agentId: string,
): Promise<{ taskId: string }> {
  const workflowId = ulid()
  const taskId = ulid()
  const def = {
    $schema_version: 1,
    inputs: [],
    nodes: [{ id: 'a1', kind: 'agent-single', agentId, agentName: 'rolling-agent' }],
    edges: [],
  }
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rolling-wf',
    definition: JSON.stringify(def),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rolling-task',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rolling-repo-never-read',
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { taskId }
}

function withMockEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

describe('RFC-054 W1-6 — rolling upgrade from old home reaches HEAD + runs toy task', () => {
  let h: Harness
  let label = ''
  beforeEach(() => {
    h = buildHarness(label)
  })
  afterEach(() => h?.cleanup())

  // RFC-301 T4 bumped to 155 with 0155_rfc301_task_launch_origin（tasks 加
  // immutable launch_origin、历史树回填与 mixed-version child trigger）。
  // RFC-300 bumped to 156 with 0156_rfc300_workspace_prune_cause（tasks 加
  // workspace_prune_cause：区分 Webhook 终态清理与既有 GC claim）。
  // RFC-303 bumped to 157 with 0157_rfc303_mr_terminal_control（MR 终态
  // 控制流、稳定流身份与 durable launch/effect ledgers）。
  // RFC-304 PR-0 bumped to 158 with 0158_rfc304_code_round（tasks 加
  // code_round_id：taskExecutionKind 的第四种判别位，软引用无 FK）。
  // RFC-304 PR-1a bumped to 159 with 0159_rfc304_code_work_items（工作项聚合根
  // 与轮次/阶段/AI 尝试四表；身份键用稳定 projectId 而非可变仓库路径）。
  // RFC-304 PR-1c bumped to 160 with 0160_rfc304_concurrency（发布临界区标记 +
  // 合并后的单个 pendingRevision、MR 级 lease 表、可恢复的发布意图表）。
  // RFC-304 PR-2 bumped to 161 with 0161_rfc304_capability_templates（部门层
  // framework / 小组层 binding / 仓库×能力矩阵；binding 刻意无脚本与钩子列——
  // 那个「没有」本身就是权限边界）。
  // RFC-305 bumped to 162 with 0162_rfc305_user_permission_grants（用户 access
  // revision、附加授权集合与 append-only access audit）。
  // RFC-304 PR-4b bumped to 164 with 0164_rfc304_code_findings（意见台账：唯一键
  // (endpoint, stableProjectId, anchorKind, anchorId, fingerprint, generation)，
  // **刻意不含 workItemId**——意见属于这个 MR，不属于恰好观测到它的那个工作项；
  // 挂在工作项上会让工作项重建的那天整段历史脱钩、所有未解决意见被当成新问题重发。
  // generation 进键是为了「消失后又出现」：旧线程已 resolve/标注过，回归必须开新
  // 线程，旧行留作历史，「这个问题反复出现」才答得上来。
  // RFC-304 T30 bumped to 165 with 0165_rfc304_adoption_signals（采纳信号四列）。
  // RFC-304 T36 bumped to 166 with 0166_rfc304_monitor_observations（监视器唤醒
  // 结论表）。监视器最常见的结果是 `noop`——不起 task、不在 MR 说任何话；按 50 个
  // 活跃 MR × 每天 3 次算，一天约 150 次这样的健康唤醒。没有这张表，这 150 次沉默
  // 与「监视器挂了」完全无从区分，而「它到底看没看」的自然补救恰恰是 N7 禁止的
  // 那件事：去轮询一下看看。`event_id` 上的部分唯一索引同时承载 T10e——一条入站
  // 事件只能被一个顶层 capability claim。
  // resolved 与 code_changed **分列**而不是合成一个 adopted：两者恰在有价值的场景
  // 里不一致——代码改了但没 resolve 是作者默默修了，resolve 了但代码没动是作者不
  // 认同；合成一个 flag 会把两者都报成「已采纳」。各带 round_id 是为了让读错的那
  // 个信号能追回是哪一轮观测的，而不是一个无从归属的时间戳。
  // RFC-304 T2c bumped to 167 with 0167_rfc304_code_artifacts（不可变产物）。
  // 存在的理由是「确认的是当时看到的那份改动」：贴出 diff 到人回复之间可能隔几天，
  // 那时 agent 的工作树早没了，重跑模型会产出**另一份**改动却带着同样的说辞。
  // `keep_ref` 不是记账：只被已删除工作树的 detached HEAD 引用的 commit 是不可达的，
  // `git gc` 会在人还没决定时把它回收掉——所以每个产物持一条 ref，释放时删掉。
  // RFC-304 T50b bumped to 168 with 0168_rfc304_produced_mr_index（产出 MR 反向索引）。
  // `requirement` 工作项锚在 **issue** 上，而它的完成条件是「它产出的那个 MR 被合并」；
  // MR 终态事件只带 provider / project / iid，里面根本没有 issue 的影子。没有这张表，
  // 代码合了、平台不知道，需求在活动视图里永远显示「进行中」。反向而不是正向：正向指针
  // 意味着每次合并都要把全库未闭合工作项的 JSON 扫一遍。
  // RFC-306 T10 bumped to 172 with 0172_rfc306_branch_activation（分支激活两列）。
  // `node_run_outputs.active` 是「端口被显式关闭」与「端口输出了空值」的唯一区分点——
  // 没有这一列，两者在库里同形，条件分支就没有可判定的信号；`node_runs.force_activated`
  // 承载「对被跳过的节点点仍然执行」这一次性覆盖。两列都带默认值，旧代码读新库照常。
  test('HEAD journal has 200 entries (sanity — locks the freeze target indices)', () => {
    // If a future migration is added, raise FREEZE_TARGETS' upper index
    // accordingly or this assertion will block the cascade. RFC-058 PR-B T11
    // bumped to 31 with migration 0031_rfc058_clarify_rounds_unify; RFC-059 T2
    // bumped to 32 with migration 0032_rfc059_clarify_rounds_question_scopes;
    // RFC-067 T2 bumped to 33 with migration 0033_rfc067_task_git_identity;
    // RFC-066 PR-A T2 bumped to 34 with migration 0034_rfc066_task_repos;
    // RFC-064 T9 bumped to 35 with migration 0035_rfc064_unify_clarify_iteration;
    // RFC-070 T4 bumped to 36 with migration 0036_rfc070_clarify_consumed_by_run;
    // RFC-072 T1 bumped to 37 with migration 0037_rfc072_node_run_output_kind;
    // RFC-072 follow-up bumped to 38 with 0038_rfc072_backfill_review_output_kind;
    // RFC-075 PR-A bumped to 39 with 0039_rfc075_working_branch_commit_push;
    // RFC-074 PR-B bumped to 40 with 0040_rfc074_provenance_consumed_runs.
    // RFC-074 PR-C bumped to 41 with 0041_rfc074_drop_clarify_iteration.
    // RFC-079 PR-A bumped to 42 with 0042_rfc079_review_multidoc.
    // RFC-098 B3 bumped to 43 with 0043_rfc098_shard_value_hash.
    // RFC-098 B4 (WP-10) bumped to 44 with 0044_rfc098_rerun_cause.
    // RFC-099 B1 bumped to 45 with 0045_rfc099_ownership_acl.
    // RFC-099 B3 bumped to 46 with 0046_rfc099_drop_node_assignments.
    // RFC-101 PR-A bumped to 47 with 0047_rfc101_skill_versioning.
    // RFC-101 PR-B bumped to 48 with 0048_rfc101_fusion.
    // RFC-104 bumped to 49 with 0049_rfc104_builtin_flag.
    // RFC-109 bumped to 50 with 0050_rfc109_task_workflow_version.
    // RFC-108 T9 bumped to 51 with 0051_rfc108_node_run_spawn_binary.
    // RFC-108 T3 bumped to 52 with 0052_rfc108_recovery_events.
    // RFC-108 PR-D bumped to 53 with 0053_rfc108_task_auto_recovery_breaker.
    // RFC-111 PR-B bumped to 54 with 0054_rfc111_runtime.
    // RFC-112 PR-A bumped to 55 with 0055_rfc112_runtimes.
    // RFC-113 PR-A bumped to 56 with 0056_rfc113_runtime_profile.
    // RFC-115 PR-C bumped to 57 with 0057_rfc115_drop_agent_params.
    // RFC-115 PR-E bumped to 58 with 0058_rfc115_drop_agent_snapshot.
    // RFC-118 bumped to 59 with 0059_rfc118_runtime_enabled.
    // RFC-120 PR-A bumped to 60 with 0060_rfc120_task_questions.
    // RFC-120 v2 bumped to 61 with 0061_rfc120_task_questions_staged.
    // RFC-120 T9 bumped to 62 with 0062_rfc120_deferred_dispatch.
    // RFC-120 §18 bumped to 63 with 0063_rfc120_dispatched_at.
    // RFC-122 bumped to 64 with 0064_rfc122_task_node_clarify_directive.
    // RFC-120 §15 bumped to 65 with 0065_rfc120_manual_questions.
    // RFC-126 bumped to 66 with 0066_rfc126_unabandon_clarify_rounds.
    // RFC-127 bumped to 67 with 0067_rfc127_agent_override.
    // RFC-128 P1 bumped to 68 with 0068_rfc128_task_question_sealed.
    // RFC-129 bumped to 69 with 0069_rfc129_review_selection_stale.
    // RFC-129 bumped to 70 with 0070_rfc129_review_round_generation (impl-gate P2 split).
    // RFC-130 PR-A T2 bumped to 71 with 0071_rfc130_node_run_iso.
    // RFC-130 PR-C bumped to 72 with 0072_rfc130_drop_agent_readonly;
    // RFC-132 PR-F bumped to 73 with 0073_rfc132_drop_consumed_by_and_flag.
    // RFC-140 W2 bumped to 74 with 0074_rfc140_auto_dispatch_deferred.
    // flag-audit §8 bumped to 75 with 0075_flag_audit_markdown_file_backfill.
    // RFC-144 T5 bumped to 76 with 0076_rfc144_abandon_superseded_merge_state.
    // RFC-145 T2 bumped to 77 with 0077_rfc145_failure_code.
    // RFC-153 bumped to 78 with 0078_rfc153_drop_runtime_builtin.
    // RFC-154 T1 bumped to 79 with 0079_rfc154_runtime_config_dir.
    // RFC-159 T3 bumped to 80 with 0080_rfc159_scheduled_tasks.
    // RFC-162 bumped to 81 with 0081_rfc162_clarify_unify.
    // RFC-164 T2 bumped to 82 with 0082_rfc164_workgroups.
    // RFC-164 T7 bumped to 83 with 0083_rfc164_workgroup_engine.
    // RFC-164 T13 bumped to 84 with 0084_rfc164_workgroup_tasks.
    // RFC-165 T3 bumped to 85 with 0085_rfc165_task_space.
    // RFC-166 bumped to 86 with 0086_rfc166_agent_inputs.
    // RFC-165 T9 bumped to 87 with 0087_rfc165_scheduled_launch_kind.
    // RFC-167 T2 bumped to 88 with 0088_rfc167_dynamic_workflow_spaces.
    // RFC-167 pivot dropped that table with 0089_rfc167_drop_dynamic_workflow_spaces → 89.
    // RFC-170 T1 bumped to 90 with 0090_rfc170_skills_storage_acl.
    // RFC-175 T0 bumped to 91 with 0091_rfc175_task_source_agent_id.
    // RFC-178 bumped to 92 with 0092_rfc178_remove_external_source_skills.
    // RFC-180 T0 bumped to 93 with 0093_rfc180_workgroup_autonomous.
    // RFC-185 D4 bumped to 94 with 0094_rfc185_workgroup_fan_out.
    // RFC-189 T1 bumped to 95 with 0095_rfc189_wg_round.
    // RFC-193 T1 bumped to 96 with 0096_rfc193_port_artifact.
    // RFC-200 T1 bumped to 97 with 0097_rfc200_envelope_nonce.
    // RFC-204 T2 bumped to 98 with 0101_rfc207_directive_shard.
    // RFC-210 T10 bumped to 102 with 0102_rfc210_submodule_isolation.
    // RFC-211 T1 bumped to 103 with 0103_rfc211_onboarding.
    // RFC-211 §12 bumped to 104 with 0104_rfc211_drop_onboarding (sandbox removed).
    // RFC-215 T2 bumped to 105 with 0105_rfc215_attempt_count.
    // RFC-217 T2 bumped to 106 with 0106_rfc217_workgroup_task_state.
    // RFC-217 T8 bumped to 107 with 0107_rfc217_clarify_unify_t17.
    // RFC-220 T1 bumped to 108 with 0108_rfc220_oauth2_manual_endpoints.
    // RFC-220 D8 bumped to 109 with 0109_rfc220_userinfo_request_style.
    // RFC-221 T1 bumped to 110 with 0110_rfc221_auth_login_policy.
    // RFC-223 PR-1 bumped to 111 with 0111_rfc223_agent_refs_to_id.
    // RFC-223 PR-2 bumped to 112 with 0112_rfc223_pr2_refs_to_id.
    // RFC-223 PR-3a bumped to 113 with 0113_rfc223_pr3_snapshot_ids.
    // RFC-225 T1 bumped to 114 with 0114_rfc225_workgroup_version.
    // RFC-223 PR-3a impl-gate fix bumped to 115 with 0115_rfc223_pr3a_terminal_backfill.
    // RFC-223 PR-5 bumped to 116 with 0116_rfc223_skill_identity.
    // RFC-223 PR-4 bumped to 117 with 0117_rfc223_fusion_provenance.
    // RFC-223 PR-8 bumped to 118 with 0118_rfc223_owner_scoped_names.
    // RFC-224 T14 bumped to 119 with 0119_rfc224_opencode_session_owners.
    // RFC-224 probe-receipt fence bumped to 120 with 0120_rfc224_runtime_probe_fence.
    // RFC-229 workgroup message trigger relation bumped to 122 with 0122.
    // RFC-234 intent-builder five tables bumped to 123 with 0123.
    // RFC-235 intent-turn Session capture bumped to 124 with 0124.
    // RFC-238 bumped to 125 with 0125; RFC-243 to 127 with 0126/0127;
    // RFC-244 task-list query indexes bumped to 128 with 0128.
    // RFC-247 bumped to 130 with 0129/0130.
    // RFC-248 bumped to 132 with 0131_rfc248_repo_groups +
    // 0132_rfc248_memory_repo_group_scope，再到 133 with
    // 0133_rfc248_readonly_dirty（AC-19：只读成员被丢弃的改动处数）。
    // RFC-249 bumped to 135 with explicit group / task directory nodes.
    // RFC-252 bumped to 136 with 0136_rfc252_agent_network（G4 受控出网的
    // agents.network 列；**不回填**，NULL = 未表态 = deny，存量行行为字节不变）。
    // 2026-08-04 runtime extraArgs bumped to 137 with 0137_runtime_extra_args
    // （fork 私有 flag 注入：runtimes.extra_args_json，NULL = 无附加 argv）。
    // RFC-257 bumped to 138 with 0138_rfc257_webhook_triggers（webhook 触发器
    // 五表 + tasks 归属两列；去重 partial unique index 排除 rejected/failed）。
    // RFC-261 bumped to 139 with 0139_rfc261_webhook_delivery_scale（deliveries
    // 表重建 body_json 挪末列 + 过滤×时间组合索引组 + body-retention 部分索引，
    // 10 万投递/天规模收口；无 FK 进出，重建安全）。
    // RFC-269 显式改判：迁移 0140（code_host_connections 表 +
    // tasks.trigger_context_json 列）⇒ 139 → 140。
    // RFC-271 T7 bumped to 141 with 0141_rfc271_resource_bundle_applies
    // （`BundleApply` 引擎的 apply journal，泛化自 intent_apply_journal；
    // 纯新增表 + 三个索引，无 ALTER、无回填、无 FK 进出）。
    // RFC-274 bumped to 142 with 0142_rfc274_workgroup_output_messages
    // （workgroup 交付约定 + 可翻译系统消息元数据；存量交付约定回填 files）。
    // RFC-277 bumped to 143 with 0143_rfc277_gitlab_tls_verification
    // （GitLab 可显式关闭 TLS 证书校验；存量连接默认继续校验）。
    // RFC-276 bumped to 144 with 0144_rfc276_runtime_hardening_deprecation
    // （运行时加固废弃；先归档移除字段，再切换到普通会话互斥租约）。
    // RFC-278 bumped to 145 with 0145_rfc278_legacy_schema_reconciliation
    // （历史 schema 漂移收敛；保留 recovery 审计行并删除退役表）。
    // RFC-279 database redundancy cleanup bumped to 147 after
    // 0146_gitlab_repository_url_prefixes.
    // RFC-280 T3 bumped to 148 with 0148_rfc280_startup_verification
    // （node_runs.startup_verification_json 纯增量列）。
    // RFC-291 面 F bumped to 149 with 0149_rfc291_intent_handle_watermark
    // （intent_sessions.handle_watermark_json 纯增量列，DEFAULT '{}' 无 backfill）。
    // RFC-292 bumped to 150 with 0150_rfc292_trigger_namespace
    // （webhook template v2 版本列 + 合法历史 task context 嵌套 backfill）。
    // RFC-285 T5 bumped to 151 with 0151_rfc285_workflow_soft_link
    // （tasks.workflow_id 硬 FK → durable soft link 的 12-step rebuild）。
    // RFC-293 bumped to 152 with 0152_rfc293_intent_workbench
    // （持续迭代草稿、运行中工作集队列与可重试变更记录）。
    // Claude native-session reset fencing bumped to 153 with
    // 0153_runtime_session_reset_fence（持久化 reset-pending lease 状态）。
    // RFC-297 T17 bumped to 154 with 0154_rfc297_runtime_inventory（node_runs 加
    // runtime_inventory_json：跨运行时统一的清单观测，仅加列不回填）。
    // RFC-301 bumped to 155 with 0155_rfc301_task_launch_origin（根来源归一、
    // 历史树传播、旧 writer child 继承 trigger）。
    // RFC-300 bumped to 156 with 0156_rfc300_workspace_prune_cause（区分
    // Webhook 终态 workspace claim 与 RFC-165/iso GC claim）。
    // RFC-303 bumped to 157 with 0157_rfc303_mr_terminal_control（MR 终态
    // 控制流、稳定流身份与 durable launch/effect ledgers）。
    // RFC-304 bumped to 169 with 0169_rfc304_fix_attempts（CI 修复配额落库：
    // 一轮 = 一次尝试，计数必须跨轮存活，否则「三次」等于「永远」）。
    // RFC-304 T61 bumped to 170 with 0170_rfc304_trigger_deliveries（投递链路落库：
    // 「这个仓的检视突然不工作了」此前问不出结果——readiness/上次触发时间/测试事件
    // 都区分不了「没到」「到了被丢」「排在 lease 后面」，而三者的修法各不相同）。
    // RFC-304 T64 bumped to 171 with 0171_rfc304_template_upstream（复制来源三元组：
    // upstream_id / upstream_version / base_digest。三者都只能在**复制那一刻**写下——
    // 之后源会继续演进，它的 updatedAt 不再描述当初被复制的是什么；缺 base_digest
    // 则合并退化成两路，「上游说 A、本地说 B」分不清是谁改的）。
    // RFC-306 T10 bumped to 172 with 0172_rfc306_branch_activation。
    // RFC-308 hard cut bumped to 173 with 0173_rfc308_workspace_profile。
    // RFC-309 bumped to 174 with 0174_rfc309_capability_templates（两层模板合一：
    // 每个绑定成为一份模板并继承其框架的脚本，**模板 id 延用绑定 id** 使
    // `repo_capability_config` 那一列只需改名不需改值——迁移里最容易错的一环
    // 「矩阵单元格指向漂移」因此不存在；原框架成为各模板的 T64 上游。
    // 顺带把 `anchor_kind` 放宽出 `platform`（平台自己发起的轮次没有代码托管侧
    // 锚点），SQLite 改不了 CHECK，故 code_work_items 与 code_findings 重建）；
    // RFC-310 PR-3 bump 到 178 with 0178_rfc310_mission_input_uploads（上传会话）。
    // RFC-310 PR-2 bump 到 177 with 0177_rfc310_development_missions（Mission/
    // decision/action/attempt/effect/claim/wake/ledger 系列 15 张表）。
    // RFC-310 PR-1B bump 到 176 with 0176_rfc310_development_config_resources
    // （数字员工配置资源：identity+immutable revisions 双表 ×5 + assignment）。
    // RFC-309 T16 再 bump 到 175 with 0175_rfc309_template_base_snapshot（复制
    // 时留下基线**取值**而非只留摘要——摘要只答得了「改没改」，答不了「是谁改的」，
    // 而三方合并要的正是后者）。
    // RFC-311 T28 bump 到 181 with 0181_rfc311_repos_page_index（/repos 分页
    // keyset 需要 (last_fetched_at, id) 全序,复合索引按前缀规则替换旧单列索引）。
    // RFC-311 T19 bump 到 182 with 0182_rfc311_task_archive_audit（归档把任务行
    // 删掉，审计行必须活在任务级联族之外）。
    // RFC-311 G1 bump 到 183 with 0183_rfc311_tasks_root_task_id（物化树根，让
    // 过滤视图的 root 选取从两条递归 CTE 塌缩成一次 GROUP BY）。
    // RFC-311 G2 bump 到 184 with 0184_rfc311_overview_covering_indexes（首页
    // 四张卡片与工作组徽章的谓词列进索引，免掉每行回表）。
    // RFC-311 T21 bump 到 185 with 0185_rfc311_node_run_prompt_path（prompt 正文
    // 外置到文件，行里只留路径；旧行不回填，读点双读）。
    // RFC-310 PR-12 bump 到 187 with 0186_rfc310_task_platform_inputs（任务级平台
    // 输入挂载名册，Agent 隔离工作树里强制入快照）+ 0187_rfc310_playbook_sagas
    // （step-run / mission-link / approval-saga / step-join 四张表）。
    // RFC-312 bump 到 188 with 0188_rfc312_users_presence_grant（给存量 user/manager
    // 补一条 `users:presence` 显式 grant；admin 由动态全量 baseline 天然持有故跳过，
    // guest 与 __system__ 亦跳过。新建用户不依赖它——三条建号路径共用同一策略）。
    // RFC-311 bump 到 189 with 0189_rfc311_perf_guard_indexes（三条索引，全部由
    // tests/rfc311-perf-guards.test.ts 在 EXPLAIN 里实测出 TEMP B-TREE / 裸表 SCAN
    // 后补的：mission keyset 的 (created_at,id)、/repos 子模块健康 facet、页内富化
    // 的 (cached_repo_id,task_id) 分组）。
    // RFC-311 bump 到 190 with 0190_rfc311_live_tasks_index（巡检 sweep 的活任务
    // 部分索引，替掉每小时一次的 tasks 裸全表扫描）。
    // RFC-310 bump 到 200：0191 是 Mission reopen lineage；0192 是数字员工
    // OS authoring/Event Center/Context/queue/channel 与单 writer 持久化面；
    // 0193–0198 依次补自定义事件来源、独立多播投递、WorkStart/生命周期事件、
    // 通用事件任务的 exact delivery provenance、来源无关的响应规则和审计索引，
    // 以及公开目录与兼容入站事件的持久化隔离；0199 把早期构建残留的
    // `code-host.webhook` 第二套公开目录降为只读兼容历史；0200 为数字员工卡片
    // 的 Case 与旧 Mission 终态分组投影增加 covering indexes。
    // RFC-315 bump 到 201 with 0202_rfc315_event_automation_permissions：统一
    // Webhook / Event Center 自动化规则权限，并迁移 account grant 与 PAT scope。
    // 0201 已由共享工作树中的 RFC-310 并发改动预留，故本提交不复用该文件名。
    // 外部 reopen 已关闭的 MR 时终态不逆转，另建带链接的新 Mission generation——
    // 这一列就是那条链接。不复用 development_mission_links：它的 parent_step_run_id
    // NOT NULL，而 reopen 不由任何 playbook step 触发）。
    expect(HEAD_TOTAL_MIGRATIONS).toBe(201)
  })

  test('journal `when` timestamps are strictly increasing', () => {
    // RFC-210 shipped 0102 with a real `Date.now()` (2026-07-20) while this
    // journal runs on a synthetic +1day/entry axis that is already months into
    // the future — so 0102 sorted BEFORE 0101. Drizzle's SQLite migrator reads
    // the newest applied `created_at` once and then applies a migration only
    // when `lastDbMigration.created_at < migration.folderMillis`
    // (drizzle-orm/sqlite-core/dialect.cjs). A non-monotonic entry is therefore
    // skipped forever on every upgrade — silently: `migrate()` does not throw,
    // the daemon boots, and only later does every query against the new columns
    // die with `no such column`.
    //
    // Nothing else here can see it. Every other DB test (and the freeze targets
    // below, which stop far earlier) builds from scratch, where
    // `lastDbMigration` is undefined and all entries apply unconditionally. New
    // migrations must continue the synthetic axis: previous `when` + 86400000.
    const entries = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf-8'))
      .entries as Array<{ idx: number; when: number; tag: string }>
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]!
      const cur = entries[i]!
      expect({ tag: cur.tag, after: prev.tag, increasing: cur.when > prev.when }).toEqual({
        tag: cur.tag,
        after: prev.tag,
        increasing: true,
      })
    }
  })

  for (const target of FREEZE_TARGETS) {
    test(`from journal idx ${target.idx} (${target.tag}): partial apply + upgrade + toy task`, async () => {
      label = `idx${target.idx}`
      const dbPath = join(h.home, 'db.sqlite')

      // 1. Freeze: create a DB stopped at this migration.
      freezeAt(target.idx, dbPath)

      // 2. Partial state should match — N + 1 migrations applied.
      expect(countAppliedMigrations(dbPath)).toBe(target.idx + 1)

      // 3. Open with full migrations folder → drizzle applies the rest.
      const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })

      try {
        // 4. Post-upgrade verification: full journal applied.
        expect(countAppliedMigrations(dbPath)).toBe(HEAD_TOTAL_MIGRATIONS)

        // Key HEAD-state tables must be present (each was added in a
        // migration AFTER our latest freeze target idx 19, so all three
        // freeze points must produce them after the upgrade run).
        const tableNames = listTables(dbPath)
        expect(tableNames.has('users')).toBe(true) // 0018
        expect(tableNames.has('task_collaborators')).toBe(true) // 0020
        expect(tableNames.has('memories')).toBe(true) // 0023
        expect(tableNames.has('lifecycle_alerts')).toBe(true) // 0028

        // 5. Toy task — proves the upgraded DB is operationally usable end-to-
        // end (writes accepted by current schema, scheduler can dispatch a
        // single-node DAG, runner integration with mock-opencode lands done).
        const worktreePath = join(h.home, 'wt')
        mkdirSync(worktreePath, { recursive: true })
        const agentId = await seedToyAgent(db)
        const { taskId } = await seedToyTask(db, worktreePath, agentId)

        await withMockEnv(
          { MOCK_OPENCODE_OUTPUTS: JSON.stringify({ out: 'rolling upgrade output' }) },
          () =>
            runTask({
              taskId,
              db,
              appHome: h.home,
              binaryOverride: ['bun', 'run', MOCK_OPENCODE],
            }),
        )

        const finalTask = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
        expect(finalTask?.status).toBe('done')

        const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
        const a1 = runs.find((r) => r.nodeId === 'a1')
        expect(a1?.status).toBe('done')
      } finally {
        /* db isn't explicitly closed — Bun teardown handles it; the home
           rmSync in afterEach removes the .sqlite + WAL files. */
      }
    })
  }
})

// ---------------------------------------------------------------------------
// RFC-120 §18 — migration 0063 rolling-upgrade backfill (Codex ship-gate H1).
// A row dispatched under the PRIOR (pre-§18) contract has trigger_run_id set +
// the new dispatched_at NULL. The corrected park gate keys on dispatched_at, so
// 0063 must BACKFILL dispatched_at for such rows (scoped to deferred tasks) or
// the gate re-parks / duplicate-mints them on upgrade.
// ---------------------------------------------------------------------------
describe('RFC-120 §18 — migration 0063 dispatched_at backfill', () => {
  test('0063 backfills dispatched_at for pre-§18 deferred bound rows; leaves unbound + non-deferred NULL', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'aw-0063-backfill-')), 'db.sqlite')

    // 1. Freeze at idx 61 (0062_rfc120_deferred_dispatch) — schema BEFORE dispatched_at.
    freezeAt(61, dbPath)

    // 2. Insert pre-§18 rows with raw SQL (the dispatched_at column does not exist yet).
    {
      const sqlite = new Database(dbPath)
      sqlite.exec('PRAGMA foreign_keys = OFF;')
      const insTask = (id: string, deferred: number): void => {
        sqlite.run(
          `INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path, base_branch, branch, status, inputs, started_at, deferred_question_dispatch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id,
            'n',
            'wf',
            '{}',
            '/tmp',
            '',
            'main',
            `b_${id}`,
            'running',
            '{}',
            Date.now(),
            deferred,
          ],
        )
      }
      insTask('t_def', 1)
      insTask('t_nondef', 0)
      const insTQ = (id: string, taskId: string, trigger: string | null): void => {
        // distinct origin per row → satisfies UNIQUE(origin, question_id, role_kind).
        sqlite.run(
          `INSERT INTO task_questions (id, task_id, origin_node_run_id, question_id, question_title, source_kind, role_kind, trigger_run_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [id, taskId, `o_${id}`, 'q1', 't', 'cross', 'designer', trigger, 1000, 1000],
        )
      }
      insTQ('tq_def_bound', 't_def', 'run_x') // deferred + bound → BACKFILL
      insTQ('tq_def_unbound', 't_def', null) // deferred + never bound → stays NULL
      insTQ('tq_nondef_bound', 't_nondef', 'run_y') // non-deferred → golden-lock NULL
      sqlite.close()
    }

    // 3. Apply the full migrations folder → drizzle applies 0063..HEAD.
    //    RFC-285 T5 改锚：重放期 FK OFF、结束后 ON——受支持的迁移重放契约
    //    （RFC-115 F1，openDb 同姿势）。原 FK ON 重放在 0151（tasks 父表
    //    12-step rebuild）落地后会把 seeded 行经 DROP 级联清掉。
    {
      const sqlite = new Database(dbPath)
      sqlite.exec('PRAGMA foreign_keys = OFF;')
      migrate(drizzle(sqlite, {}), { migrationsFolder: MIGRATIONS })
      sqlite.exec('PRAGMA foreign_keys = ON;')
      sqlite.close()
    }

    // 4. Assert the backfill.
    {
      const sqlite = new Database(dbPath, { readonly: true })
      const dispatchedAt = (id: string): number | null =>
        (
          sqlite.query(`SELECT dispatched_at AS d FROM task_questions WHERE id = ?`).get(id) as {
            d: number | null
          } | null
        )?.d ?? null
      // deferred + bound → backfilled to the row's own created_at (1000).
      expect(dispatchedAt('tq_def_bound')).toBe(1000)
      // deferred + never bound (trigger_run_id NULL) → NOT backfilled (still undispatched).
      expect(dispatchedAt('tq_def_unbound')).toBeNull()
      // non-deferred → untouched (golden-lock; that contract never set trigger_run_id this way).
      expect(dispatchedAt('tq_nondef_bound')).toBeNull()
      sqlite.close()
    }
  })
})
