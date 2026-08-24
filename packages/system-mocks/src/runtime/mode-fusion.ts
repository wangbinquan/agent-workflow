// RFC-319 B28 —— `fusion` mode: the skill-merger stand-in for memory→skill fusion.
//
// Fusion is the only user flow that REWRITES a managed skill's body and bumps
// its version, and the whole review surface (proposal diff, changelog,
// incorporated/skipped lists) is derived from two artifacts the merger agent
// leaves behind in its worktree:
//
//   1. the edited skill files — the framework diffs the worktree to build the
//      proposal shown for approval;
//   2. `.agent-workflow/fusion/result.json` — the manifest that says which
//      memories were incorporated and which were skipped, with a reason.
//
// Every other stub mode only speaks the output envelope, so none of them can
// drive a fusion past `running`: with no manifest the reconciler has nothing to
// review. This mode produces both artifacts, which is what makes the approval
// surface reachable from an e2e at all.
//
// Skips are driven by the FIXTURE CONTENT, not by an environment variable: a
// memory whose body contains `SKIP-ME` is reported as skipped with a reason.
// Content-driven keeps the stub deterministic and lets one spec exercise the
// incorporated and skipped columns in the same run, without the harness having
// to grow a knob for it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import {
  emitClarifyEvent,
  emitPromptForContractTest,
  emitTextEvent,
  envelope,
  parseInvocation,
  requireEnvelopeOpen,
} from './skeleton'

const NAME = 'stub-opencode-fusion'

/** Mirrors PLATFORM_FUSION_MANIFEST; the stub cannot import backend/shared. */
const MANIFEST_DIR = '.agent-workflow/fusion'
const MANIFEST_PATH = `${MANIFEST_DIR}/result.json`

/** First line of MERGER_PROMPT_TEMPLATE (services/fusion.ts:222). */
const MERGER_MARKER = 'Fuse the following approved memories into this skill.'

// The merger node runs in MANDATORY ask-back mode: emitting <workflow-output>
// on the first turn is refused outright with `clarify-required-output-emitted`
// (that is the product's real contract — this stub was written without the
// round and the fusion failed on exactly that code). So round 1 asks, and the
// spec answers with directive `stop`, which releases the node to produce output.
const QUESTIONS =
  '{"questions":[{"id":"q-merge","title":"Merge these memories as written?",' +
  '"kind":"single","recommended":true,"options":["Yes, merge them","No, stop"]}]}'

/** The framework's release line on the post-clarify prompt (prompt protocol). */
const RELEASE_MARKER = 'User directive: STOP CLARIFYING'

/**
 * `### Memory <id>` blocks, as `serializeMemoriesForPrompt` writes them.
 *
 * The split tolerates a leading ZERO-WIDTH SPACE. Memories reach the prompt
 * inside an `<aw-input>` untrusted-input block, and the framework defuses
 * markdown heading syntax there by prefixing `#` with U+200B — so the literal
 * text is `\u200b### Memory <id>`, and a plain `/^### Memory /m` matches
 * nothing. Measured on a real round-2 prompt (node_runs.prompt_text); the first
 * version of this stub silently reported ZERO incorporated memories because of
 * exactly that.
 */
function parseMemories(prompt: string): Array<{ id: string; body: string }> {
  const out: Array<{ id: string; body: string }> = []
  const blocks = prompt.split(/^\u200b?### Memory /m).slice(1)
  for (const block of blocks) {
    const newline = block.indexOf('\n')
    const id = (newline === -1 ? block : block.slice(0, newline)).trim()
    if (id.length === 0) continue
    out.push({ id, body: newline === -1 ? '' : block.slice(newline + 1) })
  }
  return out
}

export function run(argv: readonly string[]): void {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode 999.0.0\n')
    process.exit(0)
  }
  emitPromptForContractTest(call.prompt)
  const open = requireEnvelopeOpen(call.prompt, NAME)

  // Non-merger runs fall back to the `basic` answer so one spec can drive both
  // the fusion itself and an ordinary agent task — which is how «a fused memory
  // stops being injected» becomes observable: the same task is run before and
  // after approval and its node run's injected-memory snapshot is compared.
  if (!call.prompt.includes(MERGER_MARKER)) {
    emitTextEvent(envelope(open.output, [['answer', 'stub e2e output']]))
    process.exit(0)
  }

  // Round detection reads the PROMPT, not a marker file. The framework appends
  // the answered Q&A plus an explicit release directive to the follow-up
  // prompt, so the prompt itself says which round this is — and unlike a
  // per-(cwd) marker it stays correct across retries, which get a fresh
  // node-run id and therefore a fresh working directory. The marker version of
  // this stub asked a second time on the first retry and the framework failed
  // that run with `clarify-required-output-emitted`, because the user had
  // already sent the STOP directive.
  if (!call.prompt.includes(RELEASE_MARKER)) {
    emitClarifyEvent(open.clarify, QUESTIONS)
    process.exit(0)
  }

  const memories = parseMemories(call.prompt)
  const incorporated = memories.filter((memory) => !memory.body.includes('SKIP-ME'))
  const skipped = memories.filter((memory) => memory.body.includes('SKIP-ME'))

  // The worktree is seeded with the skill's files; editing SKILL.md in place is
  // what the framework diffs into the proposal.
  const skillPath = 'SKILL.md'
  if (existsSync(skillPath)) {
    const lines = incorporated.map((memory) => `- fused ${memory.id}`).join('\n')
    writeFileSync(
      skillPath,
      `${readFileSync(skillPath, 'utf8')}\n## Fused by the e2e stub\n${lines}\n`,
    )
  }

  mkdirSync(MANIFEST_DIR, { recursive: true })
  writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify(
      {
        incorporatedMemoryIds: incorporated.map((memory) => memory.id),
        skipped: skipped.map((memory) => ({
          memoryId: memory.id,
          reason: 'the e2e fixture marked this memory SKIP-ME',
        })),
        changelog: `Fused ${incorporated.length} memories, skipped ${skipped.length}.`,
      },
      null,
      2,
    )}\n`,
  )

  emitTextEvent(
    envelope(open.output, [
      ['summary', `stub fusion incorporated ${incorporated.length}, skipped ${skipped.length}`],
    ]),
  )
  process.exit(0)
}
