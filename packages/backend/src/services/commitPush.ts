// RFC-075 — auto commit&push: deterministic, side-effect-free core.
//
// Everything here is pure (no DB, no git, no spawn) so it can be unit-tested
// in isolation. The git execution + opencode message/repair sessions live in
// the executor (commitPushRunner.ts); the scheduler wiring decides WHEN to run
// it. Keeping the gate / classification / prompt / parse logic here means a
// regression in "when do we commit" or "how do we classify a push failure" is
// caught by a fast unit test, not an integration test.

import type { DetectedEnvelopeKind } from '@/services/envelope'
import { extractLastEnvelope, parseEnvelope } from '@/services/envelope'
import type { Agent, Language, NodeRunStatus } from '@agent-workflow/shared'
import {
  COMMIT_PUSH_NODE_PREFIX,
  envelopeOpenTag,
  fenceUntrusted,
  redactGitUrl,
  sanitizeInlineField,
} from '@agent-workflow/shared'

/** Synthetic node_id prefix marking a framework commit&push node_run.
 *  flag-audit W0: canonical home moved to shared/lifecycle.ts（前端过滤同用）；
 *  re-export 保持既有 backend 导入路径。 */
export { COMMIT_PUSH_NODE_PREFIX }
/** The single output port the built-in commit agent declares. */
export const COMMIT_MESSAGE_PORT = 'commit_message'
/** Name of the framework-internal commit agent (never a user-editable row). */
export const COMMIT_AGENT_NAME = 'commit'

/**
 * RFC-075 T12: the framework's built-in "commit" agent. Not persisted to the
 * `agents` table — constructed on the fly and handed to `runNode` so it spawns
 * an opencode session (captured under the commit node_run) that summarizes the
 * staged diff / repairs a rejected push. It only emits text (the framework runs
 * git), no skills / deps / mcp / plugins. `model` falls back to opencode's
 * installed default when unset.
 */
export function buildCommitAgent(): Agent {
  const now = Date.now()
  return {
    id: '__commit_agent__',
    name: COMMIT_AGENT_NAME,
    description: 'Framework built-in: write commit messages and repair rejected pushes (RFC-075).',
    outputs: [COMMIT_MESSAGE_PORT],
    inputs: [], // RFC-166
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd:
      'You write git commit messages and repair rejected pushes. Always reply with exactly one ' +
      'workflow-output envelope using the exact opening tag and required nonce supplied by the ' +
      `user prompt protocol, containing a single ${COMMIT_MESSAGE_PORT} port.`,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    // RFC-117: no `model` here — the commit runtime (incl. model) is resolved +
    // frozen by the scheduler (resolveInternalAgentRuntime → resolveFrozenRuntime)
    // and the runner reads it from runtimeParams (RFC-113 single-source).
  }
}

/**
 * Synthetic node_id for a commit&push run triggered by `agentNodeId`. In
 * multi-repo tasks each changed repo gets its own row, disambiguated by
 * `repoSlug` (a stable per-repo token, e.g. the worktree dir name).
 */
export function commitPushNodeId(agentNodeId: string, repoSlug?: string): string {
  const base = `${COMMIT_PUSH_NODE_PREFIX}:${agentNodeId}`
  return repoSlug !== undefined && repoSlug !== '' ? `${base}:${repoSlug}` : base
}

/** True iff `nodeId` is a framework-synthesized commit&push node. */
export function isCommitPushNodeId(nodeId: string): boolean {
  return nodeId === COMMIT_PUSH_NODE_PREFIX || nodeId.startsWith(`${COMMIT_PUSH_NODE_PREFIX}:`)
}

/**
 * Gate: should the scheduler even consider a commit after this top-level node
 * finished? The actual "is there anything to commit" decision is a separate
 * diff check at runtime (so read-only auditors and no-op writers are skipped
 * for free). This only encodes the policy bits:
 *   - the task opted into auto commit&push,
 *   - the node is top-level (writers inside a wrapper commit once when the
 *     wrapper finishes, not per inner node),
 *   - the run reached `done` (clarify rounds end `awaiting_human`, failures
 *     end `failed` — neither triggers a commit),
 *   - when an envelope kind is known (agent runs), it is the final `output`
 *     form, never `clarify` / `both` / `none`.
 */
export function shouldConsiderCommit(opts: {
  autoCommitPush: boolean
  isTopLevel: boolean
  status: NodeRunStatus
  envelopeKind?: DetectedEnvelopeKind | null
}): boolean {
  if (!opts.autoCommitPush) return false
  if (!opts.isTopLevel) return false
  if (opts.status !== 'done') return false
  if (opts.envelopeKind != null && opts.envelopeKind !== 'output') return false
  return true
}

/** How a `git push` failure should be handled. */
export type PushFailureClass = 'auth' | 'non-fast-forward' | 'repairable'

/**
 * Classify push stderr. Conservative: anything we can't positively identify as
 * auth or non-fast-forward is treated as `repairable` (worth an LLM repair
 * attempt — typically a server-side commit-message policy hook).
 */
export function classifyPushFailure(stderr: string): PushFailureClass {
  const s = stderr.toLowerCase()
  if (
    /permission denied|authentication failed|could not read username|could not read password|publickey|403 forbidden|access denied|access rights|terminal prompts disabled|invalid credentials/.test(
      s,
    )
  ) {
    return 'auth'
  }
  if (
    /non-fast-forward|fetch first|updates were rejected|tip of your current branch is behind/.test(
      s,
    )
  ) {
    return 'non-fast-forward'
  }
  return 'repairable'
}

/**
 * Truncate a diff body to fit a byte budget: keep the first and last halves
 * with a `[truncated N bytes]` marker between. `maxBytes === 0` disables the
 * body entirely (caller falls back to `--stat` only). Slicing is by character
 * (diffs are overwhelmingly ASCII); the gate uses byte length so multibyte
 * content can't blow the budget.
 */
export function truncateDiff(diff: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(diff, 'utf8') <= maxBytes) return diff
  const half = Math.floor(maxBytes / 2)
  const head = diff.slice(0, half)
  const tail = diff.slice(diff.length - half)
  const omitted = Buffer.byteLength(diff, 'utf8') - Buffer.byteLength(head + tail, 'utf8')
  return `${head}\n\n[truncated ${omitted} bytes]\n\n${tail}`
}

/** Parse `git diff --cached --numstat` into totals. Binary rows (`-\t-`) count
 *  as a changed file with 0 line deltas. */
export function parseNumstat(numstat: string): {
  filesChanged: number
  insertions: number
  deletions: number
} {
  let filesChanged = 0
  let insertions = 0
  let deletions = 0
  for (const line of numstat.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const cols = trimmed.split('\t')
    if (cols.length < 3) continue
    filesChanged += 1
    const add = cols[0]
    const del = cols[1]
    if (add !== undefined && add !== '-' && /^\d+$/.test(add)) insertions += Number(add)
    if (del !== undefined && del !== '-' && /^\d+$/.test(del)) deletions += Number(del)
  }
  return { filesChanged, insertions, deletions }
}

/** Deterministic fallback message when the LLM session yields nothing usable. */
export function buildFallbackMessage(opts: {
  agentName: string
  filesChanged: number
  insertions: number
  deletions: number
  taskId: string
}): string {
  const id8 = opts.taskId.slice(0, 8)
  return `chore(agent-workflow): ${opts.agentName} changes (${opts.filesChanged} files, +${opts.insertions}/-${opts.deletions}) [task ${id8}]`
}

/**
 * RFC-157: a short trailer appended at the END of the commit-message / repair
 * prompt to steer the OUTPUT language of the human summary + body. Mirrors the
 * distiller's DISTILLER_OUTPUT_LANG_DIRECTIVE (memoryDistiller.ts): only the
 * visible summary/body language flips; the Conventional-Commits
 * `<type>(<scope>):` prefix ALWAYS stays lowercase ASCII (locked by test). The
 * en-US string is appended even on the default/unset path (unset ≡ 'en-US'),
 * so it explicitly documents the ASCII-prefix rule in both modes — this
 * deliberately does NOT preserve the pre-RFC-157 prompt byte-for-byte (that
 * would conflict with mirroring the distiller); commit messages stay English.
 */
export const COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE: Readonly<Record<Language, string>> = {
  'en-US':
    'Write the commit message summary and body in English. Keep the Conventional-Commits `<type>(<scope>):` prefix in lowercase ASCII (e.g. feat(auth):).',
  'zh-CN':
    '提交信息的摘要与正文用简体中文书写。Conventional-Commits 的 `<type>(<scope>):` 前缀保持小写 ASCII（如 feat(auth):），不要翻译类型词与范围词。',
} as const

/** Prompt for the built-in commit agent: summarize the staged diff into a
 *  Conventional-Commits-style message. `lang` steers only the summary/body
 *  language (default en-US ≡ unset; the ASCII prefix is preserved either way). */
export function buildCommitMessagePrompt(
  opts: {
    repoName: string
    branch: string
    baseRef: string
    stat: string
    diffTruncated: string
    lang?: Language
  },
  envelopeNonce = '',
): string {
  const inline = (value: string): string =>
    envelopeNonce.length > 0 ? sanitizeInlineField(value) : value
  const data = (name: string, value: string): string => fenceUntrusted(name, value, envelopeNonce)
  const stat = opts.stat.trim() || '(no stat available)'
  const statBlock =
    envelopeNonce.length > 0 ? [data('commit-diff-stat', stat)] : ['```', stat, '```']
  const diffBlock =
    opts.diffTruncated.trim() === ''
      ? []
      : envelopeNonce.length > 0
        ? ['', 'Diff (possibly truncated):', data('commit-diff', opts.diffTruncated)]
        : ['', 'Diff (possibly truncated):', '```diff', opts.diffTruncated, '```']
  return [
    `You are generating a git commit message for changes an AI agent just made in repository "${inline(opts.repoName)}" (branch ${inline(opts.branch)}, based on ${inline(opts.baseRef)}).`,
    '',
    'Write ONE Conventional-Commits style message:',
    '- First line: `<type>(<optional scope>): <concise summary>` (≤ 72 chars).',
    '- Optionally a blank line then a short body explaining the WHY.',
    '- Do not invent changes that are not in the diff. Describe what changed.',
    '',
    'Changed files (git diff --stat):',
    ...statBlock,
    ...diffBlock,
    '',
    `Return ONLY the message inside the output envelope, e.g.:`,
    `${envelopeOpenTag(envelopeNonce)}<port name="${COMMIT_MESSAGE_PORT}">feat(auth): extract token middleware</port></workflow-output>`,
    // RFC-157: language directive last so the model reads it most recently.
    '',
    COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE[opts.lang ?? 'en-US'],
  ].join('\n')
}

/** Prompt for the repair session: a push was rejected; produce a corrected
 *  commit message (most server-side rejections are message-format policy). */
export function buildRepairPrompt(
  opts: {
    branch: string
    pushStderr: string
    currentMessage: string
    stat: string
    priorAttempts: number
    lang?: Language
  },
  envelopeNonce = '',
): string {
  const inline = (value: string): string =>
    envelopeNonce.length > 0 ? sanitizeInlineField(value) : value
  const data = (name: string, value: string): string => fenceUntrusted(name, value, envelopeNonce)
  const block = (name: string, value: string): string[] =>
    envelopeNonce.length > 0 ? [data(name, value)] : ['```', value, '```']
  return [
    `A "git push" of branch ${inline(opts.branch)} was REJECTED by the remote. This is repair attempt ${opts.priorAttempts + 1}.`,
    'Most such rejections are commit-message policy hooks (e.g. Conventional Commits, a required Change-Id / ticket key, max subject length).',
    '',
    'The remote said:',
    ...block('push-rejection', opts.pushStderr.trim() || '(no remote output)'),
    '',
    'The current commit message is:',
    ...block('current-commit-message', opts.currentMessage.trim()),
    '',
    'Changed files (git diff --stat):',
    ...block('commit-diff-stat', opts.stat.trim() || '(no stat available)'),
    '',
    `Produce a corrected commit message that satisfies the remote's policy. Return ONLY:`,
    `${envelopeOpenTag(envelopeNonce)}<port name="${COMMIT_MESSAGE_PORT}">...corrected message...</port></workflow-output>`,
    // RFC-157: repair message uses the same configured language as the initial
    // one (initial + repair are one agent, one commit-message surface). The
    // remote's structural policy (Change-Id / ticket key) stays ASCII, so the
    // language directive never conflicts with it.
    '',
    COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE[opts.lang ?? 'en-US'],
  ].join('\n')
}

/** Extract the `commit_message` port from the last `<workflow-output>` block in
 *  the agent's stdout. Returns null when absent/empty. */
export function parseCommitMessageFromEnvelope(
  stdout: string,
  envelopeNonce?: string,
): string | null {
  const env = extractLastEnvelope(stdout, envelopeNonce)
  if (env === null) return null
  const { ports } = parseEnvelope(env, [COMMIT_MESSAGE_PORT], envelopeNonce)
  const msg = (ports.get(COMMIT_MESSAGE_PORT) ?? '').trim()
  return msg.length > 0 ? msg : null
}

/** Redact credentials from push stderr and cap its length for storage. */
export function redactPushError(stderr: string, maxLen = 600): string {
  // RFC-210: delegate to the shared redactor instead of keeping a second,
  // weaker regex here. This one only stripped `scheme://user:token@host`, so a
  // credential carried in the QUERY STRING (`?access_token=…`) went into
  // node_runs.commit_push_json verbatim — shared/git-url.ts已经处理了那种形态，
  // and having two implementations is how they drifted apart in the first place.
  let out = redactGitUrl(stderr).trim()
  if (out.length > maxLen) out = `${out.slice(0, maxLen)}…`
  return out
}
