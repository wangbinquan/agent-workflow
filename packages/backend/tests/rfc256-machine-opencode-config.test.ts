// RFC-256 — the operator's own OpenCode configuration is visible again.
//
// Why this test exists: `b4b3e082` (RFC-224, 2026-07-24) replaced the probe's
// and the run's environment wholesale with a private HOME/XDG sandbox. Before
// that commit `opencode models` was spawned with NO env argument at all, so it
// read the operator's `~/.config/opencode/opencode.json` and every model they
// had configured showed up in the pickers. After it, the probe reported an
// empty catalog and runs against those providers failed `auth-invalid` — one
// commit, two symptoms, and nothing in the product said why.
//
// The restoration is deliberately narrow, and each half is asserted here:
// the operator's GLOBAL config roots come back, while repository config,
// the session store and the private state roots stay sealed.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildControlledOpencodeConfig,
  buildHermeticServerEnv,
  deriveHermeticOpencodeLayout,
  machineConfigDeclaredPluginCount,
  machineConfigEnvOverrides,
} from '@/services/runtime/opencode/hermetic'
import { inheritsMachineOpencodeConfig } from '@/services/runtime/opencode/machineConfig'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'

const layout = deriveHermeticOpencodeLayout('/tmp/rfc256-store')
const config = buildControlledOpencodeConfig({
  name: 'auditor',
  prompt: 'p',
  description: 'd',
  model: 'mygw/deepseek-v3',
  toolOutputPattern: '/tmp/out/*',
  shellPath: '/bin/sh',
  allowShell: false,
})
const OPERATOR_ENV = { HOME: '/home/op', XDG_CONFIG_HOME: '/home/op/.config' }

const envWith = (inherit: boolean, auth?: { providerID: string; serialized: string }) =>
  buildHermeticServerEnv({
    layout,
    providerID: 'mygw',
    auth,
    config,
    username: 'u',
    password: 'p',
    sourceEnv: OPERATOR_ENV,
    inheritMachineConfig: inherit,
  })

describe('RFC-256 machine config env overrides', () => {
  test('restores exactly the two roots OpenCode discovers global config through', () => {
    // opencode config/paths.ts:23-40 — Global.Path.config comes from
    // XDG_CONFIG_HOME, and `$HOME/.opencode` from OPENCODE_TEST_HOME.
    expect(machineConfigEnvOverrides(OPERATOR_ENV)).toEqual({
      HOME: '/home/op',
      OPENCODE_TEST_HOME: '/home/op',
      XDG_CONFIG_HOME: '/home/op/.config',
    })
  })

  test('derives the XDG default when the operator has not set one', () => {
    expect(machineConfigEnvOverrides({ HOME: '/home/op' }).XDG_CONFIG_HOME).toBe('/home/op/.config')
  })

  test('ignores a relative or unset HOME rather than inventing one', () => {
    const overrides = machineConfigEnvOverrides({ HOME: 'relative/path' }, '/real/home')
    expect(overrides.HOME).toBe('/real/home')
    expect(overrides.XDG_CONFIG_HOME).toBe('/real/home/.config')
  })
})

describe('RFC-256 execution environment', () => {
  test('an inheriting run can see the operator config roots', () => {
    const env = envWith(true, { providerID: 'mygw', serialized: '{}' })
    expect(env.XDG_CONFIG_HOME).toBe('/home/op/.config')
    expect(env.HOME).toBe('/home/op')
    expect(env.OPENCODE_TEST_HOME).toBe('/home/op')
  })

  test('repository config stays blocked — that is the surface RFC-224 was for', () => {
    const env = envWith(true, { providerID: 'mygw', serialized: '{}' })
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
  })

  test('session store, state and cache stay private so resume is unaffected', () => {
    const env = envWith(true, { providerID: 'mygw', serialized: '{}' })
    expect(env.XDG_DATA_HOME).toBe(layout.xdgData)
    expect(env.XDG_STATE_HOME).toBe(layout.xdgState)
    expect(env.XDG_CACHE_HOME).toBe(layout.xdgCache)
    expect(env.TMPDIR).toBe(layout.tmp)
    expect(env.OPENCODE_CONFIG_DIR).toBe(layout.explicitConfig)
  })

  // Scope limit, asserted so nobody "fixes" it by accident: config discovery
  // comes back, plugin LOADING does not. A plugin runs inside the OpenCode
  // server process with no containment, which is a far bigger step than
  // reading a provider declaration — and providers need no plugin, since the
  // openai-compatible SDK is bundled.
  test('OPENCODE_PURE stays on — machine-config plugins are still not loaded', () => {
    expect(envWith(true, { providerID: 'mygw', serialized: '{}' }).OPENCODE_PURE).toBe('1')
    expect(envWith(false, { providerID: 'mygw', serialized: '{}' }).OPENCODE_PURE).toBe('1')
  })

  test('a plugin declared in the machine config is counted so the limit is visible', async () => {
    // Silently ignoring them is the trap; reporting the count is the mitigation.
    const dir = await mkdtemp(join(tmpdir(), 'rfc256-cfg-'))
    await writeFile(join(dir, 'opencode.json'), JSON.stringify({ plugin: ['a', 'b'] }))
    expect(machineConfigDeclaredPluginCount(dir)).toBe(2)
    await writeFile(join(dir, 'opencode.json'), JSON.stringify({ provider: {} }))
    expect(machineConfigDeclaredPluginCount(dir)).toBe(0)
    expect(machineConfigDeclaredPluginCount(join(dir, 'nope'))).toBe(0)
  })

  test('a sealed run is byte-identical to the pre-RFC-256 environment', () => {
    const sealed = envWith(false, { providerID: 'mygw', serialized: '{}' })
    expect(sealed.HOME).toBe(layout.home)
    expect(sealed.XDG_CONFIG_HOME).toBe(layout.xdgConfig)
    expect(sealed.OPENCODE_TEST_HOME).toBe(layout.testHome)
  })

  test('an inheriting run may omit the auth block; a sealed one may not', () => {
    const inherited = envWith(true)
    expect(inherited.OPENCODE_AUTH_CONTENT).toBeUndefined()
    // A provider declared in the operator's own config carries its own key, so
    // the platform having none is not a failure — it is the normal case.
    expect(() => envWith(false)).toThrow('execution-identity-auth-invalid')
  })

  test('an explicit credential still reaches OpenCode when inheriting', () => {
    const env = envWith(true, { providerID: 'mygw', serialized: '{"mygw":{"type":"api"}}' })
    expect(env.OPENCODE_AUTH_CONTENT).toBe('{"mygw":{"type":"api"}}')
  })
})

describe('RFC-256 switch', () => {
  test('defaults to on — the behavior the platform had before RFC-224', () => {
    expect(DEFAULT_CONFIG.inheritMachineOpencodeConfig).toBe(true)
    expect(inheritsMachineOpencodeConfig({ loadDaemonConfig: () => ({}) })).toBe(true)
  })

  test('an operator can seal the platform back up', () => {
    expect(
      inheritsMachineOpencodeConfig({
        loadDaemonConfig: () => ({ inheritMachineOpencodeConfig: false }),
      }),
    ).toBe(false)
  })
})
