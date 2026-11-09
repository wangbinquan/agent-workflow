// RFC-075 — what the automatic commit says about the staged change set: the
// numstat totals, the diff excerpt handed to the message author, and the
// deterministic message used when the author yields nothing usable. Pure (no
// git, no IO); moved here from `services/commitPush.ts` by RFC-475 with the
// workspace change publication (`application/workspaceChangePublication.ts`).

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
