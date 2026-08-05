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
import { netlessInvocationCommand } from '@/services/runtime/opencode/sealedSubprocess'
import { resetTarProbeForTests, tarAvailable } from '@/util/archive'
import { isWindowsBatchShim } from '@/services/structuralDiff/deep/indexers'
import { isAbsolute, resolve, resolve as resolvePath, win32 } from 'node:path'
import { canonicalBinaryPath } from './fixtures/platformPaths'
import {
  toPortableRelativePath,
  isLexicallyInside,
  nullDevice,
  pathListJoin,
  pathListSplit,
  platformSpawnOptions,
  buildControlledPath,
  controlledSystemPathEntries,
  resolveGitToolDirectory,
  disabledShellCommand,
  executableSuffix,
  platformHomeEnv,
  SEALED_SHELL_SUPPORTED,
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

describe('RFC-254 T12 — controlled PATH', () => {
  test('POSIX keeps exactly the historical two entries', () => {
    // Byte-for-byte identical to the `'/usr/bin:/bin'` literal it replaced;
    // anything else would silently widen (or narrow) the sealed capability set
    // on the two platforms that already ship.
    expect(buildControlledPath([], 'linux', undefined)).toBe('/usr/bin:/bin')
    expect(buildControlledPath([], 'darwin', undefined)).toBe('/usr/bin:/bin')
  })

  test('POSIX puts run-scoped seal directories ahead of the system ones', () => {
    expect(buildControlledPath(['/run/seal/toolchain'], 'linux', undefined)).toBe(
      '/run/seal/toolchain:/usr/bin:/bin',
    )
  })

  test('Windows covers the four directories a child actually needs', () => {
    const entries = controlledSystemPathEntries('win32', 'C:\\Windows')
    expect(entries).toEqual([
      'C:\\Windows\\System32',
      'C:\\Windows',
      'C:\\Windows\\System32\\Wbem',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    ])
    // PowerShell's presence is load-bearing: OpenCode probes pwsh → powershell
    // → git-bash → cmd, so dropping it silently downgrades the agent's shell.
    expect(entries.some((e) => e.endsWith('WindowsPowerShell\\v1.0'))).toBe(true)
  })

  test('Windows joins with ; and honours %SystemRoot%', () => {
    const path = buildControlledPath([], 'win32', 'D:\\Win')
    expect(path.split(';')[0]).toBe('D:\\Win\\System32')
    expect(path).not.toContain(':/')
  })

  test('a missing %SystemRoot% falls back rather than emitting empty entries', () => {
    // An empty PATH entry means "current directory" to some Windows resolvers —
    // a search-order hazard, so the fallback is a literal default.
    expect(controlledSystemPathEntries('win32', undefined)[0]).toBe('C:\\Windows\\System32')
    expect(controlledSystemPathEntries('win32', '')[0]).toBe('C:\\Windows\\System32')
  })

  test('duplicate entries collapse, case-insensitively on Windows only', () => {
    expect(buildControlledPath(['C:\\WINDOWS\\SYSTEM32'], 'win32', 'C:\\Windows')).toBe(
      'C:\\WINDOWS\\SYSTEM32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    )
    // POSIX is case-SENSITIVE, so these are genuinely different directories.
    expect(buildControlledPath(['/USR/BIN'], 'linux', undefined)).toBe('/USR/BIN:/usr/bin:/bin')
  })

  describe('git reachability (design gate P0-A)', () => {
    // The gate's only "core workflow does not work at all" finding: POSIX gets
    // the agent's git for free from /usr/bin, Windows installs it somewhere no
    // system directory covers, so a controlled PATH without it leaves every
    // `git status`/`diff`/`commit` failing.
    test('POSIX resolves nothing — /usr/bin already carries git', () => {
      expect(
        resolveGitToolDirectory(
          'linux',
          () => '/usr/bin/git',
          () => '/usr/bin',
        ),
      ).toBeNull()
    })

    test('Windows resolves the directory of the real git executable', () => {
      expect(
        resolveGitToolDirectory(
          'win32',
          () => 'C:\\Program Files\\Git\\cmd\\git.exe',
          () => 'C:\\Program Files\\Git\\cmd',
        ),
      ).toBe('C:\\Program Files\\Git\\cmd')
    })

    test('Windows without git resolves null rather than inventing a path', () => {
      expect(
        resolveGitToolDirectory(
          'win32',
          () => null,
          () => '',
        ),
      ).toBeNull()
    })

    test('the resolved git directory lands ON the controlled PATH', () => {
      const gitDir = 'C:\\Program Files\\Git\\cmd'
      const path = buildControlledPath([gitDir], 'win32', 'C:\\Windows')
      expect(path.split(';')).toContain(gitDir)
      // ...and ahead of the system entries, so a seal always wins.
      expect(path.split(';')[0]).toBe(gitDir)
    })
  })
})

describe('RFC-254 T11b — verified artifact shape', () => {
  test('a sealed executable keeps .exe on Windows only', () => {
    // Windows decides "runnable" from the extension, so a sealed copy written
    // without `.exe` cannot be executed — and it fails as "file not found",
    // which points the diagnosis in completely the wrong direction.
    expect(executableSuffix('linux')).toBe('')
    expect(executableSuffix('darwin')).toBe('')
    expect(executableSuffix('win32')).toBe('.exe')
  })

  test('the disabled shell is a command that exists and fails', () => {
    // Plans that must NOT have a shell still have to name an absolute, existing
    // command — the assembly validates that. A nonexistent path would be
    // indistinguishable from a mis-assembled plan, so the disabled state is
    // "present but immediately failing" instead.
    expect(disabledShellCommand('linux', undefined)).toBe('/bin/false')
    expect(disabledShellCommand('win32', 'C:\\Windows')).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(disabledShellCommand('win32', undefined)).toBe('C:\\Windows\\System32\\cmd.exe')
  })

  describe('home resolution', () => {
    test('POSIX reads HOME and nothing else', () => {
      expect(platformHomeEnv({ HOME: '/home/u', USERPROFILE: 'C:\\Users\\u' }, 'linux')).toBe(
        '/home/u',
      )
      expect(platformHomeEnv({ USERPROFILE: 'C:\\Users\\u' }, 'linux')).toBeUndefined()
    })

    test('Windows prefers USERPROFILE, which is the one that actually exists', () => {
      // A stock Windows install has no HOME at all; reading it alone made every
      // verified plan fail to assemble (design gate P0-B).
      expect(platformHomeEnv({ USERPROFILE: 'C:\\Users\\u' }, 'win32')).toBe('C:\\Users\\u')
      expect(platformHomeEnv({ USERPROFILE: 'C:\\Users\\u', HOME: '/msys/home' }, 'win32')).toBe(
        'C:\\Users\\u',
      )
    })

    test('Windows still accepts HOME when a POSIX-ish tool set it', () => {
      expect(platformHomeEnv({ HOME: 'C:\\msys\\home\\u' }, 'win32')).toBe('C:\\msys\\home\\u')
    })

    test('neither variable present yields undefined, not a guess', () => {
      expect(platformHomeEnv({}, 'win32')).toBeUndefined()
      expect(platformHomeEnv({}, 'linux')).toBeUndefined()
    })
  })
})

describe('RFC-254 T11c — platform truth is injected, never re-derived', () => {
  test('the guarded plan modules read platform facts only through helpers', () => {
    // RFC-233 forbids `process.platform` inside the OpenCode plan core so that
    // platform truth arrives with the prepared admission plan instead of being
    // rediscovered. That guard caught the first draft of T11b doing exactly
    // what it forbids, so this asserts the POSITIVE shape as well: the plan
    // modules use the host-frozen wrappers, and the platform branch lives in
    // platformExec where it can be exercised with an injected platform.
    const guarded = [
      'services/runtime/opencode/verifiedPlan.ts',
      'services/runtime/opencode/verifiedSystemPlan.ts',
      'services/runtime/opencode/verifiedMcpTestPlan.ts',
    ]
    for (const rel of guarded) {
      const text = readFileSync(resolve(import.meta.dir, '..', 'src', rel), 'utf8')
      expect(text, rel).not.toContain('process.platform')
      // ...and they DO consume the platform-shaped values, so this is not
      // vacuously true because the feature was removed.
      expect(/ForHost|EXECUTABLE_SUFFIX_FOR_HOST/.test(text), rel).toBe(true)
    }
  })
})

describe('RFC-254 T14b — netless invocation shape (design gate P0-F / D21)', () => {
  test('POSIX collapses to the single wrapper path, exactly as before', () => {
    expect(
      netlessInvocationCommand('/seal/mcp/x/run', '/seal/mcp/x/netless.json', 'linux'),
    ).toEqual(['/seal/mcp/x/run'])
  })

  test('Windows spawns the self-command directly, with the manifest as an argument', () => {
    // No `.cmd` shim on purpose: cmd.exe RE-TOKENIZES what it forwards, and an
    // MCP invocation carries JSON and paths — re-tokenization is data
    // corruption, which is the argv-mangling failure multica hit driving the
    // same CLI. And no shebang exists on Windows, so the POSIX shape is simply
    // unavailable.
    const cmd = netlessInvocationCommand(
      'C:\\seal\\mcp\\x\\run',
      'C:\\seal\\mcp\\x\\netless.json',
      'win32',
    )
    expect(cmd.length).toBeGreaterThan(1)
    expect(cmd).toContain('--manifest')
    expect(cmd).toContain('C:\\seal\\mcp\\x\\netless.json')
    expect(cmd).toContain('__opencode-netless-subprocess')
    // The wrapper path must NOT appear — nothing is materialized there.
    expect(cmd).not.toContain('C:\\seal\\mcp\\x\\run')
  })

  test('both platforms still route through the SAME fence entry point', () => {
    // The manifest is what actually carries the fence; only the way the process
    // is entered differs. If these ever named different subcommands, one
    // platform would be running an unfenced child.
    const win = netlessInvocationCommand('/w/run', '/w/netless.json', 'win32')
    expect(win).toContain('__opencode-netless-subprocess')
  })
})

describe('RFC-254 T13 — the sealed shell is a platform capability, not an assumption', () => {
  test('the flag matches the platform that can actually host a shebang script', () => {
    expect(SEALED_SHELL_SUPPORTED).toBe(process.platform !== 'win32')
  })

  test('the controlled config omits `shell` exactly when it cannot be sealed', () => {
    // Absence is part of the identity: the controlled config is a CLOSED
    // construction, so "no shell key" is as much a fact as "shell equals X".
    // Declaring a path to a wrapper that T14b no longer materializes would
    // point OpenCode at a missing file instead.
    const identity = readFileSync(
      resolve(import.meta.dir, '..', 'src/services/runtime/opencode/executionIdentity.ts'),
      'utf8',
    )
    expect(identity).toContain('SEALED_SHELL_SUPPORTED')
    // The unexpected-shell case must still fail — a platform without a sealed
    // shell must not silently accept one somebody else put there.
    expect(identity).toContain('config.shell !== undefined')
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
    expect(envelope).toContain('toPortableRelativePath(relative(rootAbs, targetAbs))')
    expect(envelope).toContain('toPortableRelativePath(relative(realRoot, realTarget))')
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
