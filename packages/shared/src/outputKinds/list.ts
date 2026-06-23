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
import { splitListItems, MARKDOWN_DOC_BOUNDARY } from '../listWire'
import { getHandlerForParsedKind, type ParametricOutputKindHandler } from './registry'
import type { ValidateResult } from './types'

const SUB_REASON_DESCRIPTIONS: Record<string, string> = {
  'list-empty-item': 'list contains a blank line where an item was expected',
  'list-item-validate-failed': 'one or more list items failed item-kind validation',
}

const handler: ParametricOutputKindHandler = {
  displayName: 'list',
  subReasons: new Set<string>(['list-empty-item', 'list-item-validate-failed']),

  matches: (p: ParsedKind) => p.kind === 'list',

  // RFC-080: list serves a SHAPE, not a base name.
  baseNames: [],
  carriesData: () => true,
  // List-completeness guidance: bullet + example + prompt guidance all push the
  // SAME signal — emit the WHOLE list, never a single representative item.
  // Agents were observed returning one element for a list<T> port because the
  // Format example rendered a single-line `<port>...</port>` shape that
  // contradicted the "one item per line" wording; the multi-line example below
  // plus the "EVERY item" bullet/guidance remove that misread.
  bulletSuffix: (parsed) => {
    const isInlineMd =
      parsed.kind === 'list' && parsed.item.kind === 'base' && parsed.item.name === 'markdown'
    if (isInlineMd) {
      // list<markdown> items are boundary-separated multi-line documents, NOT
      // one item per line — keep this bullet consistent with the example +
      // guidance below so the agent never gets a contradictory wire-format cue.
      return '(list<markdown> — emit EVERY document, one body per boundary-separated block; output the complete list, not a single example)'
    }
    return '(list — emit EVERY item, one per line; output the complete list, not a single example)'
  },
  examplePlaceholder: (parsed) => {
    const isInlineMd =
      parsed.kind === 'list' && parsed.item.kind === 'base' && parsed.item.name === 'markdown'
    if (isInlineMd) {
      // list<markdown>: multiple inline docs framed by the boundary line.
      return (
        '\n<full markdown body of item 1 — multi-line is fine>\n' +
        `${MARKDOWN_DOC_BOUNDARY}\n` +
        '<full markdown body of item 2>\n' +
        `${MARKDOWN_DOC_BOUNDARY}\n` +
        '...one body per item — include EVERY item, do not stop after one\n'
      )
    }
    // Every other list is one-item-per-line. A multi-line example is the key
    // anti-"single element" cue: the agent sees ≥2 lines + an explicit
    // "list EVERY item" tail, not a lone `...`.
    const itemKind = parsed.kind === 'list' ? stringifyKind(parsed.item) : 'string'
    return (
      `\nfirst ${itemKind} item\n` +
      `second ${itemKind} item\n` +
      '...one item per line — list EVERY item, do not stop after the first\n'
    )
  },
  // A list is not itself a single reviewable body. Multi-doc review keys on
  // "a list whose ITEM is reviewable" — a structural check callers do against
  // `parsed.item` (RFC-081); the list level is always false here.
  isReviewableBody: () => false,

  buildPromptGuidance({ ports, portKinds }) {
    if (ports.length === 0) return null
    // RFC-081: list<markdown> items are multi-line inline bodies framed by a
    // boundary line; every OTHER list is one-item-per-line.
    const inlineMd: string[] = []
    const lineItem: string[] = []
    for (const port of ports) {
      const k = portKinds.get(port)
      const isInlineMd = k?.kind === 'list' && k.item.kind === 'base' && k.item.name === 'markdown'
      if (isInlineMd) inlineMd.push(port)
      else lineItem.push(port)
    }
    let out = '\n'
    if (lineItem.length > 0) {
      const lines = lineItem.map((port) => {
        const k = portKinds.get(port)
        const itemKind = k !== undefined && k.kind === 'list' ? stringifyKind(k.item) : 'unknown'
        return `  - \`${port}\` (list<${itemKind}>)`
      })
      out +=
        'For these list ports, emit each item on its own line inside the `<port>` tag — ' +
        'output the COMPLETE list, every item, not just one representative example:\n' +
        lines.join('\n') +
        '\n' +
        '  Return ALL items you found or produced. Do NOT stop after the first item, do NOT ' +
        'truncate the list, summarize it, or replace the tail with "..." / "and so on" — if there ' +
        'are 20 items, emit 20 lines. Leaving the tag empty is correct ONLY when you genuinely ' +
        "have zero items. Empty lines are dropped. Each item must satisfy its inner kind's " +
        'contract (e.g. list<path<md>> requires every line to be a worktree-relative ' +
        '.md/.markdown path pointing to a non-empty file).\n'
    }
    if (inlineMd.length > 0) {
      const names = inlineMd.map((p) => `\`${p}\``).join(', ')
      out +=
        `For list<markdown> ports (${names}) you emit MULTIPLE markdown documents inline in one ` +
        '`<port>` tag. Separate consecutive documents with a line containing EXACTLY:\n' +
        `  ${MARKDOWN_DOC_BOUNDARY}\n` +
        '  Put the full markdown body of each document between the boundaries (multi-line is ' +
        'fine). Do NOT include the boundary line inside a document. Empty documents are dropped. ' +
        'Emit EVERY document — do not stop after one; if you produced N documents, output all N ' +
        'bodies separated by N-1 boundary lines, never just the first.\n'
    }
    return out
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
      ? `\n\nFor list-kind ports (${reminderPorts}) emit each item on its own line and include EVERY item — re-emit the COMPLETE list, not just the first item or a subset; each line must satisfy the inner kind's contract.`
      : ''
    return `\n\n**Port content validation — list.**\n${lines.join('\n')}${reminder}`
  },
}

export default handler
