// RFC-329 PR-A —— 四条「工具存在但走不通」的死路径（proposal §2.1 A1–A4，AC-1…AC-4）。
//
// 这四条的共同形态是**工具表在撒谎**：路径指向一条不存在的路由、描述把调用方指向一个
// 拿不到必需参数的地方、状态码写错。它们都不会让任何测试变红——工具照样出现在
// `tools/list` 里，`describe_resource` 照样宣称支持——所以全都活到了 2026-08-26 的审计。
//
// 每条断言都从**源码两侧各取一次**再比对（而不是把期望值抄成字面量）：
// 状态码取 `new ConflictError(...).status`，路由集合取 `allRouteMeta()`。抄字面量的断言
// 会跟着被它保护的代码一起漂。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { ALL_TOOLS, describeResource, type McpToolContext } from '@/mcp/tools'
import { MCP_OPERATIONS } from '@/mcp/operationBindings'
import type { RepositoryWorkspaceStore } from '@/modules/source-control/public/operations'
import { allRouteMeta, resetRouteMetaRegistry } from '@/routes/registry'
import { mountCachedRepoRoutes } from '@/routes/cached-repos'
import type { AppDeps } from '@/server'
import { ConflictError } from '@/util/errors'
import {
  recordingOperationHandles,
  type RecordedOperationCall,
} from './helpers/mcpOperationRecording'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

function toolNamed(name: string) {
  const tool = ALL_TOOLS.find((t) => t.name === name)
  if (tool === undefined) throw new Error(`tool '${name}' not found`)
  return tool
}

/** Records what a handler dispatches; `respond` fakes the route's answer. */
function recordingCtx(
  toolName: string,
  respond: (path: string) => unknown = () => ({}),
): {
  ctx: McpToolContext
  calls: RecordedOperationCall[]
} {
  const calls: RecordedOperationCall[] = []
  const ctx: McpToolContext = {
    actor: {} as McpToolContext['actor'],
    operations: recordingOperationHandles(toolName, calls, (call) => respond(call.path)),
    progress: async () => {},
    signal: new AbortController().signal,
  }
  return { ctx, calls }
}

describe('RFC-329 AC-1 — repos has no single-repo read, and the table no longer claims one', () => {
  test('`GET /api/cached-repos/:id` is not a mounted route (the premise of the whole finding)', () => {
    resetRouteMetaRegistry()
    mountCachedRepoRoutes(
      new Hono(),
      { db: {} as AppDeps['db'], configPath: '' } as AppDeps,
      {} as RepositoryWorkspaceStore,
    )
    const mounted = allRouteMeta().map((m) => `${m.method} ${m.path}`)
    resetRouteMetaRegistry()
    // The DELETE on the same template exists; the GET never did. That asymmetry
    // is exactly what made the bogus entry look plausible.
    expect(mounted).toContain('DELETE /api/cached-repos/:id')
    expect(mounted).not.toContain('GET /api/cached-repos/:id')
  })

  test('describe_resource(repos) reports no `get` operation', () => {
    const described = describeResource('repos')
    const ops = described.operations.map((o) => o.operation)
    expect(ops).not.toContain('get')
    // The list is still there — the fix removed a phantom, not a capability.
    expect(ops).toContain('list')
    expect(ops).toContain('delete')
  })

  test('every path describe_resource(repos) advertises is a real mounted route', () => {
    resetRouteMetaRegistry()
    mountCachedRepoRoutes(
      new Hono(),
      { db: {} as AppDeps['db'], configPath: '' } as AppDeps,
      {} as RepositoryWorkspaceStore,
    )
    const mounted = new Set(allRouteMeta().map((m) => `${m.method} ${m.path}`))
    resetRouteMetaRegistry()
    const advertised = describeResource('repos').operations.map((o) => `${o.method} ${o.path}`)
    expect(advertised.filter((p) => !mounted.has(p))).toEqual([])
  })

  test('the note tells the caller where `confirm` comes from, now that there is no get', () => {
    const note = describeResource('repos').note ?? ''
    expect(note).toContain('no single-repo read')
    expect(note).toContain('urlRedacted')
  })
})

describe('RFC-329 AC-2 — the alert loop is closed on this channel', () => {
  test('list_task_alerts exists and dispatches to the alerts route', async () => {
    const { ctx, calls } = recordingCtx('list_task_alerts')
    await toolNamed('list_task_alerts').handler({ id: 'T1' }, ctx)
    expect(calls).toEqual([
      {
        operationId: MCP_OPERATIONS.taskAlertsList.id,
        method: 'GET',
        path: '/api/tasks/T1/alerts',
      },
    ])
  })

  test('repair_alert no longer sends the caller to get_task for the alertId', () => {
    const description = toolNamed('repair_alert').description
    expect(description).toContain('list_task_alerts')
    // The old text said "Call get_task first to read the alert and its options",
    // which is what made this tool unreachable: get_task carries no alerts.
    expect(description).not.toMatch(/get_task first/)
  })

  test('get_task stops promising alerts it does not carry', () => {
    const description = toolNamed('get_task').description
    expect(description).toContain('list_task_alerts')
    expect(description).not.toMatch(/and any alerts/)
  })

  test('the three tools form a closed loop: alerts → options → repair', async () => {
    const seen: string[] = []
    const calls: RecordedOperationCall[] = []
    const { ctx } = recordingCtx('list_task_alerts')
    const trace = (toolName: string): McpToolContext => ({
      ...ctx,
      operations: recordingOperationHandles(toolName, calls, (call) => {
        seen.push(`${call.method} ${call.path}`)
        return {}
      }),
    })
    await toolNamed('list_task_alerts').handler({ id: 'T1' }, trace('list_task_alerts'))
    await toolNamed('list_repair_options').handler(
      { id: 'T1', alertId: 'A1' },
      trace('list_repair_options'),
    )
    await toolNamed('repair_alert').handler(
      { id: 'T1', alertId: 'A1', optionId: 'O1', confirm: true },
      trace('repair_alert'),
    )
    expect(seen).toEqual([
      'GET /api/tasks/T1/alerts',
      'GET /api/tasks/T1/alerts/A1/repair-options',
      'POST /api/tasks/T1/alerts/A1/repair',
    ])
  })
})

describe('RFC-329 AC-3 — list_repo_refs resolves the mirror path itself', () => {
  test('two hops: list the repos, then ask for that row’s refs by path', async () => {
    const { ctx, calls } = recordingCtx('list_repo_refs', (path) =>
      path === '/api/cached-repos'
        ? {
            items: [
              { id: 'R1', localPath: '/mirrors/r1' },
              { id: 'R2', localPath: '/mirrors/r2' },
            ],
          }
        : {},
    )
    await toolNamed('list_repo_refs').handler({ cachedRepoId: 'R2' }, ctx)
    expect(calls).toEqual([
      {
        operationId: MCP_OPERATIONS.cachedReposList.id,
        method: 'GET',
        path: '/api/cached-repos',
      },
      {
        operationId: MCP_OPERATIONS.repoRefsList.id,
        method: 'GET',
        path: '/api/repos/refs',
        query: { path: '/mirrors/r2' },
      },
    ])
  })

  test('an unknown id is a business refusal shaped like a 404, not a crash', async () => {
    const { ctx, calls } = recordingCtx('list_repo_refs', (path) =>
      path === '/api/cached-repos' ? { items: [{ id: 'R1', localPath: '/mirrors/r1' }] } : {},
    )
    const err = await toolNamed('list_repo_refs')
      .handler({ cachedRepoId: 'NOPE' }, ctx)
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect((err as { name?: string })?.name).toBe('McpCallError')
    expect((err as { status?: number })?.status).toBe(404)
    expect((err as { code?: string })?.code).toBe('cached-repo-not-found')
    // It must refuse BEFORE the second hop — otherwise a bad id reaches the
    // refs route as `path=undefined`.
    expect(calls).toHaveLength(1)
  })

  test('the model is never handed the absolute mirror path as an input', () => {
    // `path` is what the REST route takes; the tool deliberately does not expose
    // it. If this ever flips, a model starts inventing filesystem paths.
    expect(Object.keys(toolNamed('list_repo_refs').inputSchema)).toEqual(['cachedRepoId'])
  })
})

describe('RFC-329 AC-4 — the clarify conflict status is 409 everywhere it is written down', () => {
  test('answer_clarify’s description carries exactly one status, and it is the real one', () => {
    const tool = toolNamed('answer_clarify')
    const text = `${tool.description} ${JSON.stringify(
      Object.values(tool.inputSchema).map((s) => (s as { description?: string }).description ?? ''),
    )}`
    const codes = [...text.matchAll(/\b([45]\d\d)\b/g)].map((m) => Number(m[1]))
    // Exactly-one + equality, not "does not contain 412": the weaker form passes
    // for a description that mentions no status at all, which is how the wrong
    // one survived in the first place.
    expect(codes).toHaveLength(1)
    expect(codes[0]).toBe(new ConflictError('x', 'y').status)
  })

  test('the shared schema comment does not disagree with the route', () => {
    // The MCP description was copied from here once already. Leaving 412 in the
    // schema is leaving the next copy loaded.
    const schema = readFileSync(
      resolve(REPO_ROOT, 'packages', 'shared', 'src', 'schemas', 'clarify.ts'),
      'utf8',
    )
    const block = schema.slice(
      schema.indexOf('export const SubmitClarifyAnswersSchema'),
      schema.indexOf('export type SubmitClarifyAnswers'),
    )
    expect(block.length).toBeGreaterThan(100)
    expect(block).not.toContain('412')
    expect(block).toContain('409')
  })
})
