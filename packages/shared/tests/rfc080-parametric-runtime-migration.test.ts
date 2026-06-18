// RFC-080 PR-A — forward coverage for the runtime migration onto the
// parametric OutputKindHandler registry + the anti-漏适配 drift guard.
//
// Before RFC-080, prompt.ts / envelope.ts / runner.ts dispatched agent-output
// kinds through the legacy 3-key HANDLERS Record, which THREW on any
// path<ext> / list<T> / signal kind. These tests lock that those kinds now
// build prompts, validate, and compose repair blocks through the parametric
// registry, and that the drift-guard invariants hold.

import { describe, expect, test } from 'bun:test'
import {
  buildProtocolBlock,
  DEFAULT_OUTPUT_KIND,
  defaultParsedKind,
  formatPortValidationErrCode,
  parsePortKind,
  groupPortsByParsedKind,
  composePerParsedKindRepairBlocks,
  getHandlerForParsedKind,
  PARAMETRIC_HANDLERS,
  REGISTERED_BASE_KINDS,
  parseKind,
  findPromptSignalRefs,
  type ParametricOutputKindHandler,
} from '@agent-workflow/shared'

describe('RFC-080 — parametric kinds reach buildProtocolBlock without throwing', () => {
  test('signal / path<json> / list<string> / list<path<md>> all build a protocol block', () => {
    const kinds: Record<string, string> = {
      done: 'signal',
      data: 'path<json>',
      tags: 'list<string>',
      docs: 'list<path<md>>',
    }
    const block = buildProtocolBlock(Object.keys(kinds), kinds)
    expect(block.endsWith('</workflow-output>')).toBe(true)
    // signal — control-flow bullet + empty example
    expect(block).toContain('(signal — control-flow only')
    expect(block).toContain('<port name="done"></port>')
    // path — file-first two-step guidance
    expect(block).toContain('For path-kind ports above')
    // list — per-item guidance (RFC-081 reworded the line-item list guidance)
    expect(block).toContain('For these list ports')
  })

  test('legacy string/markdown ports stay byte-identical (plain bullet + ... example)', () => {
    const block = buildProtocolBlock(['a', 'b'], { a: 'string', b: 'markdown' })
    expect(block).toContain('  - a\n')
    expect(block).toContain('  - b\n')
    expect(block).toContain('<port name="a">...</port>')
    expect(block).not.toContain('For path-kind ports above')
    expect(block).not.toContain('(signal —')
  })
})

describe('RFC-080 — named hooks', () => {
  test('DEFAULT_OUTPUT_KIND / defaultParsedKind / parsePortKind', () => {
    expect(DEFAULT_OUTPUT_KIND).toBe('string')
    expect(defaultParsedKind()).toEqual({ kind: 'base', name: 'string' })
    expect(parsePortKind(undefined)).toEqual({ kind: 'base', name: 'string' })
    expect(parsePortKind('')).toEqual({ kind: 'base', name: 'string' })
    // markdown_file alias folds to path<md>.
    expect(parsePortKind('markdown_file')).toEqual({ kind: 'path', ext: 'md' })
    // Unparseable → safe default (schema admits only valid kinds on ingress).
    expect(parsePortKind('list<')).toEqual({ kind: 'base', name: 'string' })
  })

  test('formatPortValidationErrCode uses the displayName namespace (D2)', () => {
    expect(formatPortValidationErrCode('path', 'missing-file')).toBe(
      'port-validation-path-missing-file',
    )
    expect(formatPortValidationErrCode('list', 'list-item-validate-failed')).toBe(
      'port-validation-list-list-item-validate-failed',
    )
  })

  test('groupPortsByParsedKind buckets by handler displayName, defaults absent → string', () => {
    const groups = groupPortsByParsedKind(['a', 'b', 'c', 'd'], {
      b: 'path<md>',
      c: 'signal',
      d: 'list<string>',
    })
    const byDisplay = Object.fromEntries(groups.map((g) => [g.handler.displayName, g.ports]))
    expect(byDisplay.string).toEqual(['a'])
    expect(byDisplay.path).toEqual(['b'])
    expect(byDisplay.signal).toEqual(['c'])
    expect(byDisplay.list).toEqual(['d'])
  })

  test('composePerParsedKindRepairBlocks renders path<json> failures (legacy Record dropped them)', () => {
    const blocks = composePerParsedKindRepairBlocks(
      [{ port: 'data', kind: 'path<json>', subReason: 'missing-file', detail: "'x.json'" }],
      { data: 'path<json>' },
    )
    expect(blocks.length).toBe(1)
    expect(blocks[0]).toContain('Port content validation — path')
    expect(blocks[0]).toContain('`data`')
  })
})

describe('RFC-080 — drift guard layer 1 (handler capability methods)', () => {
  test('REGISTERED_BASE_KINDS == union of handler baseNames, each served once', () => {
    const declared = new Set<string>()
    for (const h of PARAMETRIC_HANDLERS) for (const n of h.baseNames) declared.add(n)
    expect(declared).toEqual(new Set(REGISTERED_BASE_KINDS))
  })

  test('carriesData: signal=false, data kinds=true', () => {
    const cd = (k: string) => getHandlerForParsedKind(parseKind(k)).carriesData(parseKind(k))
    expect(cd('signal')).toBe(false)
    expect(cd('string')).toBe(true)
    expect(cd('markdown')).toBe(true)
    expect(cd('path<md>')).toBe(true)
    expect(cd('list<string>')).toBe(true)
  })

  test('isReviewableBody: markdown + path<md|markdown> true; path<json> / string / list false', () => {
    const rb = (k: string) => getHandlerForParsedKind(parseKind(k)).isReviewableBody(parseKind(k))
    expect(rb('markdown')).toBe(true)
    expect(rb('path<md>')).toBe(true)
    expect(rb('path<markdown>')).toBe(true)
    expect(rb('markdown_file')).toBe(true) // folds to path<md>
    expect(rb('path<json>')).toBe(false)
    expect(rb('string')).toBe(false)
    expect(rb('list<path<md>>')).toBe(false) // list level is never a single body
  })

  test('a handler missing capability methods fails to typecheck (drift guard via @ts-expect-error)', () => {
    // If any capability method is made OPTIONAL (regressing the drift guard),
    // this object becomes structurally valid and the @ts-expect-error directive
    // goes unused → `bun run typecheck` (tsc) errors on the unused directive.
    // @ts-expect-error — omitting baseNames/carriesData/bulletSuffix/examplePlaceholder/isReviewableBody must be a type error.
    const incomplete: ParametricOutputKindHandler = {
      displayName: 'incomplete',
      subReasons: new Set<string>(),
      matches: () => false,
      buildPromptGuidance: () => null,
      validate: () => ({ ok: true, body: '' }),
      buildRepairBlock: () => null,
    }
    expect(incomplete.displayName).toBe('incomplete')
  })
})

describe('RFC-080 — signalPromptGuard via carriesData', () => {
  test('a no-data (signal) port referenced in a template is flagged', () => {
    const v = findPromptSignalRefs('use {{done}} and {{data}}', { done: 'signal', data: 'string' })
    expect(v.map((x) => x.port)).toEqual(['done'])
    expect(v[0]!.kindRepr).toBe('signal')
  })

  test('data-bearing ports are never flagged', () => {
    expect(
      findPromptSignalRefs('{{a}}{{b}}{{c}}', {
        a: 'string',
        b: 'path<md>',
        c: 'list<string>',
      }),
    ).toEqual([])
  })
})
