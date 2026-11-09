// RFC-075 — the framework's built-in commit agent: its definition, the synthetic
// commit&push node id, and the commit-message / push-repair prompts. Pure (no
// DB, no git, no spawn). The git half of the automatic commit&push lives in
// source-control (`application/workspaceChangePublication.ts`); the engine
// tail (`engine/node/commit-push/runCommitPush.ts`) drives this agent through
// its ports. RFC-475: moved here from `services/commitPush.ts`, beside the
// dynamic-workflow orchestrator agent (`dynamicWorkflowOrchestrator.ts`).
import type { Agent, Language } from '@agent-workflow/shared'
import {
  COMMIT_PUSH_NODE_PREFIX,
  envelopeOpenTag,
  fenceUntrusted,
  sanitizeInlineField,
} from '@agent-workflow/shared'

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
