import { describe, expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { DEFAULT_CONFIG, type Config, type MaintenanceStatus } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { mountMaintenanceRoutes } from '@/routes/maintenance'
import { mountPlantumlRoutes } from '@/routes/plantuml'
import { mountTaskArchiveRoutes } from '@/routes/taskArchive'
import { mountWellKnownRoutes } from '@/routes/docs'
import { publicOriginOf } from '@/routes/publicOrigin'

function app() {
  const result = new Hono()
  const actor = buildActor({
    user: {
      id: 'configuration-reader-admin',
      username: 'configuration-reader-admin',
      displayName: 'Configuration Reader Admin',
      role: 'admin',
      status: 'active',
    },
    source: 'session',
  })
  const injectActor: MiddlewareHandler = async (context, next) => {
    context.set('actor', actor)
    await next()
  }
  result.use('*', injectActor)
  return result
}

describe('RFC-370 route configuration query', () => {
  test('discovery reads the current asynchronous base URL and MCP switch', async () => {
    const http = app()
    let configured = {
      ...structuredClone(DEFAULT_CONFIG),
      publicBaseUrl: 'https://hosted.example/aw/',
      mcpSurfaceEnabled: false,
    }
    mountWellKnownRoutes(http, {
      configuration: {
        async read() {
          return structuredClone(configured)
        },
      },
    })
    const first = await http.request('/.well-known/mcp', {
      headers: { 'X-Forwarded-Host': 'forwarded.example', 'X-Forwarded-Proto': 'https' },
    })
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({
      endpoint: 'https://hosted.example/aw/api/mcp',
      documentation: 'https://hosted.example/aw/docs/api',
      enabled: false,
    })
    configured = { ...configured, publicBaseUrl: 'https://new.example', mcpSurfaceEnabled: true }
    const second = await http.request('/.well-known/mcp')
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({
      endpoint: 'https://new.example/api/mcp',
      enabled: true,
    })
  })

  test('failed asynchronous origin configuration retains request-header fallback', async () => {
    const http = new Hono()
    http.get('/origin', async (context) =>
      context.text(
        await publicOriginOf(context, {
          async read() {
            throw new Error('configuration unavailable')
          },
        }),
      ),
    )
    const response = await http.request('http://internal.example/origin', {
      headers: { 'X-Forwarded-Host': 'public.example', 'X-Forwarded-Proto': 'https' },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('https://public.example')
  })

  test('maintenance fallback reads current asynchronous configuration on every request', async () => {
    const http = app()
    let configured = structuredClone(DEFAULT_CONFIG)
    let reads = 0
    mountMaintenanceRoutes(http, {
      configuration: {
        async read() {
          reads += 1
          return structuredClone(configured)
        },
      },
    })
    const first = await http.request('/api/maintenance/status')
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({
      worker: { state: 'degraded', error: 'maintenance-service-not-composed' },
      schedule: DEFAULT_CONFIG.maintenanceSchedule,
    })
    configured = {
      ...configured,
      maintenanceSchedule: { kind: 'daily', at: '04:30', timezone: 'Asia/Shanghai' },
    }
    const second = await http.request('/api/maintenance/status')
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ schedule: configured.maintenanceSchedule })
    expect(reads).toBe(2)
  })

  test('composed maintenance status still takes precedence over the fallback reader', async () => {
    const http = app()
    const status: MaintenanceStatus = {
      version: 1,
      worker: { state: 'ready', lastHeartbeatAt: 1, error: null },
      schedule: { kind: 'hourly' },
      nextRunAt: 2,
      active: null,
      last: null,
      backlog: [],
    }
    mountMaintenanceRoutes(http, {
      configuration: {
        read() {
          throw new Error('a composed worker does not read the fallback configuration')
        },
      },
      maintenanceStatus: () => status,
    })
    const response = await http.request('/api/maintenance/status')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(status)
  })

  test('PlantUML can resolve an asynchronous unconfigured endpoint without a file path', async () => {
    const http = app()
    mountPlantumlRoutes(http, {
      configuration: {
        async read() {
          return { ...structuredClone(DEFAULT_CONFIG), plantumlEndpoint: '' }
        },
      },
    })
    const response = await http.request('/api/plantuml/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: '@startuml\nAlice -> Bob\n@enduml' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ unconfigured: true })
  })

  test('archive preview waits for configuration before choosing the retention window', async () => {
    const http = app()
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    let release!: (config: Config) => void
    const configuration = new Promise<Config>((resolve) => {
      release = resolve
    })
    const previews: number[] = []
    mountTaskArchiveRoutes(http, {
      configuration: {
        async read() {
          enter()
          return configuration
        },
      },
      taskArchiveMaintenance: {
        async preview(input) {
          previews.push(input.retentionDays)
          return []
        },
        async runSweep() {
          throw new Error('preview does not sweep')
        },
        async runManual() {
          throw new Error('preview does not archive')
        },
        async recover() {
          throw new Error('preview does not recover')
        },
      },
    })
    const pending = http.request('/api/tasks/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    try {
      await entered
      expect(previews).toEqual([])
    } finally {
      release({
        ...structuredClone(DEFAULT_CONFIG),
        taskArchive: { enabled: false, retentionDays: 42, maxTreesPerSweep: 50 },
      })
    }
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ dryRun: true, retentionDays: 42, treeCount: 0 })
    expect(previews).toEqual([42])
  })
})
