// RFC-370 hosted acceptance (2026-10-18) — the RFC-030 MCP probe runs where
// hosted Agents run their MCP servers: inside the CrewStation task image.
//
// WHY THIS FILE EXISTS (regression intent): on the live platform the probe of a
// local stdio server (`node -e …`) failed `connect-failed: Executable not found
// in $PATH: "node"` in 82 ms. The route spawned it inside the AW service
// container, which has no node/npx and is not where hosted Agents start their
// servers (RFC-370 §3.3: no hosted entry spawns in the service slot). The
// hosted MCP diagnostics now select a probe runner that sends the probe to the
// task image as an `mcp-probe` command; the route keeps admission, freshness
// and persistence and probes in-process only when no runner is selected.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Mcp, McpOperationResource } from '@agent-workflow/shared'
import {
  createHostedMcpProbe,
  HOSTED_MCP_PROBE_TIMEOUT_MS,
} from '@/modules/resource-catalog/infrastructure/crewstation/mcpProbe'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import type {
  WorkspaceHelper,
  WorkspaceHelperOptions,
} from '@/platform/crewstation/workspaceProtocol'

const FIXTURE = resolve(import.meta.dir ?? '.', 'fixtures', 'mock-mcp-stdio.ts')
// Spawning a real stdio server is gated like tests/mcp-probe-stdio-integration.test.ts.
const RUN_GIT_NETWORK = process.env.RUN_GIT_NETWORK === '1'

function localMcp(overrides: Partial<Mcp> = {}): Mcp {
  return {
    id: '01M57CPBV5EJJ70V3FS02XGMQ4',
    name: 'm2-local',
    description: '',
    type: 'local',
    config: {
      command: ['bun', FIXTURE, 'ok'],
      env: { M2_LOCAL_TOKEN: 'token' },
      timeoutMs: 10_000,
    },
    enabled: true,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as Mcp
}

const measurement = {
  status: 'ok' as const,
  latencyMs: 41,
  handshakeMs: 12,
  serverInfo: { name: 'mock-mcp-stdio', version: '0.1.0' },
  protocolVersion: '2025-06-18',
  capabilities: { tools: {} },
  tools: [{ name: 'ping' }],
  resources: [],
  resourceTemplates: [],
  prompts: [],
  errorCode: null,
  errorMessage: null,
  errorDetail: null,
  startedAt: 1000,
  finishedAt: 1041,
}

describe('hosted MCP probe runner', () => {
  test('sends the probe to the task image on the shared scratch volume and returns its measurement', async () => {
    const calls: Array<{
      taskId: string
      operation: string
      input: unknown
      options: WorkspaceHelperOptions | undefined
    }> = []
    const helper: WorkspaceHelper = {
      async call<T>(
        taskId: string,
        operation: string,
        input: unknown,
        options?: WorkspaceHelperOptions,
      ) {
        calls.push({ taskId, operation, input, options })
        return measurement as T
      },
    }
    const mcp: McpOperationResource = { ...localMcp(), operationConfigHash: 'a'.repeat(64) }
    expect(await createHostedMcpProbe({ helper })(mcp, { startedAt: 1000 })).toEqual(measurement)
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call).toMatchObject({ taskId: 'system:shared', operation: 'mcp-probe' })
    // Only the MCP definition crosses: wire fields such as the operation hash stay behind.
    expect(call!.input).toEqual({ mcp: localMcp(), startedAt: 1000 })
    expect(call!.options).toEqual({
      operationId: `mcp-probe:${mcp.id}:1000`,
      timeoutMs: HOSTED_MCP_PROBE_TIMEOUT_MS,
    })
  })

  test('a reply that is not a probe measurement is rejected', async () => {
    const helper: WorkspaceHelper = {
      async call<T>() {
        return { ...measurement, status: 'unknown' } as T
      },
    }
    await expect(createHostedMcpProbe({ helper })(localMcp(), { startedAt: 1 })).rejects.toThrow()
  })
})

describe('task-image mcp-probe operation', () => {
  test('a disabled MCP is refused before any process starts', async () => {
    await expect(
      executeWorkspaceTaskImageOperation('mcp-probe', {
        mcp: localMcp({ enabled: false }),
        startedAt: 1,
      }),
    ).rejects.toMatchObject({ code: 'mcp-disabled' })
  })

  test('a request outside the operation contract is refused', async () => {
    await expect(
      executeWorkspaceTaskImageOperation('mcp-probe', {
        mcp: localMcp(),
        startedAt: 1,
        command: ['sh'],
      }),
    ).rejects.toThrow()
  })

  test.skipIf(!RUN_GIT_NETWORK)(
    'probes a real stdio server and keeps the route-captured start time',
    async () => {
      const result = (await executeWorkspaceTaskImageOperation('mcp-probe', {
        mcp: localMcp(),
        startedAt: 1234,
      })) as typeof measurement
      expect(result.status).toBe('ok')
      expect(result.tools?.map((tool) => tool.name).sort()).toEqual([
        'explain',
        'ping',
        'query',
        'schema',
      ])
      expect(result.startedAt).toBe(1234)
    },
    30_000,
  )
})

describe('hosted probe selection wiring', () => {
  const read = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url)).text()

  test('the route probes through the selected runner and in-process only without one', async () => {
    const route = await read('routes/mcps.ts')
    expect(route).toContain('module.probe === undefined')
    expect(route).toContain('await module.probe(start.captured, { startedAt: start.startedAt })')
  })

  test('the PostgreSQL daemon hands the diagnostics runner to the routes; only hosted selects one', async () => {
    expect(await read('cli/postgresqlDaemonApplication.ts')).toContain(
      'probe: mcpRuntimeTests.probe,',
    )
    expect(await read('modules/resource-catalog/composition/mcpDiagnostics.ts')).toContain(
      'probe: undefined as McpProbeRunner | undefined,',
    )
    expect(
      await read('modules/resource-catalog/composition/crewstationMcpDiagnostics.ts'),
    ).toContain('probe: createHostedMcpProbe({ helper: input.helper }),')
  })
})
