// RFC-437 — 代码平台 Webhook 家族归入 integration（RFC-294 W4 B / D 第三步）。
//
// 锁四件事：
// ① 位置：16 个原文件与 `services/webhook/` 目录不再存在，19 个新文件就位；四个绑定只依赖本模块与传输工具，
//    迁入的文件都不 import legacy `services/`。
// ② 入站接收用例（自 routes/webhooks.ts 抽出）：每个结果分支、判定顺序（未知适配器仍计未匹配额度、
//    限流先于读正文、读正文先于解封密钥）与落库的投递状态；绑定把每个结果映射回原状态码与响应体。
// ③ 投递重放用例（自 routes/webhookDeliveries.ts 抽出）：每条错误码、三种标记结论、终态唤醒、
//    通知失败被吞、重放事件不带去重 UUID、重放链指回根投递。
// ④ 重放可用性：缺事件中心或分发器不支持事件中心投递时 composition 不构造用例，绑定先于读投递报 409；
//    生产应用里重放已接线，Webhook 管理面路由的元数据不变。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { Hono, type Context } from 'hono'

import { buildActor } from '@/auth/actor'
import type { EventCenterModule } from '@/modules/event-center/composition'
import type { AcceptedVerifiedDelivery } from '@/modules/integration/application/acceptVerifiedWebhookDelivery'
import type { VerifiedWebhookDeliveryInput } from '@/modules/integration/application/acceptVerifiedWebhookDelivery'
import type { WebhookDeliveryInsertInput } from '@/modules/integration/application/ports/webhookDeliveryPersistence'
import type { WebhookDeliveryRecord } from '@/modules/integration/application/ports/webhookDeliveryQueries'
import type { WebhookDeliveryRuntime } from '@/modules/integration/application/ports/webhookDeliveryRuntime'
import type { WebhookDispatcher } from '@/modules/integration/application/ports/webhookDispatcher'
import type { WebhookEndpointRecord } from '@/modules/integration/application/ports/webhookEndpointAdministration'
import type { WebhookIngressPersistence } from '@/modules/integration/application/ports/webhookIngressPersistence'
import {
  createCodeHostWebhookReceiver,
  WEBHOOK_BODY_MAX_BYTES,
  type CodeHostWebhookOutcome,
  type CodeHostWebhookRequest,
} from '@/modules/integration/application/receiveCodeHostWebhook'
import { createWebhookDeliveryReplay } from '@/modules/integration/application/replayWebhookDelivery'
import {
  SlidingWindowLimiter,
  type WebhookRateLimiters,
} from '@/modules/integration/application/webhookRateLimiter'
import {
  composeWebhookDeliveryReplay,
  composeWebhookIngressTransport,
} from '@/modules/integration/composition/webhookIngress'
import { mountWebhookDeliveryRoutes } from '@/modules/integration/inbound/http/webhookDeliveryRoutes'
import { mountWebhookIngressRoutes } from '@/modules/integration/inbound/http/webhookIngressRoutes'
import { lookupRouteMeta } from '@/routes/registry'
import { errorHandler } from '@/util/errors'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createSession } from './helpers/auth/sessionStore'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'
import { createUser } from './helpers/userFixture'

const SRC = resolve(import.meta.dir, '..', 'src')
const INTEGRATION = join(SRC, 'modules', 'integration')

const OLD_FILES = [
  'services/webhook/codeHostAdapter.ts',
  'services/webhook/githubAdapter.ts',
  'services/webhook/gitlabAdapter.ts',
  'services/webhook/matching.ts',
  'services/webhook/triggerValidation.ts',
  'services/webhook/dispatcherTypes.ts',
  'services/webhook/webhookDispatch.ts',
  'services/webhook/deliveryStore.ts',
  'services/webhook/rateLimiter.ts',
  'services/webhook/terminalWorkspaceCleanup.ts',
  'services/webhookEndpoints.ts',
  'services/webhookTriggers.ts',
  'routes/webhooks.ts',
  'routes/webhookDeliveries.ts',
  'routes/webhookEndpoints.ts',
  'routes/webhookTriggers.ts',
] as const

const NEW_FILES = [
  'domain/codeHostAdapters.ts',
  'domain/githubWebhookAdapter.ts',
  'domain/gitlabWebhookAdapter.ts',
  'domain/webhookTriggerMatching.ts',
  'domain/webhookTriggerValidation.ts',
  'application/ports/webhookDispatcher.ts',
  'application/ports/webhookDeliveryRuntime.ts',
  'application/webhookDispatch.ts',
  'application/webhookDeliveryStore.ts',
  'application/webhookRateLimiter.ts',
  'application/terminalWorkspaceCleanup.ts',
  'application/webhookEndpoints.ts',
  'application/webhookTriggers.ts',
  'application/receiveCodeHostWebhook.ts',
  'application/replayWebhookDelivery.ts',
  'inbound/http/webhookIngressRoutes.ts',
  'inbound/http/webhookDeliveryRoutes.ts',
  'inbound/http/webhookEndpointRoutes.ts',
  'inbound/http/webhookTriggerRoutes.ts',
] as const

function specifiers(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
  )) {
    out.push(match[1]!)
  }
  for (const match of text.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push(match[1]!)
  }
  return out
}

function moduleFile(path: string): string {
  return readFileSync(join(INTEGRATION, path), 'utf8')
}

describe('RFC-437 —— Webhook 家族的位置与依赖', () => {
  test('16 个原文件不再存在、services/webhook/ 下没有源码，19 个新文件就位', () => {
    expect(OLD_FILES.filter((path) => existsSync(join(SRC, path)))).toEqual([])
    // 目录本身是否残留取决于检出方式（git 不跟踪空目录）；断言的是其中不再有任何源码。
    const legacyDir = join(SRC, 'services', 'webhook')
    expect(
      existsSync(legacyDir) ? readdirSync(legacyDir).filter((name) => name.endsWith('.ts')) : [],
    ).toEqual([])
    expect(NEW_FILES.filter((path) => !existsSync(join(INTEGRATION, path)))).toEqual([])
  })

  test('四个绑定只 import 本模块 application 与传输工具，不 import legacy services/', () => {
    const offenders: string[] = []
    for (const path of NEW_FILES.filter((file) => file.startsWith('inbound/http/'))) {
      for (const specifier of specifiers(moduleFile(path))) {
        const allowed =
          (specifier.startsWith('.') && specifier.startsWith('../../application/')) ||
          /^@\/modules\/(?:task-execution|identity-access)\/public\/[a-z]+$/.test(specifier) ||
          /^@\/(?:auth\/actor|routes\/registry|routes\/operationAuthority|util\/[A-Za-z]+)$/.test(
            specifier,
          ) ||
          /^(?:hono|zod|@agent-workflow\/shared)$/.test(specifier)
        if (!allowed) offenders.push(`${path} -> ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('迁入的 19 个文件都不 import legacy services/ 与其他 context 的内部', () => {
    const offenders: string[] = []
    for (const path of NEW_FILES) {
      for (const specifier of specifiers(moduleFile(path))) {
        if (specifier.startsWith('@/services/')) offenders.push(`${path} -> ${specifier}`)
        const other = /^@\/modules\/([a-z-]+)\/(.+)$/.exec(specifier)
        if (other && other[1] !== 'integration' && !other[2]!.startsWith('public/')) {
          offenders.push(`${path} -> ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('public/commands 只剩维护命令；入站命令与持久化类型留在本模块端口', () => {
    const commands = moduleFile('public/commands.ts')
    expect(commands).toContain('export interface IntegrationMaintenanceCommands')
    expect(commands).not.toContain('VerifiedWebhookIngressCommands')
    expect(commands).not.toContain('WebhookIngressPersistence')
    expect(moduleFile('application/ports/verifiedWebhookIngress.ts')).toContain(
      'export interface VerifiedWebhookIngressCommands',
    )
  })

  test('重放绑定先判可用性再读投递；server.ts 经 integration composition 挂载四个绑定', () => {
    const binding = moduleFile('inbound/http/webhookDeliveryRoutes.ts')
    const unavailable = binding.indexOf("'webhook-ingress-unavailable'")
    expect(unavailable).toBeGreaterThan(-1)
    expect(unavailable).toBeLessThan(binding.indexOf('replay.replay('))
    expect(binding).not.toContain('EventCenterModule')
    expect(binding).not.toContain('WebhookDispatcher')
    const server = readFileSync(join(SRC, 'server.ts'), 'utf8')
    expect(server).toMatch(
      /import \{\n(?: {2}mount\w+Routes,\n)* {2}mountWebhookDeliveryRoutes,\n {2}mountWebhookEndpointRoutes,\n {2}mountWebhookIngressRoutes,\n {2}mountWebhookTriggerRoutes,\n\} from '@\/modules\/integration\/composition'/,
    )
    expect(server).not.toMatch(/from '@\/routes\/webhook/)
  })

  test('扫描确实覆盖到 integration 语料（扫空即假绿）', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? walk(path) : name.endsWith('.ts') ? [path] : []
      })
    const files = walk(INTEGRATION).map((file) => relative(INTEGRATION, file))
    expect(files.length).toBeGreaterThan(60)
    for (const path of NEW_FILES) expect(files).toContain(path)
  })
})

// ---------------------------------------------------------------------------
// ② 入站接收用例
// ---------------------------------------------------------------------------

const SECRET = 'S3CRET-token'
const PUSH_BODY = JSON.stringify({
  object_kind: 'push',
  ref: 'refs/heads/feature/x',
  after: 'abc123',
  user_username: 'dev-a',
  project: {
    path_with_namespace: 'platform/api',
    git_http_url: 'https://gitlab.example.com/platform/api.git',
    git_ssh_url: 'git@gitlab.example.com:platform/api.git',
  },
})
const UNSUPPORTED_MR_BODY = JSON.stringify({
  object_kind: 'merge_request',
  event_type: 'merge_request',
  user: { username: 'u' },
  project: {
    id: 77,
    path_with_namespace: 'g/r',
    git_http_url: 'https://gl.example.com/g/r.git',
    git_ssh_url: 'git@gl.example.com:g/r.git',
  },
  object_attributes: {
    iid: 9,
    state: 'opened',
    action: 'approved',
    source_branch: 'feature',
    target_branch: 'main',
  },
})
const TERMINAL_MR_BODY = JSON.stringify({
  object_kind: 'merge_request',
  event_type: 'merge_request',
  user: { username: 'u' },
  project: {
    id: 77,
    path_with_namespace: 'g/r',
    git_http_url: 'https://gl.example.com/g/r.git',
    git_ssh_url: 'git@gl.example.com:g/r.git',
  },
  object_attributes: {
    iid: 9,
    state: 'closed',
    action: 'close',
    source_branch: 'feature',
    target_branch: 'main',
  },
})

function endpointRecord(overrides: Partial<WebhookEndpointRecord> = {}): WebhookEndpointRecord {
  return {
    id: 'ep-1',
    name: 'gitlab',
    provider: 'gitlab',
    urlToken: 'aw_whk_tok',
    secretEnc: 'sealed-secret',
    enabled: true,
    preferredCloneProtocol: 'https',
    lastDeliveryAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as WebhookEndpointRecord
}

function limiters(perEndpoint = 1_000, unmatched = 1_000): WebhookRateLimiters {
  return {
    perEndpoint: new SlidingWindowLimiter(perEndpoint, 60_000, () => 0),
    unmatched: new SlidingWindowLimiter(unmatched, 60_000, () => 0),
  }
}

function receiverFixture(
  opts: {
    readonly endpoint?: WebhookEndpointRecord | null
    readonly limiters?: WebhookRateLimiters
    readonly unsealThrows?: boolean
  } = {},
) {
  const endpoint = opts.endpoint === undefined ? endpointRecord() : opts.endpoint
  const inserts: WebhookDeliveryInsertInput[] = []
  const received: VerifiedWebhookDeliveryInput[] = []
  const unsealed: string[] = []
  const persistence = {
    endpoints: {
      get: async () => endpoint,
      getByUrlToken: async (token: string) =>
        endpoint !== null && endpoint.urlToken === token ? endpoint : null,
    },
    deliveries: {
      insert: async (input: WebhookDeliveryInsertInput) => {
        inserts.push(input)
        return { kind: 'inserted' as const, deliveryId: `d-${inserts.length}` }
      },
    },
    acceptVerifiedDelivery: async () => {
      throw new Error('the receiver accepts only through the verified ingress')
    },
  } as unknown as WebhookIngressPersistence
  const lim = opts.limiters ?? limiters()
  const receiver = createCodeHostWebhookReceiver({
    persistence,
    unseal: (secretEnc) => {
      unsealed.push(secretEnc)
      if (opts.unsealThrows === true) throw new Error('secret key rotated')
      return SECRET
    },
    verifiedIngress: {
      async receive(input) {
        received.push(input)
        return { deliveryId: 'v-1', status: 'received' }
      },
    },
    limiters: lim,
  })
  let reads = 0
  const send = (input: {
    readonly provider?: string
    readonly urlToken?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string | null
  }): Promise<CodeHostWebhookOutcome> => {
    const request: CodeHostWebhookRequest = {
      provider: input.provider ?? 'gitlab',
      urlToken: input.urlToken ?? 'aw_whk_tok',
      header: (name) => input.headers?.[name],
      readBody: async (limitBytes) => {
        reads++
        expect(limitBytes).toBe(WEBHOOK_BODY_MAX_BYTES)
        if (input.body === null) return null
        const text = input.body ?? PUSH_BODY
        return { bytes: Buffer.from(text, 'utf8'), text }
      },
    }
    return receiver.receive(request)
  }
  return { send, inserts, received, unsealed, limiters: lim, reads: () => reads }
}

const VALID_HEADERS = {
  'x-gitlab-token': SECRET,
  'x-gitlab-event-uuid': 'uuid-1',
  'x-gitlab-event': 'Push Hook',
} as const

describe('RFC-437 —— 入站接收用例的分支与顺序', () => {
  test('未知 provider：not-found，仍计一次未匹配额度，不读正文', async () => {
    const fx = receiverFixture({ limiters: limiters(1_000, 1) })
    expect(await fx.send({ provider: 'bitbucket' })).toEqual({ kind: 'not-found' })
    expect(fx.limiters.unmatched.allow('global')).toBe(false)
    expect(fx.reads()).toBe(0)
    expect(fx.inserts).toEqual([])
  })

  test('未知 URL token：额度在时 not-found，额度用尽后 rate-limited', async () => {
    const fx = receiverFixture({ limiters: limiters(1_000, 1) })
    expect(await fx.send({ urlToken: 'aw_whk_nope' })).toEqual({ kind: 'not-found' })
    expect(await fx.send({ urlToken: 'aw_whk_nope' })).toEqual({ kind: 'rate-limited' })
    expect(fx.reads()).toBe(0)
  })

  test('端点 provider 与路径不符按未匹配处理', async () => {
    const fx = receiverFixture({ endpoint: endpointRecord({ provider: 'github' }) })
    expect(await fx.send({ provider: 'gitlab' })).toEqual({ kind: 'not-found' })
    expect(fx.reads()).toBe(0)
  })

  test('每端点额度先于读正文判定', async () => {
    const fx = receiverFixture({ limiters: limiters(0, 1_000) })
    expect(await fx.send({ headers: VALID_HEADERS })).toEqual({ kind: 'rate-limited' })
    expect(fx.reads()).toBe(0)
    expect(fx.unsealed).toEqual([])
  })

  test('正文超限：payload-too-large，先于解封，不落库', async () => {
    const fx = receiverFixture()
    expect(await fx.send({ headers: VALID_HEADERS, body: null })).toEqual({
      kind: 'payload-too-large',
    })
    expect(fx.reads()).toBe(1)
    expect(fx.unsealed).toEqual([])
    expect(fx.inserts).toEqual([])
  })

  test('密钥解封失败：internal-error，不落库', async () => {
    const fx = receiverFixture({ unsealThrows: true })
    expect(await fx.send({ headers: VALID_HEADERS })).toEqual({ kind: 'internal-error' })
    expect(fx.unsealed).toEqual(['sealed-secret'])
    expect(fx.inserts).toEqual([])
  })

  test('验签失败：signature-rejected，落 rejected 投递（错 token / 缺 token 各自原因）', async () => {
    const wrong = receiverFixture()
    expect(await wrong.send({ headers: { ...VALID_HEADERS, 'x-gitlab-token': 'nope' } })).toEqual({
      kind: 'signature-rejected',
    })
    expect(wrong.inserts).toEqual([
      {
        endpointId: 'ep-1',
        eventUuid: 'uuid-1',
        gitlabEventHeader: 'Push Hook',
        bodyJson: PUSH_BODY,
        status: 'rejected',
        statusReason: 'invalid-token',
      },
    ])
    const missing = receiverFixture()
    expect(
      await missing.send({
        headers: { 'x-gitlab-event-uuid': 'uuid-2', 'x-gitlab-event': 'Push Hook' },
      }),
    ).toEqual({ kind: 'signature-rejected' })
    expect(missing.inserts[0]?.statusReason).toBe('missing-token')
  })

  test('非 JSON 正文：invalid-json，落 ignored / parse-failed；空正文同样', async () => {
    for (const body of ['payload=urlencoded', '']) {
      const fx = receiverFixture()
      expect(await fx.send({ headers: VALID_HEADERS, body })).toEqual({ kind: 'invalid-json' })
      expect(fx.inserts).toEqual([
        {
          endpointId: 'ep-1',
          eventUuid: 'uuid-1',
          gitlabEventHeader: 'Push Hook',
          bodyJson: body,
          status: 'ignored',
          statusReason: 'parse-failed',
        },
      ])
    }
  })

  test('平台不处理的合法投递：ignored 带投递 id（unsupported-event 与 parse-failed 两种原因）', async () => {
    const unsupported = receiverFixture()
    expect(await unsupported.send({ headers: VALID_HEADERS, body: UNSUPPORTED_MR_BODY })).toEqual({
      kind: 'ignored',
      deliveryId: 'd-1',
    })
    expect(unsupported.inserts[0]).toMatchObject({
      objectKind: 'merge_request',
      status: 'ignored',
      statusReason: 'unsupported-event',
    })
    const malformed = receiverFixture()
    expect(
      await malformed.send({ headers: VALID_HEADERS, body: JSON.stringify({ project: {} }) }),
    ).toEqual({ kind: 'ignored', deliveryId: 'd-1' })
    expect(malformed.inserts[0]).toMatchObject({ status: 'ignored', statusReason: 'parse-failed' })
  })

  test('停用端点：ignored / endpoint-disabled，带事件摘要', async () => {
    const fx = receiverFixture({ endpoint: endpointRecord({ enabled: false }) })
    expect(await fx.send({ headers: VALID_HEADERS })).toEqual({
      kind: 'ignored',
      deliveryId: 'd-1',
    })
    expect(fx.inserts[0]).toMatchObject({
      endpointId: 'ep-1',
      objectKind: 'push',
      eventType: 'push',
      repoPath: 'platform/api',
      status: 'ignored',
      statusReason: 'endpoint-disabled',
    })
    expect(typeof fx.inserts[0]?.streamHint).toBe('string')
    expect(fx.received).toEqual([])
  })

  test('验签通过的投递交给已验证接收，结果原样返回', async () => {
    const fx = receiverFixture()
    expect(await fx.send({ headers: VALID_HEADERS })).toEqual({
      kind: 'accepted',
      receipt: { deliveryId: 'v-1', status: 'received' },
    })
    expect(fx.inserts).toEqual([])
    expect(fx.received).toHaveLength(1)
    expect(fx.received[0]).toMatchObject({
      endpointId: 'ep-1',
      rawBodyText: PUSH_BODY,
      eventHeader: 'Push Hook',
      objectKind: 'push',
    })
    expect(fx.received[0]?.event.eventType).toBe('push')
  })
})

describe('RFC-437 —— 入站绑定的结果映射', () => {
  const cases: ReadonlyArray<readonly [CodeHostWebhookOutcome, number, unknown]> = [
    [{ kind: 'not-found' }, 404, { error: 'not-found' }],
    [{ kind: 'rate-limited' }, 429, { error: 'rate-limited' }],
    [{ kind: 'payload-too-large' }, 413, { error: 'payload-too-large' }],
    [{ kind: 'internal-error' }, 500, { error: 'internal-error' }],
    [{ kind: 'signature-rejected' }, 401, { error: 'signature-rejected' }],
    [{ kind: 'invalid-json' }, 400, { error: 'invalid-json' }],
    [{ kind: 'ignored', deliveryId: 'd-9' }, 200, { deliveryId: 'd-9', status: 'ignored' }],
    [
      { kind: 'accepted', receipt: { deliveryId: 'v-2', status: 'duplicate', attemptCount: 2 } },
      200,
      { deliveryId: 'v-2', status: 'duplicate', attemptCount: 2 },
    ],
  ]
  for (const [outcome, status, body] of cases) {
    test(`${outcome.kind} → ${status}`, async () => {
      const app = new Hono()
      app.onError(errorHandler)
      let seen: CodeHostWebhookRequest | null = null
      mountWebhookIngressRoutes(app, {
        receiver: {
          async receive(request) {
            seen = request
            return outcome
          },
        },
      })
      const res = await app.request('/webhooks/gitlab/aw_whk_tok', {
        method: 'POST',
        body: '{"k":1}',
        headers: { 'X-GitLab-Token': 'abc' },
      })
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual(body)
      const request = seen as CodeHostWebhookRequest | null
      expect(request?.provider).toBe('gitlab')
      expect(request?.urlToken).toBe('aw_whk_tok')
      expect(request?.header('x-gitlab-token')).toBe('abc')
    })
  }

  test('流式读正文：超限为 null，未超限返回字节与文本', async () => {
    const app = new Hono()
    const results: unknown[] = []
    let limit = 4
    mountWebhookIngressRoutes(app, {
      receiver: {
        async receive(request) {
          results.push(await request.readBody(limit))
          return { kind: 'not-found' }
        },
      },
    })
    await app.request('/webhooks/gitlab/t', { method: 'POST', body: 'hello' })
    limit = 1_000
    await app.request('/webhooks/gitlab/t', { method: 'POST', body: 'hello' })
    expect(results[0]).toBeNull()
    const body = results[1] as { readonly bytes: Uint8Array; readonly text: string }
    expect(body.text).toBe('hello')
    expect(Buffer.from(body.bytes).toString('utf8')).toBe('hello')
  })

  test('没有接收器时不挂载入站面', async () => {
    const app = new Hono()
    mountWebhookIngressRoutes(app, {})
    const res = await app.request('/webhooks/gitlab/aw_whk_tok', { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('"error"')
  })

  test('装配：缺密钥箱或已验证接收时不构造接收器', () => {
    const persistence = {} as unknown as WebhookIngressPersistence
    expect(
      composeWebhookIngressTransport({ webhookIngressPersistence: persistence }).receiver,
    ).toBe(undefined)
  })
})

// ---------------------------------------------------------------------------
// ③ 投递重放用例
// ---------------------------------------------------------------------------

function deliveryRow(overrides: Partial<WebhookDeliveryRecord> = {}): WebhookDeliveryRecord {
  return {
    id: 'd-1',
    endpointId: 'ep-1',
    eventUuid: 'uuid-1',
    attemptCount: 1,
    gitlabEventHeader: 'Push Hook',
    objectKind: 'push',
    eventType: 'push',
    repoPath: 'platform/api',
    streamHint: null,
    mrFactKey: null,
    mrStreamKey: null,
    mrStreamRevision: null,
    mrStateAfter: null,
    status: 'matched',
    statusReason: null,
    replayedFromDeliveryId: null,
    receivedAt: 0,
    bodyJson: PUSH_BODY,
    ...overrides,
  }
}

function replayFixture(
  opts: {
    readonly rows?: readonly WebhookDeliveryRecord[]
    readonly endpoint?: WebhookEndpointRecord | null
    readonly terminalEffect?: boolean
    readonly accept?: AcceptedVerifiedDelivery
    readonly published?: { readonly deliveryCount: number; readonly deliveryIds: readonly string[] }
    readonly notifyRejects?: boolean
  } = {},
) {
  const rows = new Map((opts.rows ?? [deliveryRow()]).map((row) => [row.id, row]))
  const endpoint = opts.endpoint === undefined ? endpointRecord() : opts.endpoint
  const accepted: VerifiedWebhookDeliveryInput[] = []
  const marks: unknown[] = []
  const woken: (string | null)[] = []
  const notified: string[] = []
  const observedAt: number[] = []
  const runtime = {
    queries: {
      get: async (id: string) => rows.get(id) ?? null,
      hasTerminalControlEffect: async () => opts.terminalEffect === true,
    },
    endpoints: { get: async () => endpoint },
    acceptVerifiedDelivery: async (input: VerifiedWebhookDeliveryInput) => {
      accepted.push(input)
      return (
        opts.accept ?? {
          kind: 'inserted',
          deliveryId: 'r-1',
          effectId: null,
          controlAccepted: false,
          streamRevision: null,
        }
      )
    },
    deliveries: {
      mark: async (input: unknown) => {
        marks.push(input)
      },
    },
  } as unknown as WebhookDeliveryRuntime
  const replay = createWebhookDeliveryReplay({
    runtime,
    events: {
      async observe(observation) {
        // One code-host event yields several observations; only the first reaches subscribers here,
        // so each event delivery id is published once (the use case concatenates every receipt).
        observedAt.push(observation.occurredAt)
        return observedAt.length === 1 && opts.published !== undefined
          ? opts.published
          : { deliveryCount: 0, deliveryIds: [] }
      },
      async notify(deliveryId) {
        notified.push(deliveryId)
        if (opts.notifyRejects === true) throw new Error('notification worker down')
        return 'idle'
      },
    },
    wakeTerminalControl: (effectId) => {
      woken.push(effectId)
    },
    now: () => 1_700_000_000_000,
  })
  return { replay, accepted, marks, woken, notified, observedAt }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  }
}

describe('RFC-437 —— 投递重放用例', () => {
  test('每条拒绝路径的错误码与原路由相同', async () => {
    const reject = async (opts: Parameters<typeof replayFixture>[0], id = 'd-1'): Promise<string> =>
      await codeOf(replayFixture(opts).replay.replay(id))
    expect(await reject({ rows: [] })).toBe('webhook-delivery-not-found')
    expect(await reject({ rows: [deliveryRow({ status: 'rejected' })] })).toBe(
      'webhook-delivery-rejected-not-replayable',
    )
    for (const status of ['received', 'processing'] as const) {
      expect(await reject({ rows: [deliveryRow({ status })] })).toBe('webhook-delivery-in-flight')
    }
    for (const bodyJson of [null, '']) {
      expect(await reject({ rows: [deliveryRow({ bodyJson })] })).toBe('webhook-delivery-body-gone')
    }
    expect(await reject({ endpoint: null })).toBe('webhook-endpoint-not-found')
    expect(await reject({ endpoint: endpointRecord({ provider: 'bitbucket' as never }) })).toBe(
      'webhook-provider-unknown',
    )
    expect(await reject({ rows: [deliveryRow({ bodyJson: 'not json' })] })).toBe(
      'webhook-delivery-body-invalid',
    )
    expect(await reject({ rows: [deliveryRow({ bodyJson: UNSUPPORTED_MR_BODY })] })).toBe(
      'webhook-delivery-unsupported',
    )
    expect(await reject({ rows: [deliveryRow({ replayedFromDeliveryId: 'gone' })] })).toBe(
      'webhook-delivery-replay-lineage-broken',
    )
    const terminal = deliveryRow({
      gitlabEventHeader: 'Merge Request Hook',
      objectKind: 'merge_request',
      eventType: 'mr_closed',
      bodyJson: TERMINAL_MR_BODY,
    })
    expect(await reject({ rows: [terminal] })).toBe('webhook-terminal-replay-root-unprotected')
    expect(await reject({ rows: [{ ...terminal, mrStreamRevision: 3 }] })).toBe(
      'webhook-terminal-replay-effect-missing',
    )
    expect(
      await reject({
        accept: { kind: 'duplicate', deliveryId: 'r-0', attemptCount: 2 } as never,
      }),
    ).toBe('webhook-delivery-replay-conflict')
  })

  test('有订阅者命中：matched，逐个通知，事件不带去重 UUID，重放指回根投递', async () => {
    const fx = replayFixture({ published: { deliveryCount: 2, deliveryIds: ['e-1', 'e-2'] } })
    expect(await fx.replay.replay('d-1')).toEqual({
      deliveryId: 'r-1',
      replayedFrom: 'd-1',
      status: 'received',
    })
    expect(fx.accepted).toHaveLength(1)
    expect(fx.accepted[0]?.event.eventUuid).toBeNull()
    expect(fx.accepted[0]?.replay).toEqual({ rootDeliveryId: 'd-1', terminalRootRevision: null })
    expect(fx.accepted[0]?.rawBodyText).toBe(PUSH_BODY)
    expect(fx.marks).toEqual([{ deliveryId: 'r-1', status: 'matched' }])
    expect(fx.notified).toEqual(['e-1', 'e-2'])
    expect(fx.woken).toEqual([null])
    expect(fx.observedAt.every((at) => at === 1_700_000_000_000)).toBe(true)
  })

  test('无订阅者而终态控制已受理：matched / terminal-control-accepted，并唤醒控制效果', async () => {
    const terminal = deliveryRow({
      gitlabEventHeader: 'Merge Request Hook',
      objectKind: 'merge_request',
      eventType: 'mr_closed',
      bodyJson: TERMINAL_MR_BODY,
      mrStreamRevision: 5,
    })
    const fx = replayFixture({
      rows: [terminal],
      terminalEffect: true,
      accept: {
        kind: 'inserted',
        deliveryId: 'r-1',
        effectId: 'fx-1',
        controlAccepted: true,
        streamRevision: 6,
      },
    })
    await fx.replay.replay('d-1')
    expect(fx.accepted[0]?.replay).toEqual({ rootDeliveryId: 'd-1', terminalRootRevision: 5 })
    expect(fx.woken).toEqual(['fx-1'])
    expect(fx.marks).toEqual([
      { deliveryId: 'r-1', status: 'matched', reason: 'terminal-control-accepted' },
    ])
  })

  test('无订阅者也无控制效果：ignored / no-trigger-matched', async () => {
    const fx = replayFixture()
    await fx.replay.replay('d-1')
    expect(fx.marks).toEqual([
      { deliveryId: 'r-1', status: 'ignored', reason: 'no-trigger-matched' },
    ])
    expect(fx.notified).toEqual([])
  })

  test('重放的重放指回同一根投递；通知失败被吞掉', async () => {
    const fx = replayFixture({
      rows: [deliveryRow(), deliveryRow({ id: 'd-2', replayedFromDeliveryId: 'd-1' })],
      published: { deliveryCount: 1, deliveryIds: ['e-1'] },
      notifyRejects: true,
    })
    expect(await fx.replay.replay('d-2')).toEqual({
      deliveryId: 'r-1',
      replayedFrom: 'd-2',
      status: 'received',
    })
    expect(fx.accepted[0]?.replay).toEqual({ rootDeliveryId: 'd-1', terminalRootRevision: null })
    expect(fx.notified).toEqual(['e-1'])
  })
})

// ---------------------------------------------------------------------------
// ④ 重放可用性与生产接线
// ---------------------------------------------------------------------------

const EVENT_CENTER = {
  commands: { observe: async () => ({ deliveryCount: 0, deliveryIds: [] }) },
  worker: { runOneNotification: async () => 'idle' },
  observerControl: { nudgeSource: () => false },
} as unknown as EventCenterModule
const RUNTIME = {} as unknown as WebhookDeliveryRuntime

describe('RFC-437 —— 重放可用性', () => {
  test('缺事件中心、缺分发器或分发器不支持事件中心投递：不构造重放用例', () => {
    const legacyOnly = { dispatch: async () => {} } as unknown as WebhookDispatcher
    const eventCenterCapable = {
      dispatch: async () => {},
      dispatchSubscription: async () => {},
    } as unknown as WebhookDispatcher
    expect(
      composeWebhookDeliveryReplay({
        webhookDeliveryRuntime: RUNTIME,
        webhookDispatcher: eventCenterCapable,
      }),
    ).toBeUndefined()
    expect(
      composeWebhookDeliveryReplay({
        webhookDeliveryRuntime: RUNTIME,
        digitalEmployeeEventCenter: EVENT_CENTER,
      }),
    ).toBeUndefined()
    expect(
      composeWebhookDeliveryReplay({
        webhookDeliveryRuntime: RUNTIME,
        digitalEmployeeEventCenter: EVENT_CENTER,
        webhookDispatcher: legacyOnly,
      }),
    ).toBeUndefined()
    expect(
      composeWebhookDeliveryReplay({
        webhookDeliveryRuntime: RUNTIME,
        digitalEmployeeEventCenter: EVENT_CENTER,
        webhookDispatcher: eventCenterCapable,
      }),
    ).toBeDefined()
  })

  test('不可用时绑定先于读投递报 409 webhook-ingress-unavailable', async () => {
    let reads = 0
    const runtime = {
      queries: {
        get: async () => {
          reads++
          return null
        },
      },
    } as unknown as WebhookDeliveryRuntime
    const app = new Hono()
    const admin = buildActor({
      user: {
        id: 'rfc437-admin',
        username: 'rfc437-admin',
        displayName: 'Admin',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    app.use('*', async (c: Context, next) => {
      c.set('actor', admin)
      await next()
    })
    app.onError(errorHandler)
    mountWebhookDeliveryRoutes(app, { webhookDeliveryRuntime: runtime })
    const res = await app.request('/api/webhook-deliveries/missing/replay', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code?: string }).code).toBe('webhook-ingress-unavailable')
    expect(reads).toBe(0)
  })
})

const DAEMON_TOKEN = 'c'.repeat(64)
// 与 RFC-257 的 HTTP 用例同形：显式给出支持事件中心投递的分发器，生产装配据此构造重放用例。
const SCOPE_DISPATCHER: WebhookDispatcher = {
  dispatch: async () => {},
  dispatchSubscription: async () => {},
}

async function adminSession(db: PersistenceDb, username: string): Promise<string> {
  const user = await createUser(db, {
    username,
    displayName: username,
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: user.id })
  return token
}

describeEachProviderHttpApplication(
  'RFC-437 —— 生产应用里的 Webhook 管理面',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc437-webhooks-',
    webhookDispatcher: SCOPE_DISPATCHER,
  },
  (scope: ProviderHttpApplicationScope) => {
    test('重放已接线（缺失投递答 404 而非 409），路由元数据不变', async () => {
      const app = (await scope.open()).app
      const token = await adminSession(scope.harness.db, 'rfc437-admin')
      const headers = { Authorization: `Bearer ${token}` }
      const replay = await app.request('/api/webhook-deliveries/rfc437-missing/replay', {
        method: 'POST',
        headers,
      })
      expect(replay.status).toBe(404)
      expect(((await replay.json()) as { code?: string }).code).toBe('webhook-delivery-not-found')
      const detail = await app.request('/api/webhook-deliveries/rfc437-missing', { headers })
      expect(detail.status).toBe(404)
      expect(((await detail.json()) as { code?: string }).code).toBe('webhook-delivery-not-found')

      expect(lookupRouteMeta('GET', '/api/webhook-deliveries')).toMatchObject({
        permissions: ['webhook-endpoints:read'],
        tokenAccess: 'allow',
      })
      expect(lookupRouteMeta('POST', '/api/webhook-deliveries/:id/replay')).toMatchObject({
        permissions: ['webhook-endpoints:manage'],
        tokenAccess: 'never',
      })
      expect(lookupRouteMeta('POST', '/api/webhook-endpoints')).toMatchObject({
        permissions: ['webhook-endpoints:manage'],
        tokenAccess: 'never',
      })
      expect(lookupRouteMeta('GET', '/api/webhook-triggers')).toMatchObject({
        permissions: ['event-automation-rules:read'],
        tokenAccess: 'allow',
      })
      expect(lookupRouteMeta('POST', '/api/webhook-triggers')).toMatchObject({
        permissions: ['event-automation-rules:create', 'tasks:execute'],
        tokenAccess: 'allow',
      })
      const ingress = lookupRouteMeta('POST', '/webhooks/:provider/:urlToken')
      expect(ingress?.permissions).toEqual([])
      expect(ingress?.tokenAccess).toBe('allow')
      expect(ingress?.publicReason?.startsWith('code-host webhook ingress;')).toBe(true)
      const anonymous = await app.request('/api/webhook-deliveries/rfc437-missing/replay', {
        method: 'POST',
      })
      expect(anonymous.status).toBe(401)
    })
  },
)
