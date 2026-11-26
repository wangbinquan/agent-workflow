// RFC-602 CI follow-up: the mounted children route must also be reachable from
// the API contract registry and MCP's exact operation table. Keep each MCP call
// to one page and preserve the narrow versioned DTO and opaque continuation.
import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { TaskChildrenPageSchema, type TaskChildrenPage } from '@agent-workflow/shared'
import { ALL_TOOLS, McpCallError, type McpToolContext } from '@/mcp/tools'
import { MCP_OPERATIONS } from '@/mcp/operationBindings'
import { toInputJsonSchema } from '@/platform/operations/zodJsonSchema'
import { ENDPOINTS } from './contracts/registry'
import { buildContractHarness, reqAsAdmin } from './contracts/harness'
import { taskFixture } from './helpers/model'
import {
  forwardingOperationHandles,
  recordingOperationHandles,
  type RecordedOperationCall,
} from './helpers/mcpOperationRecording'

const tool = ALL_TOOLS.find((entry) => entry.name === 'list_task_children')!
const homes: string[] = []

// The HTTP harness disposes its application after each test, including restoring
// config.json. Remove its directory only after that registered lifetime finishes.
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

function context(operations: McpToolContext['operations']): McpToolContext {
  return {
    operations,
    get actor(): never {
      throw new Error('the children adapter must use its bound operation')
    },
    async progress() {},
    signal: new AbortController().signal,
  }
}

describe('RFC-602 task children API and MCP contracts', () => {
  test('the API registry validates the real page with the shared strict schema', () => {
    const endpoint = ENDPOINTS.find(
      (entry) => entry.method === 'GET' && entry.path === '/api/tasks/:id/children',
    )
    expect(endpoint?.happy?.schema).toBe(TaskChildrenPageSchema)
    expect(endpoint?.happy?.pathParams).toBeFunction()
    const schema = endpoint!.happy!.schema!
    const page: TaskChildrenPage = {
      schemaVersion: 1,
      parentTaskId: 'parent',
      items: [{ id: 'child', status: 'running' }],
      nextCursor: 'opaque-next-page',
    }
    expect(schema.parse(page)).toEqual(page)
    expect(schema.parse({ ...page, items: [], nextCursor: null })).toEqual({
      schemaVersion: 1,
      parentTaskId: 'parent',
      items: [],
      nextCursor: null,
    })
    for (const invalid of [
      { ...page, schemaVersion: 2 },
      { ...page, items: [{ id: 'child', status: 'running', workflowSnapshot: '{}' }] },
      { ...page, items: Array.from({ length: 201 }, () => page.items[0]) },
      { ...page, nextCursor: '' },
    ]) {
      expect(schema.safeParse(invalid).success).toBe(false)
    }
  })

  test('the MCP input exposes the bounded page arguments and rejects invalid limits', () => {
    const schema = z.object(tool.inputSchema)
    expect(toInputJsonSchema(schema) as unknown).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          description: 'Task id (ULID), as returned by launch_task/list_tasks',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        cursor: {
          type: 'string',
          minLength: 1,
          description: 'Opaque nextCursor from the preceding page',
        },
      },
      required: ['id'],
      additionalProperties: false,
    })
    expect(schema.parse({ id: 'parent' })).toEqual({ id: 'parent' })
    for (const limit of [1, 100, 200])
      expect(schema.parse({ id: 'parent', limit, cursor: 'opaque-next-page' })).toEqual({
        id: 'parent',
        limit,
        cursor: 'opaque-next-page',
      })
    for (const limit of [0, -1, 201, 1.5, '100'])
      expect(schema.safeParse({ id: 'parent', limit }).success).toBe(false)
    expect(schema.safeParse({ id: '' }).success).toBe(false)
    expect(schema.safeParse({ id: 'parent', cursor: '' }).success).toBe(false)
  })

  test('default arguments leave page sizing to the route and return an empty terminal page', async () => {
    const calls: RecordedOperationCall[] = []
    const page: TaskChildrenPage = {
      schemaVersion: 1,
      parentTaskId: 'parent',
      items: [],
      nextCursor: null,
    }
    const result = await tool.handler(
      { id: 'parent' },
      context(recordingOperationHandles(tool.name, calls, () => page)),
    )
    expect(result).toEqual(page)
    expect(calls).toEqual([
      {
        operationId: MCP_OPERATIONS.taskChildrenList.id,
        method: 'GET',
        path: '/api/tasks/parent/children',
        query: { limit: undefined, cursor: undefined },
      },
    ])
  })

  test('an opaque cursor and explicit page size reach one exact operation unchanged', async () => {
    const calls: RecordedOperationCall[] = []
    const page: TaskChildrenPage = {
      schemaVersion: 1,
      parentTaskId: 'parent/id',
      items: [{ id: 'child', status: 'done' }],
      nextCursor: 'opaque_following-page',
    }
    const result = await tool.handler(
      { id: 'parent/id', limit: 200, cursor: 'opaque_previous-page' },
      context(recordingOperationHandles(tool.name, calls, () => page)),
    )
    expect(result).toEqual(page)
    expect(calls).toEqual([
      {
        operationId: MCP_OPERATIONS.taskChildrenList.id,
        method: 'GET',
        path: '/api/tasks/parent%2Fid/children',
        query: { limit: '200', cursor: 'opaque_previous-page' },
      },
    ])
  })

  test('MCP consumes real route pages and retains the route cursor diagnostic', async () => {
    const harness = await buildContractHarness()
    try {
      const parentTaskId = harness.fixtures.taskId
      for (const row of [
        { id: 'children-old', status: 'done' as const, startedAt: 99, parentTaskId },
        { id: 'children-a', status: 'failed' as const, startedAt: 100, parentTaskId },
        { id: 'children-z', status: 'running' as const, startedAt: 100, parentTaskId },
        {
          id: 'children-grandchild',
          status: 'done' as const,
          startedAt: 101,
          parentTaskId: 'children-z',
        },
      ]) {
        await taskFixture(harness.db, {
          ...row,
          workflowId: harness.fixtures.workflowId,
          workflowSnapshot: '{}',
          repoPath: harness.homePath,
          worktreePath: join(harness.homePath, row.id),
          baseBranch: 'main',
          branch: row.id,
          inputs: '{}',
        })
      }
      const calls: RecordedOperationCall[] = []
      const ctx = context(
        forwardingOperationHandles(tool.name, calls, async (call) => {
          const search = new URLSearchParams()
          for (const [key, value] of Object.entries(call.query ?? {}))
            if (value !== undefined) search.set(key, value)
          const response = await reqAsAdmin(
            harness.app,
            call.method,
            `${call.path}?${search.toString()}`,
          )
          return { status: response.status, body: await response.json() }
        }),
      )
      const first = TaskChildrenPageSchema.parse(
        await tool.handler({ id: parentTaskId, limit: 2 }, ctx),
      )
      expect(first).toEqual({
        schemaVersion: 1,
        parentTaskId,
        items: [
          { id: 'children-z', status: 'running' },
          { id: 'children-a', status: 'failed' },
        ],
        nextCursor: expect.any(String),
      })
      expect(calls).toHaveLength(1)
      const nextCursor = first.nextCursor
      if (nextCursor === null) throw new Error('the first page must have a continuation cursor')
      const second = TaskChildrenPageSchema.parse(
        await tool.handler({ id: parentTaskId, limit: 2, cursor: nextCursor }, ctx),
      )
      expect(second).toEqual({
        schemaVersion: 1,
        parentTaskId,
        items: [{ id: 'children-old', status: 'done' }],
        nextCursor: null,
      })
      expect(calls).toHaveLength(2)
      expect(calls[1]?.query?.cursor).toBe(nextCursor)
      const invalid = tool.handler({ id: parentTaskId, cursor: 'broken' }, ctx)
      await expect(invalid).rejects.toBeInstanceOf(McpCallError)
      await expect(invalid).rejects.toMatchObject({
        status: 422,
        code: 'task-children-cursor-invalid',
      })
      expect(calls).toHaveLength(3)
    } finally {
      homes.push(harness.homePath)
    }
  })
})
