import type { Context, Hono } from 'hono'
import { z } from 'zod'
import {
  GraphDesignActionRequestSchema,
  GraphDesignDocumentSchema,
  GraphAnchorSchema,
  GraphPresentationSchema,
} from '@agent-workflow/shared'
import { actorOf, type Actor } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import { NotFoundError, ValidationError } from '@/util/errors'
import type { GraphDevelopment } from '../../public/types'

const id = z.string().min(1).max(200),
  revision = z.number().int().positive()
async function body<T extends z.ZodTypeAny>(context: Context, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await context.req.json())
  if (!parsed.success) throw new ValidationError('graph-request-invalid', parsed.error.message)
  return parsed.data as z.infer<T>
}
/** Transport only; Case visibility and operation rights use the existing Case owner. */
export function mountGraphDesignRoutes(
  app: Hono,
  graph: GraphDevelopment,
  access: {
    authorize(actor: Actor, caseId: string, edit: boolean): Promise<unknown>
  },
) {
  async function authorize(context: Context, edit: boolean) {
    const identity = await graph.queries.identity(id.parse(context.req.param('id')))
    if (!identity) throw new NotFoundError('graph-design-not-found', '设计不存在')
    await access.authorize(actorOf(context), identity.caseId, edit)
    return identity.id
  }
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/content-links/:id',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Resolve a content anchor to its source workspace',
    },
    async (context) => {
      const designId = await authorize(context, false)
      const identity = (await graph.queries.identity(designId))!
      const selection = z
        .array(id)
        .max(250)
        .parse(JSON.parse(context.req.query('selection') ?? '[]'))
      const query = new URLSearchParams({
        tab: 'design',
        designSelection: JSON.stringify(selection),
      })
      const viewId = context.req.query('viewId')
      if (viewId) query.set('designView', id.parse(viewId))
      return context.json({
        href: `/tasks/employee-cases/${encodeURIComponent(identity.caseId)}?${query}`,
        label: designId,
      })
    },
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/employee-cases/:caseId/design',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Read the shared design identity of an employee Case',
    },
    async (context) => {
      await access.authorize(actorOf(context), context.req.param('caseId'), false)
      return context.json(await graph.queries.byCase(context.req.param('caseId')))
    },
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/development-designs/:id',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Read an exact or current design and its host references',
    },
    async (context) => {
      const designId = await authorize(context, false)
      const version = context.req.query('revision')
      return context.json(
        await graph.queries.workspace(
          designId,
          version ? revision.parse(Number(version)) : undefined,
        ),
      )
    },
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/development-designs/:id/views/:viewId',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Read a bounded graph view with stable semantic references',
    },
    async (context) => {
      const designId = await authorize(context, false)
      const query = z
        .object({
          revision: z.coerce.number().int().positive().optional(),
          offset: z.coerce.number().int().nonnegative().optional(),
          limit: z.coerce.number().int().min(1).max(250).optional(),
        })
        .parse(context.req.query())
      return context.json(await graph.queries.view(designId, context.req.param('viewId'), query))
    },
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/development-designs/:id/proposals/:proposalId',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Compare a design proposal against the current revision',
    },
    async (context) =>
      context.json(
        await graph.queries.proposal(
          await authorize(context, false),
          context.req.param('proposalId'),
        ),
      ),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/development-designs/:id/bases/:basisId',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Read a frozen implementation basis and its freshness',
    },
    async (context) =>
      context.json(
        await graph.basis(await authorize(context, false), context.req.param('basisId')),
      ),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/development-designs/:id/evidence',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Read version-bound design, execution and human evidence',
    },
    async (context) => context.json(await graph.evidence(await authorize(context, false))),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/development-designs/:id/evidence/:evidenceId/artifacts',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Read and export original verification receipts and retained logs',
    },
    async (context) => {
      const result = await graph.queries.evidenceArtifacts(
        await authorize(context, false),
        context.req.param('evidenceId'),
      )
      if (context.req.query('download') === 'true')
        context.header('Content-Disposition', 'attachment; filename="graph-evidence.json"')
      return context.json(result)
    },
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/development-designs/:id/verification-profiles',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'List published verification profiles for design obligations',
    },
    async (context) => {
      await authorize(context, false)
      return context.json(await graph.verificationProfiles())
    },
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/development-designs/:id/bases/:basisId/export',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Export an immutable implementation basis',
    },
    async (context) => {
      const files = await graph.exportBasis(
        await authorize(context, false),
        context.req.param('basisId'),
      )
      context.header('Content-Disposition', 'attachment; filename="implementation-basis.json"')
      return context.json({ schemaVersion: 1, files })
    },
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/development-designs/:id/changes',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Apply an explicit semantic edit with a revision check',
    },
    async (context) =>
      context.json(
        await graph.commands.change(
          await authorize(context, true),
          await body(
            context,
            z
              .object({
                requestId: id,
                expectedRevision: revision,
                document: GraphDesignDocumentSchema,
              })
              .strict(),
          ),
        ),
      ),
  )
  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/development-designs/:id/presentation',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Save view layout without changing semantic revisions',
    },
    async (context) => {
      await graph.queries.savePresentation(
        await authorize(context, true),
        await body(
          context,
          z
            .object({ expectedRevision: revision, views: z.record(GraphPresentationSchema) })
            .strict(),
        ),
      )
      return context.json({ ok: true })
    },
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/development-designs/:id/actions',
      executionGroup: 'digital-employee',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Generate a cancelable design proposal in the selected runtime',
    },
    async (context) =>
      context.json(
        await graph.planning.start(
          await authorize(context, true),
          await body(context, GraphDesignActionRequestSchema),
        ),
        202,
      ),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/development-designs/:id/actions/:requestId/cancel',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Cancel a graph assist call without changing human gates',
    },
    async (context) =>
      context.json(
        await graph.planning.cancel(await authorize(context, true), context.req.param('requestId')),
      ),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/development-designs/:id/actions/:requestId/retry',
      executionGroup: 'digital-employee',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Retry a failed or interrupted graph assist request',
    },
    async (context) =>
      context.json(
        await graph.planning.retry(await authorize(context, true), context.req.param('requestId')),
        202,
      ),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/development-designs/:id/proposals/:proposalId/apply',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Apply a proposal only if its read set still matches',
    },
    async (context) => {
      const designId = await authorize(context, true),
        request = await body(context, z.object({ requestId: id }).strict())
      return context.json(
        await graph.commands.applyProposal(
          designId,
          context.req.param('proposalId'),
          request.requestId,
        ),
      )
    },
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/development-designs/:id/baseline-previews',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Freeze a reviewable implementation basis without approving it',
    },
    async (context) =>
      context.json(
        await graph.commands.preview(
          await authorize(context, true),
          await body(
            context,
            z
              .object({
                requestId: id,
                expectedRevision: revision,
                includedElementIds: z.array(id).min(1),
              })
              .strict(),
          ),
        ),
      ),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/development-designs/:id/review-requests',
      executionGroup: 'digital-employee',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Request native review of an exact implementation basis',
    },
    async (context) =>
      context.json(
        await graph.commands.requestReview(
          await authorize(context, true),
          await body(context, z.object({ requestId: id, basisId: id }).strict()),
        ),
        202,
      ),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/development-designs/:id/implementation-requests',
      executionGroup: 'digital-employee',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Request implementation of an approved basis through the Case',
    },
    async (context) =>
      context.json(
        await graph.commands.requestImplementation(
          await authorize(context, true),
          await body(
            context,
            z.object({ requestId: id, basisId: id, reviewReceiptId: id }).strict(),
          ),
        ),
        202,
      ),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/development-designs/:id/clarification-requests',
      executionGroup: 'digital-employee',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Request further clarification after a closed human round',
    },
    async (context) =>
      context.json(
        await graph.commands.requestClarification(
          await authorize(context, true),
          await body(
            context,
            z
              .object({
                requestId: id,
                expectedRevision: revision,
                instruction: z.string().min(1).max(20_000),
                anchor: GraphAnchorSchema.nullable(),
                previousSourceIds: z.array(id),
                withdrawReview: z.boolean(),
              })
              .strict(),
          ),
        ),
        202,
      ),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/development-designs/:id/acceptance',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Record a human acceptance judgment on an exact candidate',
    },
    async (context) =>
      context.json(
        await graph.accept(
          await authorize(context, true),
          await body(
            context,
            z
              .object({
                requestId: id,
                basisId: id,
                candidateTreeOid: id,
                obligationIds: z.array(id).min(1),
                result: z.enum(['passed', 'failed']),
                comment: z.string().min(1).max(20_000),
              })
              .strict(),
          ),
          actorOf(context).user.id,
        ),
      ),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/development-designs/:id/verification-requests',
      executionGroup: 'digital-employee',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Request verification again after acceptance or repair',
    },
    async (context) => {
      const designId = await authorize(context, true)
      const request = await body(context, z.object({ requestId: id }).strict())
      return context.json(await graph.requestVerification(designId, request.requestId), 202)
    },
  )
}
