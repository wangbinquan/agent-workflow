// RFC-359 W1-T7e —— 工作组宿主回合的输出协议块（纯函数），两个 provider 共用。
//
// 此前只有 SQLite 的 legacy 回合执行（`infrastructure/legacy/workgroup/turnExecution.ts`）拼这份
// 完整协议（角色说明、端口、信封规则、按 RFC-207 §3.7.2 判定后的 <workflow-clarify> 反问邀请）；
// provider-中立的 `workgroupTurnsDriver.ts`（PostgreSQL 在用）只有一个 4 行 stub，agent 永远不知道
// 可以向人提问（dual-provider-parity-audit P0-12）。渲染器从 legacy/context.ts 原样迁到这里。

import {
  CLARIFY_STRUCTURAL_RULES,
  clarifyFormatExample,
  envelopeOpenTag,
  resolveWorkgroupSwitches,
  WG_MAX_ASSIGNMENTS_PER_TURN,
  WG_PORT_ASSIGNMENTS,
  WG_PORT_DECISION,
  WG_PORT_MESSAGES,
  WG_PORT_RESULT,
  WG_PORT_TASK_RESULTS,
  WG_PORT_TASKS_ADD,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'

// ---------------------------------------------------------------------------
// Protocol blocks (design §5) — replace the agent's own outputs protocol.
// English, mirroring shared/src/prompt.ts buildProtocolBlock conventions.
// ---------------------------------------------------------------------------

export type WorkgroupProtocolRole = 'leader' | 'worker' | 'fc_member'

// RFC-185 e2e hardening — the literal envelope shape example matters: without
// it, weaker models reinvent the tags (a live glm-5.2 leader emitted a bare
// <wg_output><wg_assignments> structure → envelope-missing → wasted retries).
function renderEnvelopeRules(envelopeNonce: string): string {
  const lines = [
    'Respond with EXACTLY ONE <workflow-output> envelope at the very end of your reply.',
    'Every port body is a JSON document — no markdown fences inside ports.',
    'The envelope shape is LITERAL — <workflow-output> and <port> are fixed tag',
    'names; never invent your own (e.g. a bare <wg_output> tag is WRONG). Port',
    'names go in the name attribute. Shape:',
    envelopeOpenTag(envelopeNonce),
    '<port name="port_name">{ …json… }</port>',
    '</workflow-output>',
  ]
  if (envelopeNonce.length > 0) {
    lines.splice(
      1,
      0,
      `The nonce="${envelopeNonce}" attribute is REQUIRED and must match exactly; bare or different-nonce envelopes are ignored.`,
    )
  }
  return lines.join('\n')
}

// Human ask-back (<workflow-clarify>) block, appended by renderWgProtocolBlock for EVERY role
// (RFC-172 route 2 — see point 2). Two incidents forced BOTH the shape and the (former) scoping:
//
//   1. 2026-07-12 (task 01KXBATKFJ73MDYNM6YN2DMA29): the protocol INVITED a
//      <workflow-clarify> envelope, but a host node runs with clarify directive
//      'suppressed' (scheduler.ts runHostNode), so the normal clarify FORMAT
//      block (shared/prompt.ts buildClarifyProtocolBlock) was NEVER injected. The
//      leader wrote natural-language questions; the body failed JSON.parse
//      ('clarify-questions-malformed') and the turn fatally killed the task at
//      round 0. So the invite and its schema MUST travel together — reuse the
//      SHARED clarify constants so this can never drift from the normal-node one.
//
//   2. Codex review found members share the SHARED __wg_member__ node (separated
//      only by node_runs.shard_key), which the clarify queue machinery originally
//      ignored — so an early member clarify would cross-contaminate siblings. RFC-172
//      route 2 made the whole dispatch/mint + selectAgentQueue pipeline shardKey-aware
//      (S0–S3, R2-T3), so a member clarify NOW round-trips to its OWN assignment shard
//      with no cross-contamination. Ask-back is therefore available to EVERY role;
//      runHostNode passes each run's shard to buildClarifyQueueContext.
function renderWgClarifyBlock(envelopeNonce: string): string {
  return [
    '',
    'If you need a human decision first, emit a <workflow-clarify> envelope INSTEAD',
    'of <workflow-output> (never both). Its body is a REQUIRED JSON document in the',
    'shape below — a natural-language list of questions is rejected as malformed and',
    'wastes a turn. Where a field is shown as `"a" | "b"` (or `true | false`) that',
    'denotes the ALLOWED values — emit ONE concrete literal (e.g. "single"), never',
    'the `|` itself:',
    '',
    clarifyFormatExample(envelopeNonce),
    '',
    CLARIFY_STRUCTURAL_RULES,
  ].join('\n')
}

export function renderWgProtocolBlock(
  role: WorkgroupProtocolRole,
  config: WorkgroupRuntimeConfig,
  envelopeNonce = '',
  /**
   * RFC-207 §3.7.2 — may THIS asker ask a human on THIS turn? Passed in rather
   * than derived here, because the answer depends on per-asker state this
   * function cannot see (ask-back budget spent, per-asker stop directive), and
   * because the caller must feed the SAME value to `clarifyEnabled` on the run
   * request. Deriving it in two places is how a prompt ends up inviting an
   * ask-back that the envelope gate then rejects — burning the protocol retry
   * budget and failing the assignment for nothing.
   */
  clarifyAllowed = false,
  /**
   * RFC-215 §6.2 — non-null marks an fc TASK-BATCH run: the result port becomes
   * `wg_task_results` (per-task array keyed by the prompt's Task numbers) and
   * `wg_result` is EXPLICITLY ruled out. Message turns / lw workers pass
   * nothing and keep the single-object `wg_result` protocol verbatim.
   */
  batch: { count: number } | null = null,
): string {
  const switches = resolveWorkgroupSwitches(config.mode, config.switches)
  const msgTargets = switches.directMessages
    ? 'a member displayName from the roster, or null for the shared blackboard'
    : switches.blackboard
      ? 'null only (blackboard); direct messages are disabled in this group'
      : 'DISABLED in this group — omit the port entirely'
  const lines: string[] = ['## Workgroup output protocol', '']
  if (role === 'leader') {
    lines.push(
      'You are the group LEADER. You COORDINATE ONLY: break the goal down,',
      'dispatch assignments, verify results, and decide when the group is done.',
      'Never write code or produce deliverables yourself (violating this is a',
      'protocol breach). A good brief states the objective, the expected',
      'output, and clear boundaries.',
      '',
      'Ports:',
    )
    // RFC-185 D4 — fan-out is OPT-IN: only an explicitly enabled group's
    // leader is invited to dispatch same-member concurrent instances (the
    // engine has always been able to run them — deriveWakeSet has no
    // per-member busy gate — but without the invitation the model self-limits
    // to one entry per member). OFF (the default) keeps the original
    // one-entity-per-agent port copy byte-for-byte, so fan-out is a NEW
    // capability, never a behavior change to existing groups. Cap
    // interpolated from WG_MAX_ASSIGNMENTS_PER_TURN so copy and validator can
    // never drift.
    if (config.fanOut === true) {
      lines.push(
        '- <port name="wg_assignments">JSON array of {"member","title","brief"}.',
        '  member = an AGENT displayName from the roster — the leading @ shown in the',
        '  roster is optional (both "writer" and "@writer" resolve). Empty array = no new work.',
        '  FAN-OUT: the SAME member may appear in MULTIPLE entries — each entry runs',
        '  as an independent CONCURRENT INSTANCE of that agent in its own isolated',
        '  worktree. Use this to parallelize divisible work (per-file / per-module',
        '  shards, alternative approaches to compare). Instances share NOTHING at',
        "  runtime and cannot see each other's work-in-progress, so make every",
        '  brief fully self-contained and keep shards non-overlapping to avoid',
        '  merge conflicts. Reference files by RELATIVE path from the repo root, never',
        '  an absolute path — each instance runs in its OWN working copy, so an absolute',
        "  path can point outside it and that instance's writes will be lost. You are",
        '  woken to verify and aggregate once no dispatched',
        '  assignment is still executing. CAUTION: an instance parked on a human',
        '  ask-back may still appear as awaiting_human in your ledger at that point',
        '  — treat it as IN PROGRESS (message, dispatch other work, or wait), never',
        `  as done. At most ${WG_MAX_ASSIGNMENTS_PER_TURN} entries per turn; dispatch further waves in`,
        '  later turns if needed.</port>',
      )
    } else {
      lines.push(
        '- <port name="wg_assignments">JSON array of {"member","title","brief"}.',
        '  member = an AGENT displayName from the roster — the leading @ shown in the',
        '  roster is optional (both "writer" and "@writer" resolve). Empty array = no new work.</port>',
      )
    }
    lines.push(
      `- <port name="wg_messages">JSON array of {"to","body"}; to = ${msgTargets}.</port>`,
      '- <port name="wg_decision">JSON {"action":"continue"} while work remains,',
      '  or {"action":"done","summary":"..."} to close the group task. REQUIRED every turn.</port>',
      // RFC-187 §3-2 (AC-12) — `continue` with no new assignments ends the round with no
      // progress: the group has nothing running and stalls (autonomous gets a bounded
      // auto-nudge, a supervised group parks for a human). Neither reader can tell WHY
      // from a bare `continue`, so require the leader to say it.
      '  If you emit "continue" WITHOUT any new wg_assignments, you MUST state in',
      '  wg_messages what you are waiting on or what is blocking — the round ends with',
      '  no work running and a human has to read that to unblock the group.',
    )
  } else {
    if (role === 'worker') {
      lines.push(
        'You are a group WORKER executing ONE assignment. Do the work in the',
        'repository, then report. You CANNOT delegate or re-assign work to',
        'other members — if the assignment should be split, say so in your',
        'result (or message the leader) and the leader will decide.',
      )
    } else if (batch !== null) {
      lines.push(
        'You are a member of a leaderless workgroup, executing a BATCH of',
        `${batch.count} task(s) from the shared list (see "Your assignments"). Work`,
        'through ALL of them in this run, then report each one individually. You',
        'may also add any NEW tasks you discover — check the current task list',
        'first, do NOT add duplicates.',
      )
    } else {
      lines.push(
        'You are a member of a leaderless workgroup. Work the shared task list:',
        'execute the task attached to this turn (if any), and add any NEW tasks',
        'you discover. Check the current task list first — do NOT add duplicates.',
      )
    }
    lines.push('', 'Ports:')
    if (batch !== null) {
      // RFC-215 §6.2 — 批任务 run：逐卡数组端口；wg_result 明示排除（模型在消息
      // 回合习惯了单对象端口，交替出现时必须点名切换——误发 wg_result 会因缺
      // wg_task_results 进入协议重试并再次收到本提示）。
      lines.push(
        `- <port name="wg_task_results">JSON array of {"task","status"?,"summary","detail"?}.`,
        `  EXACTLY ONE entry per task: task = the Task number (1..${batch.count}) from`,
        '  "Your assignments"; status = "done" (default) or "failed" if you could',
        '  not complete that task (say why in summary). Every summary is what the',
        '  group sees — make it self-contained. Do NOT use wg_result in this run;',
        '  this batch run reports ONLY through wg_task_results.</port>',
      )
    } else {
      lines.push(
        '- <port name="wg_result">JSON {"summary","detail"?}. summary is what the',
        '  group sees — make it self-contained. REQUIRED when you did any work.</port>',
      )
    }
    lines.push(`- <port name="wg_messages">JSON array of {"to","body"}; to = ${msgTargets}.</port>`)
    if (role === 'fc_member') {
      lines.push(
        '- <port name="wg_tasks_add">JSON array of {"title","brief"?} — new tasks',
        '  for the shared list (deduplicated by title).</port>',
      )
    }
  }
  lines.push('', renderEnvelopeRules(envelopeNonce))
  // RFC-172 (route 2, R2-T7): human ask-back is available to EVERY role. The dispatch/mint +
  // selectAgentQueue shard scoping (S0–S3, R2-T3) round-trips a member's answer to its OWN
  // assignment shard, so members / fc_members may ask a human too — their answer returns to their
  // run, isolated from concurrent members (free_collab members likewise).
  // RFC-207: …unless this asker may not ask right now — no human on the roster,
  // its ask-back budget is spent, or a human told it to stop. Then the invite is
  // omitted and it proceeds on its own judgment. `clarifyAllowed` is resolved
  // ONCE by the caller and shared with the envelope gate (§3.7.2), so the prompt
  // never invites something the runner would reject.
  if (clarifyAllowed) {
    lines.push(renderWgClarifyBlock(envelopeNonce))
  }
  return lines.join('\n')
}

/**
 * RFC-184: the wg protocol output ports a host run of `role` is allowed to
 * emit — the machine-readable MIRROR of the `<port name="…">` lines that
 * {@link renderWgProtocolBlock} prints for the same role. A workgroup host run
 * projects the member agent's `outputs` to this list (and clears outputKinds)
 * so `runNode` parses/returns the wg_* ports and never validates the member's
 * own business output kinds (design.md §2.1). MUST stay in lockstep with
 * renderWgProtocolBlock above — the mirror-lock test asserts equality against
 * the ports grepped out of that function's text.
 */
export function wgHostRolePorts(
  role: WorkgroupProtocolRole,
  /** RFC-215 §6.2 — non-null (fc task-batch run) swaps wg_result → wg_task_results. */
  batch: { count: number } | null = null,
): string[] {
  if (role === 'leader') return [WG_PORT_ASSIGNMENTS, WG_PORT_MESSAGES, WG_PORT_DECISION]
  if (role === 'fc_member') {
    return batch !== null
      ? [WG_PORT_TASK_RESULTS, WG_PORT_MESSAGES, WG_PORT_TASKS_ADD]
      : [WG_PORT_RESULT, WG_PORT_MESSAGES, WG_PORT_TASKS_ADD]
  }
  return [WG_PORT_RESULT, WG_PORT_MESSAGES] // worker
}
