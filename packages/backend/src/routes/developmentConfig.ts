// RFC-310/RFC-344 — HTTP projection for development configuration operations.
//
// The owning module supplies the application operations. This adapter keeps
// only URL/body projection, transport status and the generic ACL transport.

import type { AclResourceType } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { DirectAuthenticatedAuthorityFactory } from '@/modules/identity-access/public/participants'
import type {
  DevelopmentConfigOperations,
  DevelopmentConfigResourceKind,
  DevelopmentConfigResourceOperations,
} from '@/modules/development-automation/public/operations'
import {
  createDevelopmentConfigResourceDescriptors,
  createDevelopmentConfigSupplementalDescriptors,
  developmentConfigReviseInputSchema,
  developmentEmployeePlaybookInputSchema,
} from '@/modules/development-automation/public/operations'
import { mountAclEndpoints } from '@/routes/resourceAcl'
import type { ResourceAclIdentityPersistence } from '@/services/resourceAcl'
import { registerOperationRoute } from '@/routes/operationRoute'
import { directOperationAuthority } from '@/routes/operationAuthority'
import { NotFoundError } from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'

interface ResourceHttpBinding {
  readonly kind: DevelopmentConfigResourceKind
  readonly base: string
  readonly aclType: AclResourceType
  readonly notFoundCode: string
}

const RESOURCE_BINDINGS: ReadonlyArray<ResourceHttpBinding> = Object.freeze([
  {
    kind: 'action-template',
    base: '/api/code/action-templates',
    aclType: 'action_template',
    notFoundCode: 'action-templates-not-found',
  },
  {
    kind: 'verification-profile',
    base: '/api/code/verification-profiles',
    aclType: 'verification_profile',
    notFoundCode: 'verification-profiles-not-found',
  },
  {
    kind: 'digital-employee',
    base: '/api/code/digital-employees',
    aclType: 'digital_employee',
    notFoundCode: 'digital-employees-not-found',
  },
  {
    kind: 'automation-policy',
    base: '/api/code/automation-policies',
    aclType: 'automation_policy',
    notFoundCode: 'automation-policies-not-found',
  },
  {
    kind: 'development-adapter',
    base: '/api/integrations/development-adapters',
    aclType: 'development_adapter',
    notFoundCode: 'adapter-definitions-not-found',
  },
])

function mountConfigResource(
  app: Hono,
  deps: { readonly db: DbClient },
  binding: ResourceHttpBinding,
  operations: DevelopmentConfigResourceOperations,
  contexts: DirectAuthenticatedAuthorityFactory,
  identityPersistence?: ResourceAclIdentityPersistence,
): void {
  const descriptors = createDevelopmentConfigResourceDescriptors(operations)
  const context = (c: Parameters<typeof actorOf>[0]) =>
    directOperationAuthority(contexts, actorOf(c))
  registerOperationRoute(app, {
    descriptor: descriptors.list,
    method: 'GET',
    path: binding.base,
    tokenAccess: 'allow',
    decode: () => ({}),
    context,
    encode: (c, output) => c.json({ items: output }),
  })
  registerOperationRoute(app, {
    descriptor: descriptors.create,
    method: 'POST',
    path: binding.base,
    tokenAccess: 'allow',
    decode: async (c) => safeJsonOrEmpty(c.req.raw),
    context,
    encode: (c, output) => c.json(output, 201),
  })
  registerOperationRoute(app, {
    descriptor: descriptors.get,
    method: 'GET',
    path: `${binding.base}/:id`,
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context,
    encode: (c, output) => {
      if (output === null) throw new NotFoundError(binding.notFoundCode, 'not found')
      return c.json(output)
    },
  })
  registerOperationRoute(app, {
    descriptor: descriptors.revise,
    method: 'PUT',
    path: `${binding.base}/:id`,
    tokenAccess: 'allow',
    decode: async (c) => ({
      id: c.req.param('id'),
      ...developmentConfigReviseInputSchema.parse(await safeJsonOrEmpty(c.req.raw)),
    }),
    context,
    encode: (c) => c.json({ ok: true }),
  })
  registerOperationRoute(app, {
    descriptor: descriptors.publish,
    method: 'POST',
    path: `${binding.base}/:id/publish`,
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptors.archive,
    method: 'POST',
    path: `${binding.base}/:id/archive`,
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context,
    encode: (c) => c.json({ ok: true }),
  })
  mountAclEndpoints(app, deps, {
    type: binding.aclType,
    base: binding.base,
    param: 'id',
    load: (_db, id) => operations.loadAclRow(id),
    ...(identityPersistence === undefined ? {} : { identityPersistence }),
  })
}

export function mountDevelopmentConfigRoutes(
  app: Hono,
  deps: { readonly db: DbClient },
  operations: DevelopmentConfigOperations,
  contexts: DirectAuthenticatedAuthorityFactory,
  developmentAdapterAclIdentity: ResourceAclIdentityPersistence,
): void {
  for (const binding of RESOURCE_BINDINGS) {
    mountConfigResource(
      app,
      deps,
      binding,
      operations.resources[binding.kind],
      contexts,
      binding.aclType === developmentAdapterAclIdentity.type
        ? developmentAdapterAclIdentity
        : undefined,
    )
  }
  const descriptors = createDevelopmentConfigSupplementalDescriptors(operations)
  const context = (c: Parameters<typeof actorOf>[0]) =>
    directOperationAuthority(contexts, actorOf(c))
  registerOperationRoute(app, {
    descriptor: descriptors.readEmployeePlaybook,
    method: 'GET',
    path: '/api/code/digital-employees/:id/playbook',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptors.reviseEmployeePlaybook,
    method: 'PUT',
    path: '/api/code/digital-employees/:id/playbook',
    tokenAccess: 'allow',
    decode: async (c) => ({
      id: c.req.param('id'),
      ...developmentEmployeePlaybookInputSchema.parse(await safeJsonOrEmpty(c.req.raw)),
    }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptors.validateEmployeePlaybook,
    method: 'POST',
    path: '/api/code/digital-employees/:id/playbook/validate',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptors.readSetupJourney,
    method: 'GET',
    path: '/api/code/setup-journey',
    tokenAccess: 'allow',
    decode: (c) => ({ employeeId: c.req.query('employee') }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptors.listAssignments,
    method: 'GET',
    path: '/api/code/repository-assignments',
    tokenAccess: 'allow',
    decode: () => ({}),
    context,
    encode: (c, output) => c.json({ items: output }),
  })
  registerOperationRoute(app, {
    descriptor: descriptors.upsertAssignment,
    method: 'PUT',
    path: '/api/code/repository-assignments',
    tokenAccess: 'allow',
    decode: async (c) => safeJsonOrEmpty(c.req.raw),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptors.deleteAssignment,
    method: 'DELETE',
    path: '/api/code/repository-assignments/:scopeKind',
    tokenAccess: 'allow',
    decode: (c) => ({
      scopeKind: c.req.param('scopeKind'),
      scopeRef: c.req.query('scopeRef') ?? null,
    }),
    context,
    encode: (c) => c.json({ ok: true }),
  })
  registerOperationRoute(app, {
    descriptor: descriptors.previewPolicy,
    method: 'POST',
    path: '/api/code/automation-policies/preview-decision',
    tokenAccess: 'allow',
    decode: async (c) => safeJsonOrEmpty(c.req.raw),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptors.previewSelection,
    method: 'POST',
    path: '/api/code/digital-employees/preview-selection',
    tokenAccess: 'allow',
    decode: async (c) => safeJsonOrEmpty(c.req.raw),
    context,
    encode: (c, output) => c.json(output),
  })
}
