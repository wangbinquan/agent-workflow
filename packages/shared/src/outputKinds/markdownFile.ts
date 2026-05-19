// RFC-049 — `markdown_file` kind handler. The non-trivial kind: a port whose
// `<port>` content is a worktree-relative path; the framework reads that file
// off disk before downstream nodes see the body.
//
// PR-A scope: 3 of 5 subReasons (empty-path / escapes-worktree / missing-file)
// + buildPromptGuidance moved out of shared/prompt.ts.
//
// PR-B scope (this file): subReasons set expanded to 5 (adds wrong-extension
// + empty-file). validate now runs the stricter post-read checks so the
// markdown_file contract is "the file MUST exist AND be .md/.markdown AND have
// non-empty trimmed content"; the buildRepairBlock SUB_REASON_DESCRIPTIONS map
// was already PR-A-ready for these.

import type { OutputKindHandler } from './types'

const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown'])

const SUB_REASON_DESCRIPTIONS: Record<string, string> = {
  'empty-path': 'empty path',
  'escapes-worktree': 'path escapes the task worktree',
  'missing-file': 'file at the given path does not exist',
  'wrong-extension': 'path extension is not .md / .markdown',
  'empty-file': 'file exists but its content is empty after trim',
}

function endsWithAllowedExtension(path: string): boolean {
  const lower = path.toLowerCase()
  for (const ext of ALLOWED_EXTENSIONS) {
    if (lower.endsWith(ext)) return true
  }
  return false
}

const handler: OutputKindHandler<'markdown_file'> = {
  kind: 'markdown_file',
  // PR-B: full 5-code set. Order doesn't matter; the assert in
  // outputKinds/index.ts only checks uniqueness across kinds.
  subReasons: new Set<string>([
    'empty-path',
    'escapes-worktree',
    'wrong-extension',
    'missing-file',
    'empty-file',
  ]),

  buildPromptGuidance({ ports }) {
    if (ports.length === 0) return null
    const list = ports.map((p) => `\`${p}\``).join(', ')
    return (
      '\n' +
      `For ports declared \`markdown_file\` above (${list}) you MUST follow this two-step protocol — emitting only a path without the file behind it will fail the run:\n` +
      '  1. First, USE A FILE-WRITING TOOL (Write / Edit / shell `cat > path` / equivalent) to persist the FULL markdown body to a file inside the current working directory (the task worktree). Pick a stable worktree-relative path such as `report.md` or `docs/findings.md`.\n' +
      '  2. THEN, place ONLY that worktree-relative path inside the matching `<port>` tag — no markdown body, no code fences, no surrounding prose, no leading or trailing whitespace, no placeholder. The framework reads the file at that path; a path that does not point to an existing file causes the run to fail.\n'
    )
  },

  validate(rawContent, ctx, io) {
    const trimmed = rawContent.trim()
    if (trimmed.length === 0) {
      return {
        ok: false,
        subReason: 'empty-path',
        detail: 'markdown_file port content must be a worktree-relative path, got empty string',
      }
    }

    const resolved = io.resolveWorktreePath(ctx.worktreePath, trimmed)
    if (!resolved.insideWorktree) {
      return {
        ok: false,
        subReason: 'escapes-worktree',
        detail: `markdown_file port content '${trimmed}' resolves outside the task worktree`,
      }
    }

    // Extension check is purely lexical on the worktree-relative path we will
    // attempt to read. We check BEFORE the read so an agent that emits e.g.
    // `report.txt` gets a precise diagnosis instead of "missing file" if the
    // path also happened to not exist.
    if (!endsWithAllowedExtension(resolved.relativePath)) {
      return {
        ok: false,
        subReason: 'wrong-extension',
        detail: `markdown_file port content '${trimmed}': extension must be .md or .markdown`,
      }
    }

    let body: string
    try {
      body = io.readFileUtf8(resolved.targetAbs)
    } catch (err) {
      return {
        ok: false,
        subReason: 'missing-file',
        detail: `markdown_file '${trimmed}': ${(err as Error).message}`,
      }
    }

    if (body.trim().length === 0) {
      return {
        ok: false,
        subReason: 'empty-file',
        detail: `markdown_file '${trimmed}': file exists but its content is empty after trim`,
      }
    }

    return { ok: true, body, sourcePath: resolved.relativePath }
  },

  buildRepairBlock({ failures, ports }) {
    if (failures.length === 0) return null

    // First-occurrence-ordered, deduped list of failed ports for the section
    // header bullets.
    const lines: string[] = []
    for (const f of failures) {
      const description = SUB_REASON_DESCRIPTIONS[f.subReason] ?? f.subReason
      const detailSuffix = f.detail ? ` ${f.detail}` : ''
      lines.push(`- port \`${f.port}\`: ${description}.${detailSuffix}`)
    }

    const reminderPorts = ports.length > 0 ? ports.map((p) => `\`${p}\``).join(', ') : ''
    const reminder = reminderPorts
      ? `\n\nFor ports declared \`markdown_file\` (${reminderPorts}) you MUST follow the two-step protocol — write the file to disk first, then place ONLY the worktree-relative path inside the matching <port> tag. A path without a real file on disk fails the run.`
      : ''

    return `\n\n**Port content validation — markdown_file.**\n${lines.join('\n')}${reminder}`
  },
}

export default handler
