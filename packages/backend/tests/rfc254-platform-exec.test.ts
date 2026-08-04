// RFC-254 T1 — platform-parameterized execution/path primitives.
//
// Every case runs BOTH platforms on whatever host executes the suite. That is
// the point of taking `platform` as an argument (design gate P2-1): a helper
// that reads `process.platform` internally can only ever have its host's branch
// exercised, so the win32 half would ship untested until a Windows runner
// existed — and the design gate showed win32 path handling is precisely where
// the silent, non-throwing defects live.

import { describe, expect, test } from 'bun:test'
import {
  isLexicallyInside,
  nullDevice,
  pathListJoin,
  pathListSplit,
  platformSpawnOptions,
} from '@/util/platformExec'

describe('RFC-254 platformExec', () => {
  test('null device differs per platform', () => {
    expect(nullDevice('linux')).toBe('/dev/null')
    expect(nullDevice('darwin')).toBe('/dev/null')
    expect(nullDevice('win32')).toBe('NUL')
  })

  test('PATH lists join with the platform separator', () => {
    const dirs = ['/usr/bin', '/bin']
    expect(pathListJoin(dirs, 'linux')).toBe('/usr/bin:/bin')
    expect(pathListJoin(['C:\\Windows\\System32', 'C:\\Windows'], 'win32')).toBe(
      'C:\\Windows\\System32;C:\\Windows',
    )
  })

  test('splitting a Windows PATH does not shred drive letters', () => {
    // The whole reason `;` exists on Windows: splitting on ':' would turn one
    // entry into the meaningless pair ["C", "\\Windows"].
    expect(pathListSplit('C:\\Windows;C:\\Windows\\System32', 'win32')).toEqual([
      'C:\\Windows',
      'C:\\Windows\\System32',
    ])
    expect(pathListSplit('/usr/bin:/bin', 'linux')).toEqual(['/usr/bin', '/bin'])
  })

  test('empty PATH entries are dropped rather than becoming ""', () => {
    // A trailing separator is common in inherited PATHs; an empty entry means
    // "current directory" to some resolvers, which is a search-order hazard.
    expect(pathListSplit('/usr/bin::/bin:', 'linux')).toEqual(['/usr/bin', '/bin'])
    expect(pathListSplit('C:\\a;;C:\\b;', 'win32')).toEqual(['C:\\a', 'C:\\b'])
  })

  test('spawn options hide the console only on Windows', () => {
    expect(platformSpawnOptions('linux')).toEqual({})
    expect(platformSpawnOptions('darwin')).toEqual({})
    expect(platformSpawnOptions('win32')).toEqual({ windowsHide: true })
  })

  describe('isLexicallyInside', () => {
    test('POSIX semantics match the idiom it replaces', () => {
      expect(isLexicallyInside('/a/b', '/a/b', 'linux')).toBe(true)
      expect(isLexicallyInside('/a/b', '/a/b/c', 'linux')).toBe(true)
      expect(isLexicallyInside('/a/b', '/a/bc', 'linux')).toBe(false)
      expect(isLexicallyInside('/a/b', '/a', 'linux')).toBe(false)
      expect(isLexicallyInside('/a/b', '/x/y', 'linux')).toBe(false)
    })

    test('POSIX stays case-SENSITIVE', () => {
      // ext4 distinguishes these; folding case here would wrongly admit /a/B/c
      // into a fence declared for /a/b.
      expect(isLexicallyInside('/a/b', '/a/B/c', 'linux')).toBe(false)
    })

    test('Windows accepts backslash-separated paths', () => {
      // This is the defect the whole rule exists for: the old
      // `x.startsWith(`${root}/`)` answered FALSE for every real Windows path,
      // which silently inverts allow-checks and deny-checks alike.
      expect(isLexicallyInside('C:\\store', 'C:\\store\\db', 'win32')).toBe(true)
      expect(isLexicallyInside('C:\\store', 'C:\\store', 'win32')).toBe(true)
      expect(isLexicallyInside('C:\\store', 'C:\\storefront', 'win32')).toBe(false)
    })

    test('Windows folds case, because NTFS does', () => {
      expect(isLexicallyInside('C:\\Store', 'c:\\store\\db', 'win32')).toBe(true)
      expect(isLexicallyInside('c:\\store', 'C:\\STORE\\DB', 'win32')).toBe(true)
    })

    test('Windows treats / and \\ as the same separator', () => {
      // Bun/Node hand back mixed separators freely (`join()` yields `\`, a
      // config file may carry `/`), so a fence must not depend on which one
      // the caller happened to receive.
      expect(isLexicallyInside('C:/store', 'C:\\store\\db', 'win32')).toBe(true)
      expect(isLexicallyInside('C:\\store', 'C:/store/db', 'win32')).toBe(true)
    })

    test('an empty root contains nothing', () => {
      // The replaced idiom compared against `'' + '/'`, so EVERY absolute posix
      // path looked "inside" an unset root — a fence configured from a missing
      // env var would have silently permitted the whole filesystem.
      expect(isLexicallyInside('', '/anything', 'linux')).toBe(false)
      expect(isLexicallyInside('', 'C:\\anything', 'win32')).toBe(false)
    })

    test('a root given with a trailing separator behaves identically', () => {
      expect(isLexicallyInside('/a/b/', '/a/b/c', 'linux')).toBe(true)
      expect(isLexicallyInside('C:\\store\\', 'C:\\store\\db', 'win32')).toBe(true)
    })

    test('it is lexical only and does not interpret ..', () => {
      // Documented limitation, asserted so nobody later mistakes this for a
      // containment proof: callers must canonicalize first.
      expect(isLexicallyInside('/a/b', '/a/b/../../etc', 'linux')).toBe(true)
    })
  })
})
