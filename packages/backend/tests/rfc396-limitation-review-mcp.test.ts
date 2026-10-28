// RFC-396 H5: the MCP entry forwards the same explicit judgment command as the UI.
import { expect, test } from 'bun:test'
import { z } from 'zod'
import { GraphLimitationReviewRequestSchema } from '@agent-workflow/shared'
import { ALL_TOOLS, type McpToolContext } from '@/mcp/tools'
import {
  recordingOperationHandles,
  forwardingOperationHandles,
  type RecordedOperationCall,
} from './helpers/mcpOperationRecording'

const tool = ALL_TOOLS.find((tool) => tool.name === 'review_graph_limitations')!
const input = {
  id: 'design-a',
  proposalId: 'code-feedback:build',
  requestId: 'human-review',
  comment: 'A person confirmed these are verification arrangements, not implementation gaps.',
}

test('the tool preserves the request identity, reason and proposal in the registered command', async () => {
  const calls: RecordedOperationCall[] = []
  const evidence = { id: 'limitation-review:human-review' }
  const context: McpToolContext = {
    actor: {} as McpToolContext['actor'],
    operations: recordingOperationHandles(tool.name, calls, () => evidence),
    progress: async () => {},
    signal: new AbortController().signal,
  }
  expect(tool.permissions).toEqual(['development-missions:interact'])
  expect(tool.inputSchema.requestId).toBe(GraphLimitationReviewRequestSchema.shape.requestId)
  expect(tool.inputSchema.comment).toBe(GraphLimitationReviewRequestSchema.shape.comment)
  const parsed = z.object(tool.inputSchema).parse(input)
  expect(await tool.handler(parsed, context)).toEqual(evidence)
  expect(await tool.handler(parsed, context)).toEqual(evidence)
  expect(calls).toHaveLength(2)
  expect(calls[0]).toEqual(calls[1])
  expect(calls[0]).toMatchObject({
    method: 'POST',
    path: '/api/development-designs/design-a/proposals/code-feedback%3Abuild/limitation-review',
    body: { requestId: input.requestId, comment: input.comment },
  })
})

test('the tool uses the shared reason length and forwards command conflicts unchanged', async () => {
  const schema = z.object(tool.inputSchema)
  for (const comment of ['', ' \n ', '😀'.repeat(10_001)])
    expect(schema.safeParse({ ...input, comment }).success).toBe(false)
  expect(schema.safeParse({ ...input, comment: '😀'.repeat(10_000) }).success).toBe(true)
  await expect(
    tool.handler(input, {
      actor: {} as McpToolContext['actor'],
      operations: forwardingOperationHandles(tool.name, [], () => ({
        status: 409,
        body: { code: 'graph-proposal-already-decided', message: 'Already decided' },
      })),
      progress: async () => {},
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'graph-proposal-already-decided', status: 409 })
})
