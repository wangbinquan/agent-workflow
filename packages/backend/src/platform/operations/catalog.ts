// RFC-344 — closed operation/binding catalog and startup self-check.
//
// Static declarations name contracts. Runtime route registration contributes
// the HTTP projection. Callers receive frozen snapshots or typed refs only;
// this module is not exported to business modules as a service locator.

import type { Permission } from '@agent-workflow/shared'
import { PUBLIC_ERROR_DEFINITIONS } from '@/platform/errors/publicError'
import {
  type HttpMethod,
  type HttpOperationBinding,
  type McpOperationBinding,
  type OperationAlias,
  type OperationDescriptor,
  type OperationContextKind,
  type OperationId,
  type OperationKind,
  type TokenAccess,
} from '@/platform/operations/contracts'

const OPERATION_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.v[1-9][0-9]*$/

export interface DeclaredHttpOperation {
  readonly id: OperationId
  readonly kind: Extract<OperationKind, 'command' | 'idempotent-command' | 'query'>
  readonly method: HttpMethod
  readonly path: string
  /**
   * `compatibility` means the operation still terminates at an existing HTTP
   * handler.  It is an explicit migration debt, never evidence that the
   * owning application descriptor has been cut over.
   */
  readonly implementation: 'descriptor' | 'compatibility' | 'alias'
}

export interface OperationCatalogRouteProjection extends HttpOperationBinding {
  readonly operationKind: DeclaredHttpOperation['kind']
  readonly permissions: ReadonlyArray<Permission>
  readonly publicReason?: string
  readonly summary: string
  /** True until an owning module exports a transport-neutral descriptor. */
  readonly legacyHttpAdapter: boolean
}

export interface OperationCatalogToolProjection {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly permissions: ReadonlyArray<Permission>
  readonly binding: McpOperationBinding
}

export interface OperationCatalogResourceProjection {
  readonly kind: string
  readonly description: unknown
}

export interface OperationDescriptorProjection {
  readonly id: OperationId
  readonly kind: OperationKind
  readonly contextKind: OperationContextKind
  readonly summary: string
  readonly inputCodec: Readonly<{ name: string; version: number }>
  readonly outputCodec: Readonly<{ name: string; version: number }>
  readonly publicErrors: ReadonlyArray<string>
  readonly permissions: ReadonlyArray<Permission>
  readonly publicReason?: string
  readonly idempotencyKey?: Readonly<{
    field: string
    minLength: number
    maxLength: number
    pattern: string
  }>
}

export interface OperationCatalogSnapshot {
  readonly declarations: ReadonlyArray<DeclaredHttpOperation>
  readonly aliases?: ReadonlyArray<OperationAlias>
  readonly descriptors?: ReadonlyArray<OperationDescriptorProjection>
  readonly routes: ReadonlyArray<OperationCatalogRouteProjection>
  readonly tools: ReadonlyArray<OperationCatalogToolProjection>
}

const DECLARED_BY_ID = new Map<OperationId, DeclaredHttpOperation>()
const DECLARED_BY_ROUTE = new Map<string, DeclaredHttpOperation>()
const ROUTE_DERIVED_DECLARATION_IDS = new Set<OperationId>()
const ALIASES_BY_ID = new Map<OperationId, OperationAlias>()
const DESCRIPTORS_BY_ID = new Map<OperationId, OperationDescriptorProjection>()
const ROUTES_BY_ID = new Map<OperationId, OperationCatalogRouteProjection>()
const ROUTES_BY_KEY = new Map<string, OperationCatalogRouteProjection>()
let TOOL_PROJECTION: ReadonlyArray<OperationCatalogToolProjection> = Object.freeze([])
let RESOURCE_PROJECTION: ReadonlyArray<OperationCatalogResourceProjection> = Object.freeze([])

function routeKey(method: string, path: string): string {
  return `${method} ${path}`
}

function assertOperationId(id: string): asserts id is OperationId {
  if (!OPERATION_ID_PATTERN.test(id)) {
    throw new OperationCatalogError(
      `invalid operation id '${id}'; expected <bounded-context>.<verb-subject>.v<major>`,
    )
  }
}

export function operationId(id: string): OperationId {
  assertOperationId(id)
  return id
}

export class OperationCatalogError extends Error {}

export function registerOperationDescriptor<I, O, C>(
  descriptor: OperationDescriptor<I, O, C>,
): OperationDescriptorProjection {
  assertOperationId(descriptor.id)
  const next: OperationDescriptorProjection = Object.freeze({
    id: descriptor.id,
    kind: descriptor.kind,
    contextKind: descriptor.contextKind,
    summary: descriptor.summary,
    inputCodec: Object.freeze({
      name: descriptor.input.name,
      version: descriptor.input.version,
    }),
    outputCodec: Object.freeze({
      name: descriptor.output.name,
      version: descriptor.output.version,
    }),
    publicErrors: Object.freeze([...descriptor.publicErrors]),
    permissions: Object.freeze([...descriptor.permissions]),
    ...(descriptor.publicReason === undefined ? {} : { publicReason: descriptor.publicReason }),
    ...(descriptor.kind !== 'idempotent-command'
      ? {}
      : {
          idempotencyKey: Object.freeze({
            field: descriptor.idempotencyKey.field,
            minLength: descriptor.idempotencyKey.minLength,
            maxLength: descriptor.idempotencyKey.maxLength,
            pattern: descriptor.idempotencyKey.pattern.source,
          }),
        }),
  })
  const existing = DESCRIPTORS_BY_ID.get(next.id)
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(next)) {
    throw new OperationCatalogError(`${next.id}: conflicting operation descriptor`)
  }
  DESCRIPTORS_BY_ID.set(next.id, next)
  return next
}

export function registerOperationAlias(alias: OperationAlias): OperationAlias {
  assertOperationId(alias.alias)
  assertOperationId(alias.target)
  if (alias.alias === alias.target) {
    throw new OperationCatalogError(`${alias.alias}: operation alias cannot target itself`)
  }
  const target = DECLARED_BY_ID.get(alias.target)
  if (target === undefined) {
    throw new OperationCatalogError(
      `${alias.alias}: unknown operation alias target '${alias.target}'`,
    )
  }
  if (target.implementation !== 'descriptor') {
    throw new OperationCatalogError(
      `${alias.alias}: operation alias target is not descriptor-backed`,
    )
  }
  const next = Object.freeze({ ...alias })
  const existing = ALIASES_BY_ID.get(next.alias)
  if (existing !== undefined) {
    if (existing.target !== next.target || existing.removeAfter !== next.removeAfter) {
      throw new OperationCatalogError(`${next.alias}: conflicting operation alias`)
    }
    return existing
  }
  if (DECLARED_BY_ID.has(next.alias)) {
    throw new OperationCatalogError(`${next.alias}: operation alias conflicts with a declaration`)
  }
  const declaration: DeclaredHttpOperation = Object.freeze({
    id: next.alias,
    kind: target.kind,
    method: target.method,
    path: target.path,
    implementation: 'alias',
  })
  ALIASES_BY_ID.set(next.alias, next)
  // Alias declarations deliberately stay out of DECLARED_BY_ROUTE: the target
  // is the route's only primary and owns its sole handler projection.
  DECLARED_BY_ID.set(next.alias, declaration)
  return next
}

export function allOperationAliases(): ReadonlyArray<OperationAlias> {
  return Object.freeze([...ALIASES_BY_ID.values()])
}

export function lookupOperationAlias(id: OperationId): OperationAlias | undefined {
  return ALIASES_BY_ID.get(id)
}

/** Resolve at most one compatibility hop to the application primary id. */
export function resolveOperationId(id: OperationId): OperationId {
  return ALIASES_BY_ID.get(id)?.target ?? id
}

export function lookupOperationDescriptor(
  id: OperationId,
): OperationDescriptorProjection | undefined {
  return DESCRIPTORS_BY_ID.get(resolveOperationId(id))
}

export function declareHttpOperation(input: {
  readonly id: string
  readonly kind?: DeclaredHttpOperation['kind']
  readonly method: HttpMethod
  readonly path: string
  readonly implementation?: Exclude<DeclaredHttpOperation['implementation'], 'alias'>
}): DeclaredHttpOperation {
  const id = operationId(input.id)
  const next: DeclaredHttpOperation = Object.freeze({
    id,
    kind: input.kind ?? (input.method === 'GET' ? 'query' : 'command'),
    method: input.method,
    path: input.path,
    implementation: input.implementation ?? 'compatibility',
  })
  const byId = DECLARED_BY_ID.get(id)
  if (
    byId !== undefined &&
    (byId.method !== next.method ||
      byId.path !== next.path ||
      byId.kind !== next.kind ||
      byId.implementation !== next.implementation)
  ) {
    throw new OperationCatalogError(
      `${id}: duplicate operation id for ${routeKey(next.method, next.path)}`,
    )
  }
  const key = routeKey(next.method, next.path)
  const byRoute = DECLARED_BY_ROUTE.get(key)
  if (byRoute !== undefined && byRoute.id !== id) {
    throw new OperationCatalogError(`${key}: already bound to operation ${byRoute.id}`)
  }
  DECLARED_BY_ID.set(id, next)
  DECLARED_BY_ROUTE.set(key, next)
  return next
}

function legacyOperationFor(method: HttpMethod, path: string): DeclaredHttpOperation {
  const stem = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/^api\//, '')
    .replace(/:([A-Za-z0-9_]+)/g, 'by-$1')
    .replace(/\*/g, 'wildcard')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  const verb = method === 'GET' ? 'read' : method.toLowerCase()
  const declared = declareHttpOperation({
    id: `legacy-http.${verb}-${stem || 'root'}.v1`,
    kind: method === 'GET' ? 'query' : 'command',
    method,
    path,
  })
  ROUTE_DERIVED_DECLARATION_IDS.add(declared.id)
  return declared
}

export function registerHttpOperationProjection(input: {
  readonly method: HttpMethod
  readonly path: string
  readonly permissions: ReadonlyArray<Permission>
  readonly publicReason?: string
  readonly tokenAccess: TokenAccess
  readonly summary: string
}): OperationCatalogRouteProjection {
  const key = routeKey(input.method, input.path)
  const declared = DECLARED_BY_ROUTE.get(key) ?? legacyOperationFor(input.method, input.path)
  const next: OperationCatalogRouteProjection = Object.freeze({
    kind: 'http',
    operationId: declared.id,
    operationKind: declared.kind,
    method: input.method,
    path: input.path,
    permissions: Object.freeze([...input.permissions]),
    ...(input.publicReason === undefined ? {} : { publicReason: input.publicReason }),
    tokenAccess: input.tokenAccess,
    summary: input.summary,
    legacyHttpAdapter: declared.implementation === 'compatibility',
  })
  const existing = ROUTES_BY_KEY.get(key)
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(next)) {
    throw new OperationCatalogError(`${key}: conflicting operation projection`)
  }
  ROUTES_BY_KEY.set(key, next)
  ROUTES_BY_ID.set(declared.id, next)
  return next
}

export function lookupHttpOperationById(
  id: OperationId,
): OperationCatalogRouteProjection | undefined {
  return ROUTES_BY_ID.get(resolveOperationId(id))
}

export function lookupDeclaredHttpOperation(
  method: HttpMethod,
  path: string,
): DeclaredHttpOperation | undefined {
  return DECLARED_BY_ROUTE.get(routeKey(method, path))
}

export function lookupDeclaredHttpOperationById(
  id: OperationId,
): DeclaredHttpOperation | undefined {
  return DECLARED_BY_ID.get(resolveOperationId(id))
}

export function allOperationRoutes(): ReadonlyArray<OperationCatalogRouteProjection> {
  return Object.freeze([...ROUTES_BY_KEY.values()])
}

export function registerMcpOperationProjection(
  tools: ReadonlyArray<OperationCatalogToolProjection>,
  resources: ReadonlyArray<OperationCatalogResourceProjection>,
): void {
  const names = new Set<string>()
  for (const tool of tools) {
    if (names.has(tool.name)) throw new OperationCatalogError(`duplicate MCP tool '${tool.name}'`)
    names.add(tool.name)
    if (tool.binding.toolName !== tool.name) {
      throw new OperationCatalogError(
        `${tool.name}: binding toolName is '${tool.binding.toolName}'`,
      )
    }
  }
  TOOL_PROJECTION = Object.freeze(
    tools.map((tool) =>
      Object.freeze({
        ...tool,
        permissions: Object.freeze([...tool.permissions]),
        binding: Object.freeze(tool.binding),
      }),
    ),
  )
  RESOURCE_PROJECTION = Object.freeze(resources.map((entry) => Object.freeze({ ...entry })))
}

export function allOperationTools(): ReadonlyArray<OperationCatalogToolProjection> {
  return TOOL_PROJECTION
}

export function allOperationResources(): ReadonlyArray<OperationCatalogResourceProjection> {
  return RESOURCE_PROJECTION
}

export function operationDependencies(binding: McpOperationBinding): ReadonlyArray<OperationId> {
  switch (binding.kind) {
    case 'mcp-direct':
    case 'mcp-local':
      return [binding.operationId]
    case 'mcp-parameterized':
      return binding.cases.map((entry) => entry.operationId)
    case 'mcp-composite':
      return binding.dependencies
  }
}

function duplicateValues(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates].sort()
}

function expectedContextKind(kind: OperationKind): OperationContextKind {
  switch (kind) {
    case 'command':
    case 'idempotent-command':
      return 'authenticated-command'
    case 'query':
      return 'authenticated-query'
    case 'credential-authentication':
      return 'credential'
    case 'verified-ingress':
      return 'verified-ingress'
    case 'bootstrap-admin':
      return 'bootstrap'
    case 'public-liveness':
      return 'public'
  }
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  const expected = [...left].sort()
  const actual = [...right].sort()
  return (
    expected.length === actual.length && expected.every((value, index) => value === actual[index])
  )
}

/**
 * Pure catalog validation used by startup and mutation tests.  Global maps are
 * only collection state; all closure semantics live here so a test can prove
 * each negative fixture without contaminating another app instance.
 */
export function validateOperationCatalogSnapshot(snapshot: OperationCatalogSnapshot): void {
  const aliases = snapshot.aliases ?? []
  const descriptors = snapshot.descriptors ?? []
  const duplicateDescriptorIds = duplicateValues(descriptors.map((entry) => entry.id))
  if (duplicateDescriptorIds.length > 0) {
    throw new OperationCatalogError(
      `duplicate operation descriptors: ${duplicateDescriptorIds.join(', ')}`,
    )
  }
  const descriptorsById = new Map(descriptors.map((entry) => [entry.id, entry]))
  for (const descriptor of descriptors) {
    if (!OPERATION_ID_PATTERN.test(descriptor.id)) {
      throw new OperationCatalogError(`${descriptor.id}: invalid descriptor operation id`)
    }
    if (descriptor.summary.trim() === '') {
      throw new OperationCatalogError(`${descriptor.id}: descriptor summary is empty`)
    }
    if (descriptor.inputCodec.version < 1 || descriptor.outputCodec.version < 1) {
      throw new OperationCatalogError(`${descriptor.id}: codec version must be positive`)
    }
    if (descriptor.inputCodec.name.trim() === '' || descriptor.outputCodec.name.trim() === '') {
      throw new OperationCatalogError(`${descriptor.id}: codec name is empty`)
    }
    if (descriptor.contextKind !== expectedContextKind(descriptor.kind)) {
      throw new OperationCatalogError(
        `${descriptor.id}: ${descriptor.kind} cannot use context '${descriptor.contextKind}'`,
      )
    }
    const duplicateErrors = duplicateValues(descriptor.publicErrors)
    if (duplicateErrors.length > 0) {
      throw new OperationCatalogError(
        `${descriptor.id}: duplicate public errors ${duplicateErrors.join(', ')}`,
      )
    }
    const unknownErrors = descriptor.publicErrors.filter(
      (code) => !Object.prototype.hasOwnProperty.call(PUBLIC_ERROR_DEFINITIONS, code),
    )
    if (unknownErrors.length > 0) {
      throw new OperationCatalogError(
        `${descriptor.id}: unknown public errors ${unknownErrors.join(', ')}`,
      )
    }
    if (descriptor.permissions.length === 0 && descriptor.publicReason === undefined) {
      throw new OperationCatalogError(`${descriptor.id}: empty admission needs publicReason`)
    }
    if (descriptor.permissions.length > 0 && descriptor.publicReason !== undefined) {
      throw new OperationCatalogError(`${descriptor.id}: publicReason conflicts with permissions`)
    }
    if (descriptor.kind === 'idempotent-command') {
      const key = descriptor.idempotencyKey
      if (
        key === undefined ||
        key.field === '' ||
        key.minLength < 1 ||
        key.maxLength < key.minLength ||
        key.pattern === ''
      ) {
        throw new OperationCatalogError(`${descriptor.id}: invalid idempotency contract`)
      }
    } else if (descriptor.idempotencyKey !== undefined) {
      throw new OperationCatalogError(
        `${descriptor.id}: only idempotent-command may declare an idempotency key`,
      )
    }
  }

  const duplicateIds = duplicateValues(snapshot.declarations.map((entry) => entry.id))
  if (duplicateIds.length > 0) {
    throw new OperationCatalogError(`duplicate operation ids: ${duplicateIds.join(', ')}`)
  }
  const duplicateDeclarationRoutes = duplicateValues(
    snapshot.declarations
      .filter((entry) => entry.implementation !== 'alias')
      .map((entry) => routeKey(entry.method, entry.path)),
  )
  if (duplicateDeclarationRoutes.length > 0) {
    throw new OperationCatalogError(
      `duplicate operation routes: ${duplicateDeclarationRoutes.join(', ')}`,
    )
  }

  const declaredById = new Map(snapshot.declarations.map((entry) => [entry.id, entry]))
  const routesById = new Map(snapshot.routes.map((entry) => [entry.operationId, entry]))

  const aliasesById = new Map<OperationId, OperationAlias>()
  for (const alias of aliases) {
    if (!OPERATION_ID_PATTERN.test(alias.alias) || !OPERATION_ID_PATTERN.test(alias.target)) {
      throw new OperationCatalogError(`${alias.alias}: invalid operation alias id`)
    }
    const existing = aliasesById.get(alias.alias)
    if (existing !== undefined) {
      if (existing.target !== alias.target) {
        throw new OperationCatalogError(`${alias.alias}: operation alias is one-to-many`)
      }
      throw new OperationCatalogError(`${alias.alias}: duplicate operation alias`)
    }
    aliasesById.set(alias.alias, alias)
  }
  for (const alias of aliases) {
    const seen = new Set<OperationId>([alias.alias])
    let cursor = alias.target
    while (aliasesById.has(cursor)) {
      if (seen.has(cursor)) {
        throw new OperationCatalogError(`${alias.alias}: operation alias cycle`)
      }
      seen.add(cursor)
      cursor = aliasesById.get(cursor)!.target
    }
    if (aliasesById.has(alias.target)) {
      throw new OperationCatalogError(`${alias.alias}: operation alias chain is forbidden`)
    }

    const declaration = declaredById.get(alias.alias)
    if (declaration === undefined || declaration.implementation !== 'alias') {
      throw new OperationCatalogError(`${alias.alias}: missing operation alias declaration`)
    }
    const target = declaredById.get(alias.target)
    if (target === undefined) {
      throw new OperationCatalogError(
        `${alias.alias}: unknown operation alias target '${alias.target}'`,
      )
    }
    if (target.implementation !== 'descriptor') {
      throw new OperationCatalogError(
        `${alias.alias}: stale operation alias target '${alias.target}'`,
      )
    }
    if (declaration.kind !== target.kind) {
      throw new OperationCatalogError(`${alias.alias}: operation alias kind mismatch`)
    }
    if (declaration.method !== target.method || declaration.path !== target.path) {
      throw new OperationCatalogError(`${alias.alias}: operation alias binding mismatch`)
    }
    const aliasMajor = alias.alias.match(/\.v([1-9][0-9]*)$/)?.[1]
    const targetMajor = alias.target.match(/\.v([1-9][0-9]*)$/)?.[1]
    if (aliasMajor !== targetMajor) {
      throw new OperationCatalogError(`${alias.alias}: operation alias codec major mismatch`)
    }
    if (alias.removeAfter !== 'explicit-consumer-zero-decision') {
      throw new OperationCatalogError(`${alias.alias}: invalid operation alias removal contract`)
    }
    if (descriptorsById.has(alias.alias) || routesById.has(alias.alias)) {
      throw new OperationCatalogError(`${alias.alias}: operation alias cannot own codec or handler`)
    }
  }
  for (const declaration of snapshot.declarations) {
    if (declaration.implementation === 'alias' && !aliasesById.has(declaration.id)) {
      throw new OperationCatalogError(`${declaration.id}: stale operation alias declaration`)
    }
  }

  const resolvedOperationId = (id: OperationId): OperationId => aliasesById.get(id)?.target ?? id
  const duplicateMountedIds = duplicateValues(snapshot.routes.map((entry) => entry.operationId))
  if (duplicateMountedIds.length > 0) {
    throw new OperationCatalogError(
      `duplicate mounted operation ids: ${duplicateMountedIds.join(', ')}`,
    )
  }
  const duplicateMountedRoutes = duplicateValues(
    snapshot.routes.map((entry) => routeKey(entry.method, entry.path)),
  )
  if (duplicateMountedRoutes.length > 0) {
    throw new OperationCatalogError(
      `duplicate mounted operation routes: ${duplicateMountedRoutes.join(', ')}`,
    )
  }
  for (const route of snapshot.routes) {
    const declaration = declaredById.get(route.operationId)
    if (declaration === undefined) {
      throw new OperationCatalogError(
        `${routeKey(route.method, route.path)}: mounted unknown operation '${route.operationId}'`,
      )
    }
    if (
      declaration.method !== route.method ||
      declaration.path !== route.path ||
      declaration.kind !== route.operationKind
    ) {
      throw new OperationCatalogError(
        `${route.operationId}: mounted binding does not match its declaration`,
      )
    }
    if (route.permissions.length === 0 && route.publicReason === undefined) {
      throw new OperationCatalogError(
        `${routeKey(route.method, route.path)}: empty admission needs publicReason`,
      )
    }
    if (route.permissions.length > 0 && route.publicReason !== undefined) {
      throw new OperationCatalogError(
        `${routeKey(route.method, route.path)}: publicReason conflicts with permissions`,
      )
    }
    if (route.summary.trim() === '') {
      throw new OperationCatalogError(
        `${routeKey(route.method, route.path)}: operation summary is empty`,
      )
    }
    if (route.legacyHttpAdapter !== (declaration.implementation === 'compatibility')) {
      throw new OperationCatalogError(
        `${route.operationId}: compatibility projection does not match declaration`,
      )
    }
    const descriptor = descriptorsById.get(route.operationId)
    if (declaration.implementation === 'descriptor' && descriptor === undefined) {
      throw new OperationCatalogError(`${route.operationId}: descriptor binding has no descriptor`)
    }
    if (descriptor !== undefined) {
      if (descriptor.kind !== declaration.kind) {
        throw new OperationCatalogError(`${route.operationId}: descriptor kind mismatch`)
      }
      if (
        descriptor.permissions.length !== route.permissions.length ||
        !descriptor.permissions.every(
          (permission, index) => route.permissions[index] === permission,
        ) ||
        descriptor.publicReason !== route.publicReason ||
        descriptor.summary !== route.summary
      ) {
        throw new OperationCatalogError(
          `${route.operationId}: descriptor admission projection drift`,
        )
      }
    }
  }

  for (const descriptor of descriptors) {
    const declaration = declaredById.get(descriptor.id)
    if (declaration === undefined) {
      throw new OperationCatalogError(`${descriptor.id}: orphan operation descriptor`)
    }
    if (declaration.implementation !== 'descriptor') {
      throw new OperationCatalogError(
        `${descriptor.id}: descriptor is bound as compatibility operation`,
      )
    }
  }

  const duplicateTools = duplicateValues(snapshot.tools.map((entry) => entry.name))
  if (duplicateTools.length > 0) {
    throw new OperationCatalogError(`duplicate MCP tools: ${duplicateTools.join(', ')}`)
  }
  for (const tool of snapshot.tools) {
    if (tool.binding.toolName !== tool.name) {
      throw new OperationCatalogError(
        `${tool.name}: binding toolName is '${tool.binding.toolName}'`,
      )
    }
    const dependencies = operationDependencies(tool.binding)
    if (tool.binding.kind === 'mcp-parameterized') {
      const selectors = tool.binding.cases.map((entry) => entry.selector)
      const duplicateSelectors = duplicateValues(selectors)
      if (duplicateSelectors.length > 0) {
        throw new OperationCatalogError(
          `${tool.name}: duplicate parameterized selector ${duplicateSelectors.join(', ')}`,
        )
      }
      if (selectors.some((selector) => selector === '*' || selector === 'default')) {
        throw new OperationCatalogError(`${tool.name}: wildcard/default selector is forbidden`)
      }
    }
    const duplicateDependencies = duplicateValues(dependencies)
    if (duplicateDependencies.length > 0) {
      throw new OperationCatalogError(
        `${tool.name}: duplicate operation dependency ${duplicateDependencies.join(', ')}`,
      )
    }
    for (const id of dependencies) {
      if (tool.binding.kind === 'mcp-local') continue
      if (!routesById.has(resolvedOperationId(id))) {
        throw new OperationCatalogError(`${tool.name}: unknown operation dependency '${id}'`)
      }
    }
    // Compatibility tools deliberately keep their existing McpToolDef admission
    // until the owning operation is descriptor-backed. Legacy HTTP metadata may
    // carry a different coarse read gate; the shared handler chain still applies
    // that gate at invocation time, but it is not a second source for the MCP
    // presentation contract. Descriptor-backed operations have no such escape
    // hatch: their route and direct/composite tool projections must be identical.
    const descriptorBacked = dependencies.every(
      (id) => declaredById.get(resolvedOperationId(id))?.implementation === 'descriptor',
    )
    if (
      (tool.binding.kind === 'mcp-direct' || tool.binding.kind === 'mcp-composite') &&
      descriptorBacked
    ) {
      const expectedPermissions = [
        ...new Set(
          dependencies.flatMap((id) => routesById.get(resolvedOperationId(id))?.permissions ?? []),
        ),
      ]
      if (!sameStrings(tool.permissions, expectedPermissions)) {
        throw new OperationCatalogError(
          `${tool.name}: tool admission does not match operation dependencies`,
        )
      }
    } else if (
      (tool.binding.kind === 'mcp-parameterized' || tool.binding.kind === 'mcp-local') &&
      tool.permissions.length > 0
    ) {
      throw new OperationCatalogError(
        `${tool.name}: parameterized/local tool admission must be resolved per dependency`,
      )
    }
  }

  for (const declared of snapshot.declarations) {
    if (declared.implementation === 'alias') continue
    if (!routesById.has(declared.id)) {
      throw new OperationCatalogError(`${declared.id}: declared operation has no mounted binding`)
    }
  }
}

/** Validate the fully-mounted route table and the complete MCP binding set. */
export function assertOperationCatalogClosed(): void {
  if (TOOL_PROJECTION.length === 0) {
    throw new OperationCatalogError('operation catalog has no MCP tool projection')
  }
  validateOperationCatalogSnapshot({
    declarations: [...DECLARED_BY_ID.values()],
    aliases: [...ALIASES_BY_ID.values()],
    descriptors: [...DESCRIPTORS_BY_ID.values()],
    routes: [...ROUTES_BY_ID.values()],
    tools: TOOL_PROJECTION,
  })
}

/** Test-only: routes are per-app; static declarations and MCP bindings remain. */
export function resetOperationRouteProjections(): void {
  ROUTES_BY_ID.clear()
  ROUTES_BY_KEY.clear()
  for (const id of ROUTE_DERIVED_DECLARATION_IDS) {
    const declaration = DECLARED_BY_ID.get(id)
    if (declaration !== undefined) {
      DECLARED_BY_ROUTE.delete(routeKey(declaration.method, declaration.path))
    }
    DECLARED_BY_ID.delete(id)
  }
  ROUTE_DERIVED_DECLARATION_IDS.clear()
}
