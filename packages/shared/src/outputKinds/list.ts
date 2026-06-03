// RFC-060 PR-A — parametric 'list<T>' kind handler.
//
// Wire form: a list<T> port's raw content is **newline-separated** entries.
// Each non-empty line (after trim) is one item. Trailing blank lines are
// dropped; leading blank lines are dropped. Empty list = empty string.
//
//   list<string>           items are arbitrary strings (no per-item validate).
//   list<markdown>         same — markdown handler is passthrough.
//   list<path<md>>         items are .md / .markdown worktree-relative paths.
//                          Per-item validate runs the item handler's validate.
//   list<path<*>>          items are arbitrary-ext paths, ext check skipped.
//   list<list<...>>        nested — each line of the outer list is the wire
//                          form of one inner list (multi-line items aren't
//                          supported; nested lists must be one-line each).
//
// The handler delegates per-item validation to the item kind's own handler
// (via getHandlerForParsedKind). Failures aggregate into a single
// `list-item-validate-failed` subReason whose `detail` lines list each
// failing line index + the inner subReason.
//
// PR-A scope: registered into PARAMETRIC_HANDLERS as the new ListHandler;
// not yet called by runtime. PR-D wires it into envelope + scheduler.

import type { ParsedKind } from '../kindParser'
import { stringifyKind } from '../kindParser'
import { getHandlerForParsedKind, type ParametricOutputKindHandler } from './registry'
import type { ValidateResult } from './types'

const SUB_REASON_DESCRIPTIONS: Record<string, string> = {
  'list-empty-item': 'list contains a blank line where an item was expected',
  'list-item-validate-failed': 'one or more list items failed item-kind validation',
}

// RFC-079: exported so the backend review dispatch (services/review.ts) can
// split a list<path<md>> port's wire content into per-item paths using the
// exact same normalization the validator/runtime use — keeping the
// multi-document review's item set byte-identical to the downstream
// wrapper-fanout's shard set.
export function splitListItems(rawContent: string): string[] {
  // Items are non-empty trimmed lines; preserve declaration order. Blank
  // lines between items are tolerated (dropped) — agents wrapping their
  // output in extra newlines won't trip the empty-item check.
  return rawContent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

const handler: ParametricOutputKindHandler = {
  displayName: 'list',
  subReasons: new Set<string>(['list-empty-item', 'list-item-validate-failed']),

  matches: (p: ParsedKind) => p.kind === 'list',

  buildPromptGuidance({ ports, portKinds }) {
    if (ports.length === 0) return null
    const lines: string[] = []
    for (const port of ports) {
      const k = portKinds.get(port)
      const itemKind = k !== undefined && k.kind === 'list' ? stringifyKind(k.item) : 'unknown'
      lines.push(`  - \`${port}\` (list<${itemKind}>)`)
    }
    return (
      '\n' +
      'For list-kind ports above, emit each item on its own line inside the `<port>` tag:\n' +
      lines.join('\n') +
      '\n' +
      "  Empty lines are dropped. Each item must satisfy its inner kind's contract (e.g. " +
      'list<path<md>> requires every line to be a worktree-relative .md/.markdown path ' +
      'pointing to a non-empty file).\n'
    )
  },

  validate(rawContent, ctx, io) {
    if (ctx.kind.kind !== 'list') {
      return {
        ok: false,
        subReason: 'list-item-validate-failed',
        detail: 'internal: ListHandler.validate called with non-list kind',
      }
    }
    const items = splitListItems(rawContent)
    if (items.length === 0) {
      // Empty list is valid wire content (the producer simply emitted no
      // items). Downstream fan-out scheduler will see 0 shards. This is
      // intentional — equivalent to the historical fanout-empty path.
      return { ok: true, body: '' }
    }

    const itemKind = ctx.kind.item
    const itemHandler = getHandlerForParsedKind(itemKind)
    const failures: { idx: number; subReason: string; detail?: string }[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      const result: ValidateResult = itemHandler.validate(
        item,
        { port: ctx.port, kind: itemKind, worktreePath: ctx.worktreePath },
        io,
      )
      if (!result.ok) {
        failures.push({ idx: i, subReason: result.subReason, detail: result.detail })
      }
    }
    if (failures.length > 0) {
      const summary = failures
        .map((f) => `[${f.idx}] ${f.subReason}${f.detail ? `: ${f.detail}` : ''}`)
        .join('; ')
      return {
        ok: false,
        subReason: 'list-item-validate-failed',
        detail: summary,
      }
    }
    // Body wire form unchanged: caller still reads `rawContent` for shard
    // splitting / promptRender. We return the trimmed-line-joined form so
    // downstream consumers see a normalized representation.
    return { ok: true, body: items.join('\n') }
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
      ? `\n\nFor list-kind ports (${reminderPorts}) emit each item on its own line; each line must satisfy the inner kind's contract.`
      : ''
    return `\n\n**Port content validation — list.**\n${lines.join('\n')}${reminder}`
  },
}

export default handler
