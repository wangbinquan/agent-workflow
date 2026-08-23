// RFC-060 PR-A — parametric 'path<ext>' kind handler.
//
// Generalizes RFC-049 markdownFile.ts: where markdownFile.ts hardcoded
// `.md` / `.markdown` extension allowlist, this handler reads the extension
// constraint from `ctx.kind.ext`:
//
//   path<*>          — any extension allowed (still must be a worktree-relative
//                      path pointing to a non-empty file).
//   path<md>         — must end with .md or .markdown (the legacy
//                      markdown_file behaviour). 'markdown_file' literal
//                      folds to this at parse time.
//   path<markdown>   — same as path<md> (ext name normalized to the user's
//                      input; the lexical check accepts the same suffix list).
//   path<json>       — must end with .json.
//   path<other-ext>  — must end with .<other-ext>.
//
// Other checks (worktree containment, file existence, non-empty body) match
// the markdownFile.ts contract exactly so PR-D can swap the legacy module
// out without touching call sites.
//
// 现状（RFC-317 T66 按源码订正）：**已接入 runtime**——本 handler 注册在
// `registry.ts:149` 的 PARAMETRIC_HANDLERS 里，`services/envelope.ts:652`
// 对每个声明端口调 `getHandlerForParsedKind` 派发到它。原注释写的是
// 「not yet called by runtime」。
// 仍未兑现的只有 markdownFile.ts 的删除——该文件今天还在
// `outputKinds/markdownFile.ts`，与 registry.ts 头部记的是同一条 follow-up。

import { isReviewableBodyKind, type ParsedKind } from '../kindParser'
import type { ParametricOutputKindHandler } from './registry'

const SUB_REASON_DESCRIPTIONS: Record<string, string> = {
  'empty-path': 'empty path',
  'escapes-worktree': 'path escapes the task worktree',
  'missing-file': 'file at the given path does not exist',
  'wrong-extension': 'path extension does not match the declared kind',
  'empty-file': 'file exists but its content is empty after trim',
}

function allowedExtensions(ext: string): string[] {
  if (ext === '*') return [] // any extension allowed, sentinel checked separately
  if (ext === 'md') return ['.md', '.markdown']
  if (ext === 'markdown') return ['.md', '.markdown']
  return [`.${ext}`]
}

function endsWithAny(path: string, suffixes: readonly string[]): boolean {
  const lower = path.toLowerCase()
  for (const s of suffixes) {
    if (lower.endsWith(s.toLowerCase())) return true
  }
  return false
}

const handler: ParametricOutputKindHandler = {
  displayName: 'path',
  subReasons: new Set<string>([
    'empty-path',
    'escapes-worktree',
    'wrong-extension',
    'missing-file',
    'empty-file',
  ]),

  matches: (p: ParsedKind) => p.kind === 'path',

  // RFC-080: path serves a SHAPE, not a base name.
  baseNames: [],
  carriesData: () => true,
  bulletSuffix: () => '(path — write the file first, then emit only its worktree-relative path)',
  examplePlaceholder: () => '<worktree-relative path to the file you just wrote>',
  // RFC-080/081: a path<md> / path<markdown> port is a single reviewable
  // markdown document body (the legacy markdown_file behaviour); other exts
  // are not. Delegates to the kindParser predicate (single source of truth).
  isReviewableBody: (parsed: ParsedKind) => isReviewableBodyKind(parsed),

  buildPromptGuidance({ ports, portKinds }) {
    if (ports.length === 0) return null
    const list = ports
      .map((p) => {
        const k = portKinds.get(p)
        const ext = k !== undefined && k.kind === 'path' ? k.ext : '*'
        return `\`${p}\`${ext === '*' ? '' : ` (extension .${ext === 'md' ? 'md/.markdown' : ext})`}`
      })
      .join(', ')
    return (
      '\n' +
      `For path-kind ports above (${list}) you MUST follow this two-step protocol — emitting only a path without the file behind it will fail the run:\n` +
      '  1. First, USE A FILE-WRITING TOOL (Write / Edit / shell `cat > path` / equivalent) to persist the full content to a file inside the current working directory (the task worktree). Pick a stable worktree-relative path such as `report.md` or `data.json` depending on the declared kind.\n' +
      '  2. THEN, place ONLY that worktree-relative path inside the matching `<port>` tag — no body, no code fences, no surrounding prose, no leading or trailing whitespace, no placeholder. The framework reads the file at that path; a path that does not point to an existing file with the declared extension causes the run to fail.\n'
    )
  },

  validate(rawContent, ctx, io) {
    if (ctx.kind.kind !== 'path') {
      // Defensive: matches() should have prevented this.
      return {
        ok: false,
        subReason: 'wrong-extension',
        detail: `internal: PathHandler.validate called with non-path kind`,
      }
    }
    const ext = ctx.kind.ext
    const trimmed = rawContent.trim()
    if (trimmed.length === 0) {
      return {
        ok: false,
        subReason: 'empty-path',
        detail: 'path port content must be a worktree-relative path, got empty string',
      }
    }

    const resolved = io.resolveWorktreePath(ctx.worktreePath, trimmed)
    if (!resolved.insideWorktree) {
      return {
        ok: false,
        subReason: 'escapes-worktree',
        detail: `path port content '${trimmed}' resolves outside the task worktree`,
      }
    }

    if (ext !== '*') {
      const suffixes = allowedExtensions(ext)
      if (!endsWithAny(resolved.relativePath, suffixes)) {
        return {
          ok: false,
          subReason: 'wrong-extension',
          detail: `path<${ext}> port content '${trimmed}': extension must be ${suffixes.join(' or ')}`,
        }
      }
    }

    let body: string
    try {
      body = io.readFileUtf8(resolved.targetAbs)
    } catch (err) {
      return {
        ok: false,
        subReason: 'missing-file',
        detail: `path '${trimmed}': ${(err as Error).message}`,
      }
    }

    if (body.trim().length === 0) {
      return {
        ok: false,
        subReason: 'empty-file',
        detail: `path '${trimmed}': file exists but its content is empty after trim`,
      }
    }

    return { ok: true, body, sourcePath: resolved.relativePath }
  },

  buildRepairBlock({ failures, ports }) {
    if (failures.length === 0) return null
    const lines: string[] = []
    for (const f of failures) {
      const description = SUB_REASON_DESCRIPTIONS[f.subReason] ?? f.subReason
      const detailSuffix = f.detail ? ` ${f.detail}` : ''
      lines.push(`- port \`${f.port}\`: ${description}.${detailSuffix}`)
    }
    const reminderPorts = ports.length > 0 ? ports.map((p) => `\`${p}\``).join(', ') : ''
    const reminder = reminderPorts
      ? `\n\nFor path-kind ports (${reminderPorts}) you MUST follow the two-step protocol — write the file to disk first, then place ONLY the worktree-relative path inside the matching <port> tag. A path without a real file on disk fails the run.`
      : ''
    return `\n\n**Port content validation — path.**\n${lines.join('\n')}${reminder}`
  },
}

export default handler
