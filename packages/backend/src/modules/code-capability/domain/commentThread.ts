// RFC-304 §6.2 `collect-thread` — reading a reviewer's point out of a thread.
//
// The event that wakes this capability names one comment. Answering only that
// comment answers the wrong question surprisingly often, because a reviewer's
// actual point is routinely spread across a reply chain:
//
//   "this allocates on every call"
//   "…and the same in the loop below"
//   "actually just hoist it"
//
// An agent handed only the last message is asked to "just hoist it" with no
// idea what `it` is. So the whole thread is collected, in order, and the
// anchor — which file and line the discussion is attached to — comes with it,
// because a thread's own position is the strongest hint about what it is about.
//
// ## What is deliberately NOT here
//
// No judgement about whether the thread is actionable. That is the agent's
// call, expressed through `outcome: 'declined'` in its envelope. A program
// filtering threads by keyword ("looks like a question, skip it") would be
// exactly the kind of guessing the constitution pushes out of program stages.

/** One message in a review discussion. */
export interface ThreadMessage {
  author: string
  body: string
  /** Host id, so a reply can be threaded rather than posted at the MR. */
  noteId: string | null
  createdAt: string | null
}

export interface CollectedThread {
  /** Host id of the discussion; a reply goes here. */
  threadId: string
  messages: readonly ThreadMessage[]
  /** Whether the host reports the thread already settled. */
  resolved: boolean
}

/** Where a thread is attached, when it is attached to code at all. */
export interface ThreadAnchor {
  path: string
  /** New-side line, 1-based. Null for a thread on the MR rather than a line. */
  line: number | null
}

export type ThreadParseResult =
  | { ok: true; thread: CollectedThread; anchor: ThreadAnchor | null }
  | { ok: false; reason: string }

/**
 * Read one thread out of a host's discussion listing.
 *
 * The two hosts disagree about almost everything here, and the differences are
 * load-bearing rather than cosmetic:
 *
 *   GitLab returns `discussions`, each with a `notes[]` array and the position
 *   on the FIRST note. The discussion id is what `thread.resolve` addresses.
 *   GitHub returns a flat list of review comments; a "thread" is the comment
 *   plus everything whose `in_reply_to_id` chains back to it, and the position
 *   lives on each comment.
 *
 * Returning a reason rather than throwing: a thread that cannot be read is a
 * round that should decline with an explanation, not a crash.
 */
export function parseThread(
  provider: 'gitlab' | 'github',
  listingBody: string,
  threadId: string,
): ThreadParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(listingBody)
  } catch {
    return { ok: false, reason: 'the code host returned something that is not JSON' }
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'the code host returned no discussion list' }
  }

  return provider === 'gitlab'
    ? parseGitlabThread(parsed, threadId)
    : parseGithubThread(parsed, threadId)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return null
}

function authorOf(row: Record<string, unknown>): string {
  const author = asRecord(row.author) ?? asRecord(row.user)
  return asString(author?.username) ?? asString(author?.login) ?? 'unknown'
}

function parseGitlabThread(list: readonly unknown[], threadId: string): ThreadParseResult {
  for (const entry of list) {
    const discussion = asRecord(entry)
    if (discussion === null) continue
    if (asString(discussion.id) !== threadId) continue

    const notes = Array.isArray(discussion.notes) ? discussion.notes : []
    const messages: ThreadMessage[] = []
    let anchor: ThreadAnchor | null = null
    let resolved = false

    for (const raw of notes) {
      const note = asRecord(raw)
      if (note === null) continue
      // A system note ("changed the description", "added 1 commit") is not part
      // of the conversation. Feeding them to the agent buries the human's
      // actual point in bookkeeping.
      if (note.system === true) continue
      messages.push({
        author: authorOf(note),
        body: asString(note.body) ?? '',
        noteId: asString(note.id),
        createdAt: asString(note.created_at),
      })
      if (note.resolved === true) resolved = true
      if (anchor === null) {
        const position = asRecord(note.position)
        const path = asString(position?.new_path) ?? asString(position?.old_path)
        if (path !== null) {
          const line = asString(position?.new_line)
          anchor = { path, line: line === null ? null : Number(line) }
        }
      }
    }

    if (messages.length === 0) {
      return { ok: false, reason: `discussion ${threadId} has no human messages` }
    }
    return { ok: true, thread: { threadId, messages, resolved }, anchor }
  }

  return { ok: false, reason: `discussion ${threadId} is not in the merge request's listing` }
}

function parseGithubThread(list: readonly unknown[], threadId: string): ThreadParseResult {
  // Build the reply chain by id. GitHub gives every reply the ROOT's
  // `in_reply_to_id` rather than its immediate parent, so one pass suffices.
  const rows = list.map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
  const inThread = rows.filter((row) => {
    const id = asString(row.id)
    const replyTo = asString(row.in_reply_to_id)
    return id === threadId || replyTo === threadId
  })

  if (inThread.length === 0) {
    return { ok: false, reason: `comment ${threadId} is not in the pull request's listing` }
  }

  const messages: ThreadMessage[] = inThread.map((row) => ({
    author: authorOf(row),
    body: asString(row.body) ?? '',
    noteId: asString(row.id),
    createdAt: asString(row.created_at),
  }))

  const root = inThread.find((row) => asString(row.id) === threadId) ?? inThread[0]!
  const path = asString(root.path)

  return {
    ok: true,
    thread: { threadId, messages, resolved: false },
    anchor: path === null ? null : { path, line: lineOf(root.line ?? root.original_line) },
  }
}

/**
 * A comment's line, or null.
 *
 * Null rather than NaN for anything unparseable: NaN reaches the prompt as
 * "line NaN" and the agent tries to reason about it, whereas null renders as
 * "this discussion is about <file>" — true, and less confusing than a number
 * that is not one.
 */
function lineOf(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  const parsed = Number(asString(raw) ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * The thread as the fixing agent reads it.
 *
 * Plain text rather than JSON: this goes into a prompt, and a model reading a
 * conversation reads a conversation better than it reads a serialised array.
 * The anchor is stated separately and explicitly, because "the line this is
 * about" is the single most useful fact here and burying it in a structure
 * makes it easy to miss.
 */
export function renderThreadForPrompt(
  thread: CollectedThread,
  anchor: ThreadAnchor | null,
): string {
  const where =
    anchor === null
      ? 'This discussion is on the merge request as a whole, not on a specific line.'
      : anchor.line === null
        ? `This discussion is about \`${anchor.path}\`.`
        : `This discussion is about \`${anchor.path}\` line ${String(anchor.line)}.`

  const conversation = thread.messages
    .map((m) => `${m.author}:\n${m.body.trim()}`)
    .join('\n\n---\n\n')

  return `${where}\n\n${conversation}`
}
