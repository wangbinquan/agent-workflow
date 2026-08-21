import type { Hono } from 'hono'
import { z } from 'zod'

import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import { parseExecutionContractRef } from '@/modules/execution-contract/public/types'
import { registerRoute } from '@/routes/registry'
import { ValidationError } from '@/util/errors'

const agentCandidateRequestSchema = z
  .object({
    agentRefs: z
      .array(z.object({ id: z.string().min(1), revision: z.number().int().positive() }).strict())
      .max(200),
  })
  .strict()

function parseRef(value: string) {
  try {
    return parseExecutionContractRef(value)
  } catch (error) {
    throw new ValidationError(
      'execution-contract-ref-invalid',
      error instanceof Error ? error.message : String(error),
    )
  }
}

export function mountExecutionContractRoutes(
  app: Hono,
  contracts: ExecutionContractParticipant,
): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/execution-contracts',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'List platform execution contracts and their deterministic IO guides',
    },
    (c) =>
      c.json({
        items: contracts.list().map(({ guideJson: _guideJson, ...summary }) => summary),
      }),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/execution-contracts/:contractRef',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Read one exact platform execution contract guide',
    },
    (c) => {
      const contract = contracts.get(parseRef(c.req.param('contractRef')))
      return c.body(contract.guideJson, 200, { 'content-type': 'application/json; charset=UTF-8' })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/execution-contracts/:contractRef/agent-candidates',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Validate visible exact Agent revisions against one platform execution contract',
    },
    async (c) => {
      const body = agentCandidateRequestSchema.parse(await c.req.json())
      return c.json({
        items: await contracts.validateAgentCandidates({
          contractRef: parseRef(c.req.param('contractRef')),
          agentRefs: body.agentRefs,
        }),
      })
    },
  )
}
