// RFC-370: sync compatibility and async validation interpret one original handler policy.
import { describe, expect, test } from 'bun:test'
import { parseKind } from '../src/kindParser'
import { getHandlerForParsedKind, PARAMETRIC_HANDLERS } from '../src/outputKinds/registry'
import {
  runNativeOutputValidationPolicy,
  runOutputValidationPolicy,
  type OutputValidationEffects,
} from '../src/outputKinds/validationPolicy'
import type { ValidateIO } from '../src/outputKinds/types'

function io(): ValidateIO {
  const receiver: ValidateIO = {
    resolveWorktreePath(workspace, raw) {
      expect(this).toBe(receiver)
      return { targetAbs: `${workspace}:${raw}`, relativePath: raw, insideWorktree: true }
    },
    readFileUtf8(ref) {
      expect(this).toBe(receiver)
      if (ref.endsWith('missing.md')) throw new Error('original missing body')
      return ref.endsWith('empty.md') ? '\n ' : `body:${ref}`
    },
  }
  return receiver
}

describe('RFC-370 shared original validation policy', () => {
  test('every actual registered handler supplies the required policy', () => {
    expect(PARAMETRIC_HANDLERS.map((handler) => handler.displayName)).toEqual([
      'string',
      'markdown',
      'path',
      'list',
      'signal',
    ])
    for (const handler of PARAMETRIC_HANDLERS)
      expect(typeof handler.validationPolicy).toBe('function')
  })

  test('the legacy validate method remains usable without its handler receiver', () => {
    for (const [kind, rawContent] of [
      ['path<md>', 'report.md'],
      ['list<path<md>>', 'a.md\nb.md'],
      ['signal', 'content'],
      ['string', ' untouched '],
      ['markdown', '# M\n\n  body'],
    ]) {
      const parsed = parseKind(kind!)
      const handler = getHandlerForParsedKind(parsed)
      const validate = handler.validate
      const ctx = { port: 'p', kind: parsed, worktreePath: 'opaque:root' }
      const content = io()
      expect(validate(rawContent!, ctx, content)).toEqual(
        runNativeOutputValidationPolicy(handler.validationPolicy(rawContent!, ctx, content)),
      )
    }
  })

  test('sync and async path effects preserve successful and failed values', async () => {
    const native = io()
    const selected: OutputValidationEffects = {
      async resolveWorktreePath(...args) {
        return native.resolveWorktreePath(...args)
      },
      async readFileUtf8(...args) {
        return native.readFileUtf8(...args)
      },
    }
    const parsed = parseKind('path<md>')
    const handler = getHandlerForParsedKind(parsed)
    const ctx = { port: 'p', kind: parsed, worktreePath: 'opaque:root' }
    for (const raw of ['report.md', 'missing.md', 'empty.md', 'wrong.json', '  ']) {
      expect(await runOutputValidationPolicy(handler.validationPolicy(raw, ctx, selected))).toEqual(
        handler.validate(raw, ctx, native),
      )
    }
  })

  test('a resolution error escapes at the same position for both interpreters', async () => {
    const raw = Object.freeze({ source: 'resolution' })
    const content: ValidateIO = {
      resolveWorktreePath() {
        throw raw
      },
      readFileUtf8() {
        throw new Error('unexpected read')
      },
    }
    const parsed = parseKind('path<md>')
    const handler = getHandlerForParsedKind(parsed)
    const ctx = { port: 'p', kind: parsed, worktreePath: 'opaque:root' }
    let nativeError: unknown
    try {
      handler.validate('report.md', ctx, content)
    } catch (error) {
      nativeError = error
    }
    const selectedError: unknown = await runOutputValidationPolicy(
      handler.validationPolicy('report.md', ctx, content),
    ).catch((error: unknown) => error)
    expect<unknown>(nativeError).toBe(raw)
    expect<unknown>(selectedError).toBe(raw)
  })
})
