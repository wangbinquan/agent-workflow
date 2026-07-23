import { afterEach, describe, expect, test } from 'bun:test'
import { lstat, readFile, symlink } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionIdentityFailure } from '@/services/runtime/opencode/failure'
import { removeSealedTree } from '@/services/runtime/opencode/sealedInputs'
import {
  assertBundledProviderImplementation,
  buildControlledOpencodeConfig,
  buildHermeticServerEnv,
  buildStrictProviderAuth,
  prepareHermeticOpencodeLayout,
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
})

describe('RFC-224 hermetic layout and env', () => {
  test('materializes three distinct config roots and seals their prebuilt gitignore', async () => {
    const layout = await prepareHermeticOpencodeLayout(root())
    expect(new Set(layout.configRoots).size).toBe(3)
    for (const configRoot of layout.configRoots) {
      expect((await lstat(configRoot)).mode & 0o777).toBe(0o500)
      expect(await readFile(join(configRoot, '.gitignore'), 'utf8')).toBe('*\n!.gitignore\n')
      expect((await lstat(join(configRoot, '.gitignore'))).mode & 0o777).toBe(0o400)
    }
    expect(layout.sessionDbPath).toContain('/xdg-data/opencode/opencode.db')
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
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe(layout.home)
    expect(env.OPENCODE_SERVER_USERNAME).toBe('user')
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('pass')
    expect(env.OPENCODE_PURE).toBe('1')
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
