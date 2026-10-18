// RFC-060 PR-A — PARAMETRIC_HANDLERS registry + per-handler smoke tests.
//
// Locks the contract:
//  - 5 handlers registered (string, markdown, path, list, signal).
//  - getHandlerForParsedKind routes parsed kinds to the matching handler.
//  - PathHandler ext check honors ctx.kind.ext (md / markdown / *).
//  - ListHandler delegates per-item validate to the item kind's handler.
//  - SignalHandler swallows non-empty content (ok: true, body: '').
//  - subReason short-codes are unique within the registry.

import { describe, expect, mock, test } from 'bun:test'
import { parseKind } from '../src/kindParser'
import {
  PARAMETRIC_HANDLERS,
  getHandlerForParsedKind,
  tryHandlerForParsedKind,
} from '../src/outputKinds/registry'
import type { ValidateIO } from '../src/outputKinds/types'
import { createListHandler } from '../src/outputKinds/list'

// Minimal in-memory ValidateIO for handler validate tests.
function makeIO(fs: Record<string, string>): ValidateIO {
  return {
    resolveWorktreePath(worktreeAbsPath, rawContent) {
      const rel = rawContent.trim()
      // Lexical containment check — reject leading '..' / absolute paths.
      const inside = !rel.startsWith('/') && !rel.split('/').includes('..')
      const targetAbs = `${worktreeAbsPath}/${rel}`
      return { targetAbs, relativePath: rel, insideWorktree: inside }
    },
    readFileUtf8(absPath) {
      if (!(absPath in fs)) {
        throw new Error(`ENOENT: no such file or directory '${absPath}'`)
      }
      return fs[absPath]!
    },
  }
}

describe('PARAMETRIC_HANDLERS registry', () => {
  test('registers 5 handlers in expected order', () => {
    const names = PARAMETRIC_HANDLERS.map((h) => h.displayName)
    expect(names).toEqual(['string', 'markdown', 'path', 'list', 'signal'])
  })

  test('subReasons unique across handlers', () => {
    const claimedBy = new Map<string, string>()
    for (const h of PARAMETRIC_HANDLERS) {
      for (const sub of h.subReasons) {
        expect(claimedBy.has(sub) && claimedBy.get(sub) !== h.displayName).toBe(false)
        claimedBy.set(sub, h.displayName)
      }
    }
  })
})

describe('RFC-377 list handler registry injection', () => {
  test('delegates splitting, every item validation and joining to the injected registry', () => {
    const kind = parseKind('list<string>')
    const itemKind = parseKind('string')
    const itemHandler = getHandlerForParsedKind(itemKind)
    const validated: string[] = []
    const registry = {
      getHandlerForParsedKind: mock(() => ({
        ...itemHandler,
        *validationPolicy(...args: Parameters<typeof itemHandler.validationPolicy>) {
          validated.push(args[0])
          return yield* itemHandler.validationPolicy(...args)
        },
      })),
      splitPortItems: mock(() => ['first', 'second']),
      joinPortItems: mock(() => 'joined:first|second'),
    }
    const handler = createListHandler(registry)
    expect(registry.getHandlerForParsedKind).not.toHaveBeenCalled()
    expect(registry.splitPortItems).not.toHaveBeenCalled()
    expect(registry.joinPortItems).not.toHaveBeenCalled()
    const result = handler.validate(
      'injected wire',
      { port: 'p', kind, worktreePath: '/tmp/wt' },
      makeIO({}),
    )
    expect(registry.splitPortItems).toHaveBeenCalledWith(kind, 'injected wire')
    expect(registry.getHandlerForParsedKind).toHaveBeenCalledWith(itemKind)
    expect(validated).toEqual(['first', 'second'])
    expect(registry.joinPortItems).toHaveBeenCalledWith(kind, ['first', 'second'])
    expect(result).toEqual({
      ok: true,
      body: 'joined:first|second',
      items: [{ body: 'first' }, { body: 'second' }],
    })
  })

  test('empty injected items need no item lookup or join', () => {
    const registry = {
      getHandlerForParsedKind: mock(getHandlerForParsedKind),
      splitPortItems: mock(() => []),
      joinPortItems: mock(() => 'unused'),
    }
    const result = createListHandler(registry).validate(
      'empty wire',
      { port: 'p', kind: parseKind('list<string>'), worktreePath: '/tmp/wt' },
      makeIO({}),
    )
    expect(result).toEqual({ ok: true, body: '' })
    expect(registry.getHandlerForParsedKind).not.toHaveBeenCalled()
    expect(registry.joinPortItems).not.toHaveBeenCalled()
  })

  test('item failures aggregate without joining invalid content', () => {
    const registry = {
      getHandlerForParsedKind: mock(getHandlerForParsedKind),
      splitPortItems: mock(() => ['wrong.txt', 'missing.md']),
      joinPortItems: mock(() => 'unused'),
    }
    const result = createListHandler(registry).validate(
      'invalid wire',
      { port: 'p', kind: parseKind('list<path<md>>'), worktreePath: '/tmp/wt' },
      makeIO({}),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected item validation failure')
    expect(result.subReason).toBe('list-item-validate-failed')
    expect(result.detail).toContain('[0]')
    expect(result.detail).toContain('[1]')
    expect(registry.joinPortItems).not.toHaveBeenCalled()
  })

  test('non-list kinds fail before consulting the injected registry', () => {
    const registry = {
      getHandlerForParsedKind: mock(getHandlerForParsedKind),
      splitPortItems: mock(() => ['unused']),
      joinPortItems: mock(() => 'unused'),
    }
    expect(
      createListHandler(registry).validate(
        'value',
        { port: 'p', kind: parseKind('string'), worktreePath: '/tmp/wt' },
        makeIO({}),
      ),
    ).toMatchObject({ ok: false, subReason: 'list-item-validate-failed' })
    expect(registry.splitPortItems).not.toHaveBeenCalled()
    expect(registry.getHandlerForParsedKind).not.toHaveBeenCalled()
    expect(registry.joinPortItems).not.toHaveBeenCalled()
  })

  test('registry keeps the list factory result at the original dispatch position', () => {
    expect(PARAMETRIC_HANDLERS[3]).toBe(getHandlerForParsedKind(parseKind('list<string>')))
    expect(PARAMETRIC_HANDLERS.map((handler) => handler.displayName)).toEqual([
      'string',
      'markdown',
      'path',
      'list',
      'signal',
    ])
  })
})

describe('getHandlerForParsedKind — dispatch', () => {
  test('base string → stringHandler', () => {
    expect(getHandlerForParsedKind(parseKind('string')).displayName).toBe('string')
  })

  test('base markdown → markdownHandler', () => {
    expect(getHandlerForParsedKind(parseKind('markdown')).displayName).toBe('markdown')
  })

  test('base signal → signalHandler', () => {
    expect(getHandlerForParsedKind(parseKind('signal')).displayName).toBe('signal')
  })

  test('path<md> / path<json> / path<*> → pathHandler', () => {
    expect(getHandlerForParsedKind(parseKind('path<md>')).displayName).toBe('path')
    expect(getHandlerForParsedKind(parseKind('path<json>')).displayName).toBe('path')
    expect(getHandlerForParsedKind(parseKind('path<*>')).displayName).toBe('path')
  })

  test('list<string> / list<path<md>> → listHandler', () => {
    expect(getHandlerForParsedKind(parseKind('list<string>')).displayName).toBe('list')
    expect(getHandlerForParsedKind(parseKind('list<path<md>>')).displayName).toBe('list')
  })

  test('markdown_file alias routes to pathHandler', () => {
    expect(getHandlerForParsedKind(parseKind('markdown_file')).displayName).toBe('path')
  })

  test('tryHandlerForParsedKind returns null when no handler matches', () => {
    // Construct a parsed kind that wouldn't pass real parseKind but lets
    // us exercise the no-match branch (defensive).
    const unknown = { kind: 'base', name: 'foo-zzz' } as ReturnType<typeof parseKind>
    expect(tryHandlerForParsedKind(unknown)).toBeNull()
  })
})

describe('PathHandler.validate — ext-aware', () => {
  const wt = '/tmp/wt'
  const io = makeIO({ '/tmp/wt/report.md': '# Body\n', '/tmp/wt/notes.txt': 'hello' })

  test('path<md> accepts .md', () => {
    const h = getHandlerForParsedKind(parseKind('path<md>'))
    const r = h.validate(
      'report.md',
      { port: 'p', kind: parseKind('path<md>'), worktreePath: wt },
      io,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.body).toBe('# Body\n')
      expect(r.sourcePath).toBe('report.md')
    }
  })

  test('path<md> rejects .txt with wrong-extension', () => {
    const h = getHandlerForParsedKind(parseKind('path<md>'))
    const r = h.validate(
      'notes.txt',
      { port: 'p', kind: parseKind('path<md>'), worktreePath: wt },
      io,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.subReason).toBe('wrong-extension')
  })

  test('path<*> wildcard accepts any extension', () => {
    const h = getHandlerForParsedKind(parseKind('path<*>'))
    const r = h.validate(
      'notes.txt',
      { port: 'p', kind: parseKind('path<*>'), worktreePath: wt },
      io,
    )
    expect(r.ok).toBe(true)
  })

  test('empty path → empty-path', () => {
    const h = getHandlerForParsedKind(parseKind('path<md>'))
    const r = h.validate('   ', { port: 'p', kind: parseKind('path<md>'), worktreePath: wt }, io)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.subReason).toBe('empty-path')
  })

  test('absolute path → escapes-worktree', () => {
    const h = getHandlerForParsedKind(parseKind('path<md>'))
    const r = h.validate(
      '/etc/passwd',
      { port: 'p', kind: parseKind('path<md>'), worktreePath: wt },
      io,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.subReason).toBe('escapes-worktree')
  })

  test('missing file → missing-file', () => {
    const h = getHandlerForParsedKind(parseKind('path<md>'))
    const r = h.validate(
      'absent.md',
      { port: 'p', kind: parseKind('path<md>'), worktreePath: wt },
      io,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.subReason).toBe('missing-file')
  })

  test('empty file → empty-file', () => {
    const empty = makeIO({ '/tmp/wt/empty.md': '   \n   ' })
    const h = getHandlerForParsedKind(parseKind('path<md>'))
    const r = h.validate(
      'empty.md',
      { port: 'p', kind: parseKind('path<md>'), worktreePath: wt },
      empty,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.subReason).toBe('empty-file')
  })
})

describe('ListHandler.validate — delegates to item handler', () => {
  const wt = '/tmp/wt'
  const io = makeIO({
    '/tmp/wt/a.md': 'A body',
    '/tmp/wt/b.md': 'B body',
    '/tmp/wt/c.txt': 'C body',
  })

  test('list<string> accepts any items', () => {
    const h = getHandlerForParsedKind(parseKind('list<string>'))
    const r = h.validate(
      'alpha\nbeta\ngamma',
      { port: 'p', kind: parseKind('list<string>'), worktreePath: wt },
      io,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body).toBe('alpha\nbeta\ngamma')
  })

  test('list<path<md>> accepts all-md path list', () => {
    const h = getHandlerForParsedKind(parseKind('list<path<md>>'))
    const r = h.validate(
      'a.md\nb.md',
      { port: 'p', kind: parseKind('list<path<md>>'), worktreePath: wt },
      io,
    )
    expect(r.ok).toBe(true)
  })

  test('list<path<md>> with .txt item fails with list-item-validate-failed', () => {
    const h = getHandlerForParsedKind(parseKind('list<path<md>>'))
    const r = h.validate(
      'a.md\nc.txt\nb.md',
      { port: 'p', kind: parseKind('list<path<md>>'), worktreePath: wt },
      io,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.subReason).toBe('list-item-validate-failed')
      expect(r.detail).toContain('[1]')
      expect(r.detail).toContain('wrong-extension')
    }
  })

  test('empty list is OK (empty body)', () => {
    const h = getHandlerForParsedKind(parseKind('list<string>'))
    const r = h.validate('', { port: 'p', kind: parseKind('list<string>'), worktreePath: wt }, io)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body).toBe('')
  })

  test('blank lines between items dropped (not failures)', () => {
    const h = getHandlerForParsedKind(parseKind('list<string>'))
    const r = h.validate(
      'alpha\n\n\nbeta\n',
      { port: 'p', kind: parseKind('list<string>'), worktreePath: wt },
      io,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body).toBe('alpha\nbeta')
  })
})

describe('SignalHandler.validate — always ok, body forced empty', () => {
  test('empty content → ok, body empty', () => {
    const h = getHandlerForParsedKind(parseKind('signal'))
    const r = h.validate(
      '',
      { port: 'done', kind: parseKind('signal'), worktreePath: '/wt' },
      makeIO({}),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body).toBe('')
  })

  test('non-empty content → still ok, body normalized to empty', () => {
    const h = getHandlerForParsedKind(parseKind('signal'))
    const r = h.validate(
      'some leak text',
      { port: 'done', kind: parseKind('signal'), worktreePath: '/wt' },
      makeIO({}),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body).toBe('')
  })
})

describe('buildPromptGuidance — handlers compose per-port hints', () => {
  test('path handler hints by ext per port', () => {
    const h = getHandlerForParsedKind(parseKind('path<md>'))
    const hint = h.buildPromptGuidance({
      ports: ['report'],
      portKinds: new Map([['report', parseKind('path<md>')]]),
    })
    expect(hint).toContain('report')
    expect(hint).toContain('two-step')
  })

  test('list handler renders item kind', () => {
    const h = getHandlerForParsedKind(parseKind('list<path<md>>'))
    const hint = h.buildPromptGuidance({
      ports: ['docs'],
      portKinds: new Map([['docs', parseKind('list<path<md>>')]]),
    })
    expect(hint).toContain('list<path<md>>')
    expect(hint).toContain('on its own line')
  })

  test('signal handler hint mentions empty body', () => {
    const h = getHandlerForParsedKind(parseKind('signal'))
    const hint = h.buildPromptGuidance({
      ports: ['done'],
      portKinds: new Map([['done', parseKind('signal')]]),
    })
    expect(hint).toContain('done')
    expect(hint).toContain('control-flow')
  })

  test('string / markdown handlers return null', () => {
    expect(
      getHandlerForParsedKind(parseKind('string')).buildPromptGuidance({
        ports: ['p'],
        portKinds: new Map(),
      }),
    ).toBeNull()
    expect(
      getHandlerForParsedKind(parseKind('markdown')).buildPromptGuidance({
        ports: ['p'],
        portKinds: new Map(),
      }),
    ).toBeNull()
  })
})
