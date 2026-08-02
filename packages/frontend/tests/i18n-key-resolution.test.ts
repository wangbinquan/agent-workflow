// Every `t('literal.key')` in the app must resolve in BOTH locales.
//
// Why this exists: i18next renders the KEY ITSELF when a lookup misses. There
// is no error, no warning in a normal run, and no type error — the button just
// says `common.done` instead of 完成. Nothing in the suite noticed, because
// every test that touches such a button finds it by testid or by role.
//
// Two real instances were live on main when this was written:
//   · `common.done` — the confirm button on the token-reveal dialog, missing
//     from both locales (RFC-247; caught by a user looking at the screen).
//   · `tasks.diffLoading` — a transposition of the existing `tasks.loadingDiff`.
//
// Both are one-word mistakes that type-checking cannot see, which is exactly
// the shape of bug worth spending a structural guard on.
//
// SCOPE, and why it is drawn here:
//   · Only single-quoted STRING LITERALS. A template literal
//     (`account.token.verb.${verb}`) has no statically-known key; checking
//     those needs the runtime value and belongs in the component's own test.
//   · A call passing `defaultValue` is exempt: it renders that text on a miss,
//     which is a deliberate choice rather than an oversight.

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'

const SRC = resolve(import.meta.dirname, '..', 'src')

function resolveKey(dict: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[part]
  }, dict)
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [full] : []
  })
}

/** `t('a.b')` or `t('a.b', { … })`, capturing the options object if present. */
const T_CALL = /\bt\(\s*'([A-Za-z][\w.-]*)'\s*(,\s*\{[^}]*)?\)/g

interface Usage {
  file: string
  key: string
  hasDefault: boolean
}

function collectUsages(): Usage[] {
  const out: Usage[] = []
  for (const file of walk(SRC)) {
    if (file.includes(join('src', 'i18n'))) continue
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(T_CALL)) {
      const key = match[1]
      // A bare word is not a key path (`t('x')` in a local helper, a test id,
      // an i18next namespace shorthand). Requiring a dot keeps false
      // positives out without weakening the check on real keys.
      if (key === undefined || !key.includes('.')) continue
      out.push({
        file: file.slice(SRC.length + 1),
        key,
        hasDefault: (match[2] ?? '').includes('defaultValue'),
      })
    }
  }
  return out
}

describe('i18n key resolution', () => {
  const usages = collectUsages()

  test('the scan actually finds the app’s translation calls', () => {
    // Guards the guard: a regex that silently matched nothing would make every
    // assertion below vacuously true.
    expect(usages.length).toBeGreaterThan(500)
    expect(usages.some((u) => u.key === 'common.cancel')).toBe(true)
  })

  test('every literal key resolves in zh-CN', () => {
    const missing = usages
      .filter((u) => !u.hasDefault)
      .filter((u) => resolveKey(zhCN, u.key) === undefined)
      .map((u) => `${u.key}  ←  ${u.file}`)
      .sort()
    expect(missing).toEqual([])
  })

  test('every literal key resolves in en-US', () => {
    const missing = usages
      .filter((u) => !u.hasDefault)
      .filter((u) => resolveKey(enUS, u.key) === undefined)
      .map((u) => `${u.key}  ←  ${u.file}`)
      .sort()
    expect(missing).toEqual([])
  })

  test('a resolved key is a string, not a nested object', () => {
    // `t('account.token')` on a namespace renders "[object Object]". Same class
    // of silent-wrong-output as a missing key.
    const objectValued = usages
      .filter((u) => !u.hasDefault)
      .filter((u) => {
        const value = resolveKey(enUS, u.key)
        return value !== undefined && typeof value !== 'string'
      })
      .map((u) => `${u.key}  ←  ${u.file}`)
      .sort()
    expect(objectValued).toEqual([])
  })
})
