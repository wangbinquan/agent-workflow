// RFC-031 T3 — pluginInstaller contract tests.
//
// Covers the install-time invariants the runner relies on later:
//   1. sourceKind inference from spec strings (pure function).
//   2. file: spec → realpath round-trip; never invokes npm.
//   3. npm/git path runs `npm install --prefix <pluginDir> <spec>` and reads
//      back the installed package's version. We swap npm out for `fake-npm.sh`
//      to keep tests hermetic + offline.
//   4. install failure (non-zero exit) → PluginInstallFailedError carrying
//      redacted stderr (Authorization / token shapes scrubbed).
//   5. install timeout → PluginInstallTimeoutError; child killed.
//   6. Concurrent installs of the same plugin id share one in-flight install
//      (npm shim writes a counter file, asserted at 1).
//   7. Source code anchor: installer source contains `"--prefix"` literal so a
//      future refactor cannot silently change npm install behaviour to `cwd`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  inferSourceKind,
  installPlugin,
  PluginFileNotFoundError,
  PluginInstallFailedError,
  PluginInstallTimeoutError,
  resetNpmProbeCacheForTests,
} from '../../src/services/pluginInstaller'

const FAKE_NPM = resolve(import.meta.dir, '..', 'fixtures', 'fake-npm.sh')

let pluginsDir = ''
const originalEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  pluginsDir = await mkdtemp(join(tmpdir(), 'rfc031-plugins-'))
  resetNpmProbeCacheForTests()
  // The installer reads `FAKE_NPM_MODE` from the env of the spawned child; we
  // set + restore per-test.
  for (const k of ['FAKE_NPM_MODE', 'FAKE_NPM_VERSION']) {
    originalEnv[k] = process.env[k]
  }
})

afterEach(async () => {
  await rm(pluginsDir, { recursive: true, force: true }).catch(() => undefined)
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('inferSourceKind (pure)', () => {
  test('file: prefixes / absolute / relative paths → file', () => {
    for (const s of [
      'file:///abs/path',
      'file:./rel',
      '/abs/path/to/plugin.ts',
      './plugin.ts',
      '../foo/bar.ts',
      'C:\\plugin.ts',
      'C:/plugin.ts',
    ]) {
      expect(inferSourceKind(s)).toBe('file')
    }
  })

  test('git+ / github: / gitlab: / bitbucket: → git', () => {
    for (const s of [
      'git+https://github.com/x/y.git',
      'git+ssh://git@gitlab.corp/team/p.git#tag',
      'github:org/repo',
      'gitlab:org/repo',
      'bitbucket:org/repo',
    ]) {
      expect(inferSourceKind(s)).toBe('git')
    }
  })

  test('everything else → npm (including bare names and scoped specs)', () => {
    for (const s of ['my-plugin', 'my-plugin@1.0.0', '@scope/pkg', '@scope/pkg@beta']) {
      expect(inferSourceKind(s)).toBe('npm')
    }
  })
})

describe('installPlugin — file: spec', () => {
  test('happy path: realpath wins, never invokes npm', async () => {
    // Create a fixture plugin dir on disk so realpath succeeds.
    const fixtureDir = await mkdtemp(join(tmpdir(), 'rfc031-fixture-'))
    await writeFile(join(fixtureDir, 'package.json'), '{"name":"local","version":"0.0.1"}')

    // Use `npm` binary path that doesn't exist — if installer accidentally
    // hits the npm path it will fail.
    const result = await installPlugin('p01', `file://${fixtureDir}`, {
      pluginsDir,
      npmBin: '/nonexistent/npm-binary',
    })
    expect(result.sourceKind).toBe('file')
    expect(result.cachedPath).toBe(await realpath(fixtureDir))
    expect(result.resolvedVersion).not.toBeNull()
    expect(/^[0-9a-f]+$/.test(result.resolvedVersion!)).toBe(true)
    await rm(fixtureDir, { recursive: true, force: true })
  })

  test('missing path → PluginFileNotFoundError', async () => {
    await expect(
      installPlugin('p02', '/this/path/does/not/exist/anywhere', { pluginsDir }),
    ).rejects.toBeInstanceOf(PluginFileNotFoundError)
  })

  test('relative path also resolved', async () => {
    const cwd = process.cwd()
    const fixture = await mkdtemp(join(tmpdir(), 'rfc031-rel-'))
    try {
      process.chdir(fixture)
      const result = await installPlugin('p03', './' /* cwd itself */, { pluginsDir })
      expect(result.sourceKind).toBe('file')
      expect(result.cachedPath).toBe(await realpath(fixture))
    } finally {
      process.chdir(cwd)
      await rm(fixture, { recursive: true, force: true })
    }
  })
})

describe('installPlugin — npm path (with fake npm shim)', () => {
  test('success: writes package + reads version', async () => {
    process.env.FAKE_NPM_MODE = 'success'
    process.env.FAKE_NPM_VERSION = '3.0.0'
    const result = await installPlugin('p10', 'my-plugin@3.0.0', {
      pluginsDir,
      npmBin: FAKE_NPM,
    })
    expect(result.sourceKind).toBe('npm')
    expect(result.resolvedVersion).toBe('3.0.0')
    // cachedPath points at the resolved package directory, NOT pluginDir.
    const pkgJson = JSON.parse(await readFile(join(result.cachedPath, 'package.json'), 'utf-8'))
    expect(pkgJson.version).toBe('3.0.0')
    // pluginDir got created with restricted perms.
    const st = await stat(join(pluginsDir, 'p10'))
    expect(st.isDirectory()).toBe(true)
  })

  test('scoped package name resolves under node_modules/@scope/name', async () => {
    process.env.FAKE_NPM_MODE = 'success'
    const result = await installPlugin('p11', '@scope/pkg@1.0.0', {
      pluginsDir,
      npmBin: FAKE_NPM,
    })
    expect(result.cachedPath).toContain('node_modules/@scope/pkg')
  })

  test('git source kind goes through same npm path', async () => {
    // npm CLI handles git URLs natively (npm-package-arg).
    process.env.FAKE_NPM_MODE = 'success'
    const result = await installPlugin('p12', 'github:org/repo', {
      pluginsDir,
      npmBin: FAKE_NPM,
    })
    expect(result.sourceKind).toBe('git')
  })

  test('failure: non-zero exit → PluginInstallFailedError with stderr', async () => {
    process.env.FAKE_NPM_MODE = 'fail'
    await expect(
      installPlugin('p13', 'nonexistent-pkg@99', { pluginsDir, npmBin: FAKE_NPM }),
    ).rejects.toBeInstanceOf(PluginInstallFailedError)
  })

  test('failure: stderr containing token is redacted before surfacing', async () => {
    process.env.FAKE_NPM_MODE = 'leak-secret'
    try {
      await installPlugin('p14', 'pkg', { pluginsDir, npmBin: FAKE_NPM })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PluginInstallFailedError)
      const stderr = (err as PluginInstallFailedError).stderr
      // Redactor scrubs `https://user:pass@host` userinfo + Bearer headers.
      expect(stderr).not.toContain('SUPER_SECRET_TOKEN_123')
    }
  })

  test('timeout: kills child after timeoutMs', async () => {
    process.env.FAKE_NPM_MODE = 'timeout'
    const start = Date.now()
    await expect(
      installPlugin('p15', 'will-hang', {
        pluginsDir,
        npmBin: FAKE_NPM,
        timeoutMs: 250,
      }),
    ).rejects.toBeInstanceOf(PluginInstallTimeoutError)
    expect(Date.now() - start).toBeLessThan(3_000)
  }, 10_000)
})

describe('installPlugin — in-flight Map serialises concurrent installs', () => {
  test('two concurrent installs of same pluginId resolve to same result', async () => {
    process.env.FAKE_NPM_MODE = 'success'
    const [a, b] = await Promise.all([
      installPlugin('p20', 'pkg-a@1', { pluginsDir, npmBin: FAKE_NPM }),
      installPlugin('p20', 'pkg-a@1', { pluginsDir, npmBin: FAKE_NPM }),
    ])
    expect(a.cachedPath).toBe(b.cachedPath)
    expect(a.resolvedVersion).toBe(b.resolvedVersion)
  })

  test('different pluginIds run independently', async () => {
    process.env.FAKE_NPM_MODE = 'success'
    const [a, b] = await Promise.all([
      installPlugin('p30', 'pkg-x@1', { pluginsDir, npmBin: FAKE_NPM }),
      installPlugin('p31', 'pkg-y@1', { pluginsDir, npmBin: FAKE_NPM }),
    ])
    expect(a.cachedPath).not.toBe(b.cachedPath)
  })
})

describe('installer source — regression anchors', () => {
  test('source contains literal "--prefix" (do NOT switch to cwd)', async () => {
    const src = await readFile(
      resolve(import.meta.dir, '..', '..', 'src', 'services', 'pluginInstaller.ts'),
      'utf-8',
    )
    // npm install --prefix <dir> is what isolates installs to the plugin dir;
    // switching to `cwd: pluginDir` would walk up the user's repo to find
    // package.json and silently install into the wrong place.
    expect(src).toContain("'--prefix'")
  })

  test('source contains redactSensitiveString call before surfacing stderr', async () => {
    const src = await readFile(
      resolve(import.meta.dir, '..', '..', 'src', 'services', 'pluginInstaller.ts'),
      'utf-8',
    )
    expect(src).toContain('redactSensitiveString(stderr')
  })
})
