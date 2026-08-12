// RFC-254 T1 — platform-parameterized execution/path primitives.
//
// Every case runs BOTH platforms on whatever host executes the suite. That is
// the point of taking `platform` as an argument (design gate P2-1): a helper
// that reads `process.platform` internally can only ever have its host's branch
// exercised, so the win32 half would ship untested until a Windows runner
// existed — and the design gate showed win32 path handling is precisely where
// the silent, non-throwing defects live.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resetTarProbeForTests, tarAvailable } from '@/util/archive'
import { isWindowsBatchShim } from '@/services/structuralDiff/deep/indexers'
import { isAbsolute, resolve, resolve as resolvePath, win32 } from 'node:path'
import { canonicalBinaryPath } from './fixtures/platformPaths'
import {
  toPortableRelativePath,
  isLexicallyInside,
  nullDevice,
  GIT_NULL_CONFIG_PATH,
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

  test('the git-config null is /dev/null on EVERY platform, never the host NUL', () => {
    // RFC-254 (ARM64 VM): git — including git-for-Windows, an MSYS2 build —
    // understands the POSIX /dev/null but treats the Windows NUL device as a
    // literal filename for a *config path* and fails `unable to access 'NUL':
    // Invalid argument`. GIT_CONFIG_GLOBAL=NUL therefore broke every git call
    // under the sealed env, collapsing opencode's worktree detection to the
    // "global" project. Unlike a host redirect (nullDevice), the git-config null
    // is host-independent.
    expect(GIT_NULL_CONFIG_PATH).toBe('/dev/null')
    expect(GIT_NULL_CONFIG_PATH).not.toBe(nullDevice('win32'))
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

describe('RFC-254 T25b — archive prerequisites', () => {
  test('tar is probed once and reported honestly', () => {
    // Windows ships bsdtar as System32\tar.exe since 1803, and macOS's `tar` IS
    // bsdtar too — so the `--exclude=./x` dialect and every exit-code path in
    // archive.ts are ALREADY exercised against the same libarchive on the macOS
    // CI leg. What Windows genuinely adds is only "tar might be absent", which
    // is why the presence check exists rather than a dialect abstraction.
    resetTarProbeForTests()
    expect(tarAvailable()).toBe(Bun.which('tar') !== null)
    // Cached: backup runs hourly, so re-probing per call is pure overhead.
    expect(tarAvailable()).toBe(tarAvailable())
  })

  test('a missing tar fails with an actionable message, not a bare ENOENT', async () => {
    // The failure an operator sees must name the platform's own remedy. A raw
    // spawn error says "ENOENT", which reads like a corrupt backup path.
    const { tarGz } = await import('@/util/archive')
    if (Bun.which('tar') !== null) {
      // tar exists here, so assert the message shape from the source instead of
      // faking absence (the probe is module-level state shared with real runs).
      const src = readFileSync(resolve(import.meta.dir, '..', 'src/util/archive.ts'), 'utf8')
      expect(src).toContain('tar is not available on PATH')
      expect(src).toContain('System32')
      expect(typeof tarGz).toBe('function')
    }
  })
})

describe('RFC-254 T25c — indexer availability is diagnosable', () => {
  test('a .cmd/.bat shim is recognised as such', () => {
    // On Windows the npm-installed SCIP indexers resolve to batch shims, which
    // CreateProcess cannot execute — so "the tool is installed and still
    // reported missing" is the DEFAULT experience there. The two states need
    // opposite remedies (install it, vs. point the override at the real exe),
    // which is why they are distinguishable rather than both "unavailable".
    expect(isWindowsBatchShim('C:\\npm\\scip-typescript.cmd')).toBe(true)
    expect(isWindowsBatchShim('C:\\npm\\scip-typescript.CMD')).toBe(true)
    expect(isWindowsBatchShim('C:\\npm\\scip-typescript.bat')).toBe(true)
    expect(isWindowsBatchShim('C:\\tools\\scip-typescript.exe')).toBe(false)
    expect(isWindowsBatchShim('/usr/local/bin/scip-typescript')).toBe(false)
    // Not fooled by the extension appearing mid-path.
    expect(isWindowsBatchShim('C:\\cmd\\tool')).toBe(false)
  })
})

describe('RFC-254 — repo-relative paths in port data are portable, not host-flavoured', () => {
  // FOUND BY THE WINDOWS e2e SURVEY. `output kinds` and `mcp-runtime-playground`
  // both failed with `matrix-generated\kinds\one.md` where every other platform
  // produces `matrix-generated/kinds/one.md`. That value is not a display
  // string: it is persisted as the port's content, interpolated into the next
  // node's prompt, and matched by downstream workflow logic — so the same
  // workflow was producing different DATA depending on the host.
  test('backslashes become forward slashes; forward slashes are untouched', () => {
    expect(toPortableRelativePath('docs\\a.md', 'win32')).toBe('docs/a.md')
    expect(toPortableRelativePath('matrix-generated\\kinds\\one.md', 'win32')).toBe(
      'matrix-generated/kinds/one.md',
    )
    expect(toPortableRelativePath('docs/a.md', 'win32')).toBe('docs/a.md')
    expect(toPortableRelativePath('', 'win32')).toBe('')
  })

  // RFC-254 T32: the rewrite is gated on the platform where `\` IS a separator.
  // POSIX allows `\` inside a filename, so rewriting it there does not normalize
  // the path — it names a different one: `a\b.md` is ONE file, `a/b.md` is a
  // file inside a directory. A port value, a call-graph ref or a prompt built
  // from the rewritten form would point somewhere that does not exist.
  test('POSIX keeps a backslash, because there it is part of the NAME', () => {
    expect(toPortableRelativePath('a\\b.md', 'linux')).toBe('a\\b.md')
    expect(toPortableRelativePath('a\\b.md', 'darwin')).toBe('a\\b.md')
    // And the ordinary case is still untouched on every platform.
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(toPortableRelativePath('docs/a.md', platform)).toBe('docs/a.md')
    }
  })

  test('it is applied where the value becomes port data', () => {
    // Both sites take a `relative()` result that is stored and consumed, so a
    // future one added without the wrapper reintroduces the split.
    const envelope = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'envelope.ts'),
      'utf8',
    )
    // RFC-284 T6 改判：resolveWorktreePath 迁移到 checkLexicalThenRealpath 骨架后，
    // 两处 relative() 的实参改经 verdict 取值——锁的意图不变（relative() 产物必须
    // 包 toPortableRelativePath 再成为端口数据），锚随新拼写更新。
    expect(envelope).toContain('toPortableRelativePath(relative(v.rootAbs, targetAbs))')
    expect(envelope).toContain(
      'toPortableRelativePath(relative(v.realpath.realRoot, v.realpath.realTarget))',
    )
    const artifacts = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'portArtifacts.ts'),
      'utf8',
    )
    expect(artifacts).toContain('toPortableRelativePath(relative(realRoot, realTarget))')
    // RFC-254 T32: the call-graph index is the third such site, and it is the
    // one where the split was most damaging — the relative path IS the `ref`
    // (`src/A.java#A.run`) and the `ownerClass` that callers pass BACK IN. On
    // Windows the service emitted `src\A.java#A.run` while every caller and
    // fixture spells it with `/`, so a ref it produced could not be fed to it
    // on the platform that produced it.
    const expandService = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'services',
        'structuralDiff',
        'callGraph',
        'expandService.ts',
      ),
      'utf8',
    )
    expect(expandService).toContain('toPortableRelativePath(relative(root, join(dir, e.name)))')
  })
})

describe('RFC-254 T32 — fixture paths must be canonical on the host that runs them', () => {
  // The Windows survey's largest tractable cluster. A POSIX literal like
  // `/opt/my-cc` is NOT rejected as relative on Windows — `isAbsolute` says
  // true (leading slash = absolute on the current drive) — it fails the
  // CANONICAL round-trip, because `resolve('/opt/my-cc')` is `D:\opt\my-cc`.
  // The reported diagnosis then blames traversal, the one thing not wrong.
  test('the helper round-trips through resolve on this host', () => {
    const p = canonicalBinaryPath('my-cc')
    expect(isAbsolute(p)).toBe(true)
    expect(resolvePath(p)).toBe(p)
  })

  test('a POSIX literal does NOT round-trip under win32 semantics', () => {
    // Demonstrated through the win32 implementation so it holds on POSIX CI:
    // this is exactly why the fixtures had to stop hardcoding one.
    expect(win32.isAbsolute('/opt/my-cc')).toBe(true)
    expect(win32.resolve('/opt/my-cc')).not.toBe('/opt/my-cc')
  })

  test('the production validator is fine with a real Windows path', () => {
    // Stated so nobody "fixes" the validator: a genuine Windows path is
    // canonical and accepted. Only the fixture was unportable.
    expect(win32.resolve('D:\\tools\\opencode.exe')).toBe('D:\\tools\\opencode.exe')
  })
})
