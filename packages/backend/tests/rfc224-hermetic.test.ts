import { afterEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { statMetadataIsAuthoritative } from '@/util/fileTrust'
import { buildControlledPathForHost, nullDevice } from '@/util/platformExec'
import { ExecutionIdentityFailure } from '@/services/runtime/opencode/failure'
import { removeSealedTree } from '@/services/runtime/opencode/sealedInputs'
import {
  assertBundledProviderImplementation,
  buildControlledOpencodeConfig,
  buildHermeticServerEnv,
  buildStrictProviderAuth,
  prepareHermeticOpencodeLayout,
  resolveNativeOpencodeAuthPath,
  resolveStrictProviderAuth,
} from '@/services/runtime/opencode/hermetic'

const roots: string[] = []
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'rfc224-hermetic-'))
  roots.push(value)
  return value
}
afterEach(async () => {
  for (const path of roots.splice(0)) await removeSealedTree(path)
})

function expectCode(error: unknown, code: ExecutionIdentityFailure['code']) {
  expect(error).toBeInstanceOf(ExecutionIdentityFailure)
  expect((error as ExecutionIdentityFailure).code).toBe(code)
}

describe('RFC-224 strict provider auth', () => {
  test('accepts exactly one selected provider API entry and canonicalizes it', () => {
    const result = buildStrictProviderAuth('openai', {
      OPENCODE_AUTH_CONTENT: JSON.stringify({
        openai: { key: 'private-key', type: 'api' },
      }),
    })
    expect(result.providerID).toBe('openai')
    expect(JSON.parse(result.serialized)).toEqual({
      openai: { key: 'private-key', type: 'api' },
    })
  })

  test('can classify one explicit provider API key env without forwarding the raw name', () => {
    const result = buildStrictProviderAuth('anthropic', {
      ANTHROPIC_API_KEY: 'secret',
    })
    expect(JSON.parse(result.serialized)).toEqual({
      anthropic: { type: 'api', key: 'secret' },
    })
  })

  test.each([
    ['bad json', '{'],
    ['oauth', JSON.stringify({ openai: { type: 'oauth', access: 'secret' } })],
    ['wellknown', JSON.stringify({ openai: { type: 'wellknown', key: 'secret' } })],
    [
      'extra provider',
      JSON.stringify({
        openai: { type: 'api', key: 'secret' },
        anthropic: { type: 'api', key: 'other' },
      }),
    ],
    [
      'extra field',
      JSON.stringify({ openai: { type: 'api', key: 'secret', token: 'unexpected' } }),
    ],
  ])('rejects inherited auth shape: %s', (_name, serialized) => {
    try {
      buildStrictProviderAuth('openai', { OPENCODE_AUTH_CONTENT: serialized })
      throw new Error('expected failure')
    } catch (error) {
      expectCode(error, 'execution-identity-auth-invalid')
      expect(String(error)).not.toContain('secret')
    }
  })

  test('rejects absent, ambiguous, NUL and unclassified API key envs', () => {
    for (const env of [
      {},
      { OPENAI_API_KEY: 'one', OPENCODE_AUTH_CONTENT: '' },
      { GOOGLE_GENERATIVE_AI_API_KEY: 'one', GEMINI_API_KEY: 'two' },
      { OPENAI_API_KEY: 'bad\0key' },
    ]) {
      const provider =
        'GOOGLE_GENERATIVE_AI_API_KEY' in env || 'GEMINI_API_KEY' in env ? 'google' : 'unknown'
      try {
        buildStrictProviderAuth(provider, env)
        throw new Error('expected failure')
      } catch (error) {
        expectCode(error, 'execution-identity-auth-invalid')
      }
    }
  })

  test('imports only the selected provider from the native OpenCode auth store', async () => {
    // Regression: OpenCode was logged in with zhipuai in Global.Path.data/auth.json,
    // but the verified plan only recognized a fixed env-key table and failed
    // before spawn with execution-identity-auth-invalid.
    const xdgData = root()
    const store = join(xdgData, 'opencode')
    await mkdir(store)
    await writeFile(
      join(store, 'auth.json'),
      JSON.stringify({
        openai: { type: 'api', key: 'must-not-cross-the-boundary' },
        zhipuai: { type: 'api', key: 'selected-native-key' },
      }),
      { mode: 0o600 },
    )

    const result = await resolveStrictProviderAuth('zhipuai', { XDG_DATA_HOME: xdgData })
    expect(JSON.parse(result.serialized)).toEqual({
      zhipuai: { type: 'api', key: 'selected-native-key' },
    })
    expect(result.serialized).not.toContain('must-not-cross-the-boundary')
  })

  test('keeps explicit daemon credentials ahead of the native store', async () => {
    const result = await resolveStrictProviderAuth(
      'openai',
      {
        OPENAI_API_KEY: 'explicit-key',
      },
      { nativeAuthPath: join(root(), 'missing-auth.json') },
    )
    expect(JSON.parse(result.serialized)).toEqual({
      openai: { type: 'api', key: 'explicit-key' },
    })
  })

  test('rejects an unsafe or non-API selected entry in the native store', async () => {
    const xdgData = root()
    const store = join(xdgData, 'opencode')
    await mkdir(store)
    const authPath = join(store, 'auth.json')
    await writeFile(
      authPath,
      JSON.stringify({ zhipuai: { type: 'api', key: 'secret', extra: true } }),
      { mode: 0o600 },
    )
    try {
      await resolveStrictProviderAuth('zhipuai', { XDG_DATA_HOME: xdgData })
      throw new Error('expected failure')
    } catch (error) {
      expectCode(error, 'execution-identity-auth-invalid')
      expect(String(error)).not.toContain('secret')
    }

    const target = join(root(), 'target-auth.json')
    await writeFile(target, JSON.stringify({ zhipuai: { type: 'api', key: 'secret' } }))
    const linkedData = root()
    await mkdir(join(linkedData, 'opencode'))
    await symlink(target, join(linkedData, 'opencode', 'auth.json'))
    try {
      await resolveStrictProviderAuth('zhipuai', { XDG_DATA_HOME: linkedData })
      throw new Error('expected failure')
    } catch (error) {
      expectCode(error, 'execution-identity-auth-invalid')
    }
  })

  test('resolves the same xdg-basedir auth path without an OS/version branch', () => {
    // RFC-254: host-resolve the fixture roots. resolveNativeOpencodeAuthPath's
    // canonicalization guard (resolve(dataRoot) === dataRoot) rejects a bare POSIX
    // path on Windows (path.resolve adds the drive + '\'); production always passes
    // a real home/XDG dir, so only these literal fixtures trip it. resolve() is a
    // no-op on POSIX and yields a canonical Windows path on win32.
    const home = resolve('/users/me')
    expect(resolveNativeOpencodeAuthPath({}, home)).toBe(
      join(home, '.local', 'share', 'opencode', 'auth.json'),
    )
    const xdg = resolve('/data')
    expect(resolveNativeOpencodeAuthPath({ XDG_DATA_HOME: xdg }, resolve('/ignored'))).toBe(
      join(xdg, 'opencode', 'auth.json'),
    )
  })
})

describe('RFC-224 hermetic layout and env', () => {
  test('materializes three distinct config roots and seals their prebuilt gitignore', async () => {
    const layout = await prepareHermeticOpencodeLayout(root())
    expect(new Set(layout.configRoots).size).toBe(3)
    for (const configRoot of layout.configRoots) {
      // RFC-254: win32 uses per-user ACL, not POSIX mode bits (chmod 0o500 reads
      // back as 0o444) — the sealing is enforced/verified via the ACL path there.
      if (statMetadataIsAuthoritative(process.platform)) {
        expect((await lstat(configRoot)).mode & 0o777).toBe(0o500)
      }
      expect(await readFile(join(configRoot, '.gitignore'), 'utf8')).toBe('*\n!.gitignore\n')
      if (statMetadataIsAuthoritative(process.platform)) {
        expect((await lstat(join(configRoot, '.gitignore'))).mode & 0o777).toBe(0o400)
      }
    }
    // RFC-254: separator-agnostic — sessionDbPath is a host path (backslashes on
    // Windows); assert the shape, not the POSIX literal.
    expect(layout.sessionDbPath.replace(/\\/g, '/')).toContain('/xdg-data/opencode/opencode.db')
  })

  test('rejects a symlinked private root', async () => {
    const parent = root()
    const target = root()
    const link = join(parent, 'store')
    await symlink(target, link)
    try {
      await prepareHermeticOpencodeLayout(link)
      throw new Error('expected failure')
    } catch (error) {
      expectCode(error, 'execution-identity-store-unsafe')
    }
    // RFC-254: drop the symlink we created before afterEach runs. removeSealedTree's
    // rm-on-symlink EFAULTs on Windows (Bun); production never seals a symlinked root
    // (it's rejected above), so this only bites the test's own cleanup. unlink drops
    // the reparse point without following it. (The removeSealedTree Windows-symlink
    // robustness gap is logged in docs/audit-backlog.md — latent, edge-only.)
    await unlink(link).catch(() => {})
  })

  test('rebuilds env from an allowlist and scrubs loader/runtime/git/OpenCode injection', async () => {
    const layout = await prepareHermeticOpencodeLayout(root())
    const auth = buildStrictProviderAuth('openai', {
      OPENCODE_AUTH_CONTENT: JSON.stringify({
        openai: { type: 'api', key: 'secret' },
      }),
    })
    const env = buildHermeticServerEnv({
      layout,
      providerID: 'openai',
      auth,
      config: { share: 'disabled' },
      username: 'user',
      password: 'pass',
      sourceEnv: {
        LANG: 'C.UTF-8',
        HTTPS_PROXY: 'http://proxy.example',
        NODE_OPTIONS: '--require evil',
        LD_PRELOAD: '/evil.so',
        DYLD_INSERT_LIBRARIES: '/evil.dylib',
        BASH_ENV: '/evil',
        ZDOTDIR: '/evil',
        GIT_EXEC_PATH: '/evil',
        GIT_SSH_COMMAND: 'evil',
        OPENCODE_PERMISSION: '{"*":"allow"}',
        OPENCODE_CONFIG: '/evil',
        OPENAI_API_KEY: 'must-not-be-forwarded',
      },
    })
    expect(env.LANG).toBe('C.UTF-8')
    expect(env.HTTPS_PROXY).toBe('http://proxy.example')
    // RFC-254: single-source — env.PATH must be the platform's controlled PATH
    // (POSIX '/usr/bin:/bin'; win32 the git-bin + System32 chain, T12), never a
    // passthrough of the malicious sourceEnv (which sets no PATH here).
    expect(env.PATH).toBe(buildControlledPathForHost())
    expect(env.HOME).toBe(layout.home)
    expect(env.OPENCODE_SERVER_USERNAME).toBe('user')
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('pass')
    expect(env.OPENCODE_PURE).toBe('1')
    // RFC-254 (ARM64 VM): git — even git-for-Windows, an MSYS2 build — understands
    // the POSIX /dev/null but NOT the Windows NUL device as a *config path* (it
    // fails `unable to access 'NUL'`). Pointing GIT_CONFIG_GLOBAL at NUL made EVERY
    // git call fail, so opencode's worktree detection fell back to the "global"
    // project and the verified session `path` no longer matched the worktree —
    // the whole verified path was dead on Windows. The git-config null must always
    // be /dev/null, never the host null device.
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(env.GIT_CONFIG_GLOBAL).not.toBe(nullDevice('win32'))
    for (const key of [
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'BASH_ENV',
      'ZDOTDIR',
      'GIT_EXEC_PATH',
      'GIT_SSH_COMMAND',
      'OPENCODE_PERMISSION',
      'OPENCODE_CONFIG',
      'OPENAI_API_KEY',
    ]) {
      expect(env).not.toHaveProperty(key)
    }
  })

  test('preserves the load-bearing permission insertion order in config content', async () => {
    const layout = await prepareHermeticOpencodeLayout(root())
    const auth = buildStrictProviderAuth('openai', {
      OPENAI_API_KEY: 'schema-only-key',
    })
    const config = buildControlledOpencodeConfig({
      name: 'worker',
      prompt: 'prompt',
      description: 'worker',
      model: 'openai/gpt-5',
      toolOutputPattern: '/private/store/opencode/tool-output/*',
      shellPath: '/bin/false',
      allowShell: false,
    })
    const env = buildHermeticServerEnv({
      layout,
      providerID: 'openai',
      auth,
      config,
      sourceEnv: {},
    })
    const serialized = env.OPENCODE_CONFIG_CONTENT
    expect(serialized).toBeDefined()
    if (serialized === undefined) throw new Error('missing controlled config content')
    const decoded = JSON.parse(serialized) as {
      agent: { worker: { permission: { external_directory: Record<string, string> } } }
    }
    expect(Object.keys(decoded.agent.worker.permission.external_directory)).toEqual([
      '/private/store/opencode/tool-output/*',
      '*',
    ])
  })
})

describe('RFC-224 controlled raw config', () => {
  test('pins all top-level security fields and the load-bearing permission tail', () => {
    const config = buildControlledOpencodeConfig({
      name: 'worker',
      prompt: 'frozen prompt',
      description: 'worker',
      model: 'openai/gpt-5.6',
      variant: 'high',
      toolOutputPattern: '/private/store/opencode/tool-output/*',
      shellPath: '/private/seal/sh',
      allowShell: true,
      userPermission: { custom: 'allow', read: 'allow' },
    })
    expect(config).toMatchObject({
      share: 'disabled',
      autoupdate: false,
      snapshot: false,
      formatter: false,
      lsp: false,
      instructions: [],
      skills: { paths: [], urls: [] },
      compaction: { auto: false, prune: false },
      shell: '/private/seal/sh',
      plugin: [],
    })
    const agent = (config.agent as Record<string, Record<string, unknown>>).worker!
    const permission = agent.permission as Record<string, unknown>
    expect(permission.bash).toBe('allow')
    expect(permission.read).toBe('deny')
    expect(permission.skill).toBe('deny')
    expect(Object.keys(permission).at(-1)).toBe('external_directory')
    expect(permission.external_directory).toEqual({
      '/private/store/opencode/tool-output/*': 'deny',
      '*': 'deny',
    })
  })

  test('requires absolute shell/tool-output identities', () => {
    try {
      buildControlledOpencodeConfig({
        name: 'worker',
        prompt: 'prompt',
        description: 'desc',
        model: 'openai/gpt',
        toolOutputPattern: 'relative/*',
        shellPath: './sh',
        allowShell: false,
      })
      throw new Error('expected failure')
    } catch (error) {
      expectCode(error, 'execution-identity-mismatch')
    }
  })

  test('pins the exact official bundled implementation allowlist', () => {
    expect(() => assertBundledProviderImplementation('@ai-sdk/openai')).not.toThrow()
    for (const npm of ['file:///tmp/evil.ts', '@attacker/fork', '@ai-sdk/openai@latest']) {
      try {
        assertBundledProviderImplementation(npm)
        throw new Error('expected failure')
      } catch (error) {
        expectCode(error, 'execution-identity-provider-untrusted')
      }
    }
  })
})
