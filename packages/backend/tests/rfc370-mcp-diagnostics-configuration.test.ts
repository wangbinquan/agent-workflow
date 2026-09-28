import { describe, expect, test } from 'bun:test'
import { createMcpDiagnosticsEffects } from '@/modules/resource-catalog/infrastructure/mcpDiagnosticsEffects'
import type { McpDiagnosticsEffectDependencies } from '@/modules/resource-catalog/infrastructure/mcpDiagnosticsEffects'
import type { McpDiagnosticRuntime } from '@/modules/resource-catalog/application/mcps/runtimeDiagnosticsEffects'

// RFC-370: diagnostics must use the injected, current configuration. A hosted
// configuration read may finish later or fail; neither case may select a stale
// runtime or silently fall back to the daemon's local config file.
function runtime(name: string, protocol: McpDiagnosticRuntime['protocol']): McpDiagnosticRuntime {
  return {
    id: `runtime-${name}`,
    name,
    protocol,
    binaryPath: null,
    enabled: true,
    configDirEnv: null,
    configDirName: null,
    probeFence: 4,
    model: null,
    variant: null,
    temperature: null,
    steps: null,
    maxSteps: null,
    isSandbox: false,
  }
}

function effects(
  configuration: McpDiagnosticsEffectDependencies['configuration'],
  loadRuntime: McpDiagnosticsEffectDependencies['loadRuntime'],
) {
  return createMcpDiagnosticsEffects({
    configuration,
    loadRuntime,
    appHome: '/unused/rfc370-mcp-configuration',
    isRuntimeEligible: () => true,
  })
}

describe('RFC-370 MCP diagnostics configuration adapter', () => {
  test('awaits configuration before selecting a runtime and rereads on each resolution', async () => {
    const selected: string[] = []
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const configured = {
      defaultRuntime: 'first',
      opencodePath: '/runtime/first-opencode',
      claudeCodePath: '/runtime/second-claude',
    }
    const adapter = effects(
      {
        async read() {
          await barrier
          return { ...configured }
        },
      },
      async (name) => {
        selected.push(name)
        return runtime(name, name === 'first' ? 'opencode' : 'claude-code')
      },
    )
    const pending = adapter.resolveRuntime(null)
    expect(selected).toEqual([])
    release()
    expect(await pending).toMatchObject({ binary: '/runtime/first-opencode' })
    configured.defaultRuntime = 'second'
    const second = await adapter.resolveRuntime(null)
    expect(second.binary).toBe('/runtime/second-claude')
    expect(JSON.parse(second.snapshotJson)).toMatchObject({
      name: 'second',
      resolvedBinaryPath: '/runtime/second-claude',
      probeFence: 4,
    })
    expect(selected).toEqual(['first', 'second'])
  })

  test('keeps explicit profile and profile binary precedence over configuration defaults', async () => {
    const selected: string[] = []
    const adapter = effects(
      { read: () => ({ defaultRuntime: 'other', opencodePath: '/config/opencode' }) },
      async (name) => {
        selected.push(name)
        return { ...runtime(name, 'opencode'), binaryPath: '/profile/opencode' }
      },
    )
    expect(await adapter.resolveRuntime('chosen')).toMatchObject({ binary: '/profile/opencode' })
    expect(selected).toEqual(['chosen'])
  })

  test('preserves the opencode default when no configured runtime or binary exists', async () => {
    const adapter = effects({ read: async () => ({}) }, async (name) => runtime(name, 'opencode'))
    expect(await adapter.resolveRuntime(null)).toMatchObject({
      row: { name: 'opencode' },
      binary: 'opencode',
    })
  })

  test('propagates asynchronous configuration failure before runtime lookup', async () => {
    const failure = new Error('configuration-storage-unavailable')
    let lookedUp = false
    const adapter = effects(
      {
        read: async () => {
          throw failure
        },
      },
      async (name) => {
        lookedUp = true
        return runtime(name, 'opencode')
      },
    )
    await expect(adapter.resolveRuntime('explicit')).rejects.toBe(failure)
    expect(lookedUp).toBe(false)
  })
})
