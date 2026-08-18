// RFC-036 — permission catalog. Routes declare the points they need in their
// `registerRoute` metadata (backend routes/registry.ts) and the framework
// derives the gate from that declaration; roles are mapped to permission sets
// via ROLE_PERMISSIONS. To add a new role (auditor / viewer / team_lead etc.)
// we only add a new key to ROLE_PERMISSIONS — business code does not key off
// the role string.
//
// RFC-222 introduced the third role `manager` (中文「资源管理员」). RFC-305
// makes every role a pure permission preset: authorization code consumes
// only Actor.permissions, never the role string. Resource ACL bypass and the
// historical role exceptions are therefore explicit points in
// this same catalog instead of a parallel identity predicate.
//
// RFC-247 — the `资源:write` point is GONE. It used to cover POST/PUT/PATCH/
// DELETE alike (the `resourcePermissionGate` middleware, since deleted along
// with the whole legacy `backend/src/auth/permissions.ts` layer), which made
// "can modify but not delete" and "can create but not modify" inexpressible —
// exactly what a self-issued API token needs to express. Every matrix-domain
// resource now carries explicit `:create` / `:update` / `:delete` / `:execute`
// points, derived FROM THE REAL ROUTE INVENTORY rather than symmetrically
// filled in per resource type. Three verbs are deliberately absent because no
// route implements them (a startup self-check enforces this — see
// design/RFC-247-mcp-remote-access/design.md §3.2):
//
//   - `skills:execute`    — routes/skills.ts has no execute-semantics route
//   - `agents:execute`    — RFC-165 F15/N1 gates agent launch on tasks:execute
//   - `workgroups:execute`— …and workgroup launch likewise
//
// A declared-but-unrouted point is worse than a missing one: it shows up in the
// account page's token matrix and tells the user that ticking it grants a
// capability that does not exist.

import { z } from 'zod'

/**
 * RFC-247 — the resource types that appear on the token authorization matrix.
 * The matrix axis is `MATRIX_RESOURCES × verbs`; anything outside this list is
 * a system-domain point that a token NEVER carries (see SYSTEM_DOMAIN_POINTS).
 */
export const MATRIX_RESOURCES = [
  'agents',
  'skills',
  'mcps',
  'plugins',
  'workflows',
  'workgroups',
  // RFC-309 — one template type. The dangerous half (script and hook bodies,
  // which run as the daemon) is fenced by a FIELD-level `scripts:author` check
  // rather than by living in a second resource type, so this box may be ticked
  // without handing anyone the daemon.
  'capability-templates',
  'tasks',
  'scheduled-tasks',
  'repos',
  'memory',
] as const
export type MatrixResource = (typeof MATRIX_RESOURCES)[number]

/**
 * RFC-247 — the four verbs the user picks on the matrix. `read` is deliberately
 * NOT here: reads are always granted to any valid token (scoped by the row-level
 * ACL and by the range points below), so there is no read switch to tick.
 */
export const MATRIX_VERBS = ['create', 'update', 'delete', 'execute'] as const
export type MatrixVerb = (typeof MATRIX_VERBS)[number]

export const PERMISSIONS = [
  // ---------------------------------------------------------------------------
  // Matrix domain — read points. Always granted to a token ("read is on").
  // ---------------------------------------------------------------------------
  'agents:read',
  'skills:read',
  'mcps:read',
  'plugins:read',
  'workflows:read',
  'workgroups:read',
  // RFC-304 T57 — the two capability template layers.
  //
  // Both reads are ordinary matrix points, including the framework one: a group
  // lead has to see which frameworks exist, and what parameters each takes, to
  // bind one at all. What the read does NOT include is the script bodies —
  // those are redacted from anyone without `scripts:author` at serialization
  // time, the same shape as token redaction on plugins. Gating the whole read
  // instead would make the group layer unusable without handing out the
  // department layer, which is the split's entire purpose.
  'capability-templates:read',
  'scheduled-tasks:read',
  // RFC-260/RFC-283/RFC-305 — webhook 读面在 user 预设；写与跨 owner
  // 能力由具体权限组合决定。两个 read 点都在 USER_BASELINE
  // （触发器全量只读 + 端点/投递元数据只读——hook URL 明文另由响应分层保护：
  // 只有持有 webhook-endpoints:manage 的 session 请求拿明文，一切 PAT 拿掩码
  // hint，见 routes/webhookEndpoints.ts toWire）。owner 行级门另行约束。
  'webhook-triggers:read',
  // RFC-260 — 端点与投递审计共用的读点（投递是端点级审计，RFC-257 F-13；
  // replay/写面仍走 system 域的 webhook-endpoints:manage）。
  'webhook-endpoints:read',
  // RFC-310 — digital-employee configuration resources (five ACL types).
  'action-templates:read',
  'verification-profiles:read',
  'digital-employees:read',
  'automation-policies:read',
  'adapter-definitions:read',
  'repos:read',
  'memory:read',
  'tasks:read',
  // RANGE points — how far the ACCOUNT can see. They are account-level
  // permissions, not independently selectable token grants. Consumed by handlers via
  // `actor.permissions.has(...)` (routes/tasks.ts:183,188; clarify.ts:125,178;
  // reviews.ts:120,162), so they never appear in a RouteMeta — see
  // HANDLER_CONSUMED_POINTS below.
  'tasks:read:own',
  'tasks:read:all',
  // RFC-305 — account-level range point for owner/grant visibility on private
  // ACL resources. Public rows remain visible without it. `guest` deliberately
  // omits this point, so its six resource reads are public-only without any
  // role predicate in authorization code.
  'resource-acl:private',

  // ---------------------------------------------------------------------------
  // Matrix domain — create.
  // ---------------------------------------------------------------------------
  'agents:create',
  'skills:create',
  'mcps:create',
  'plugins:create',
  'workflows:create',
  'workgroups:create',
  // Framework writes are SYSTEM-domain (below): a framework carries scripts
  // that run as the daemon. Binding writes are ordinary matrix points.
  'capability-templates:create',
  'action-templates:create',
  'verification-profiles:create',
  'digital-employees:create',
  'automation-policies:create',
  'adapter-definitions:create',
  'scheduled-tasks:create',
  'webhook-triggers:create',
  'repos:create',
  'memory:create',
  // NOTE: no `tasks:create` — launching a task is an EXECUTE verb (RFC-247 D11).

  // ---------------------------------------------------------------------------
  // Matrix domain — update.
  // ---------------------------------------------------------------------------
  'agents:update',
  'skills:update',
  'mcps:update',
  'plugins:update',
  'workflows:update',
  'workgroups:update',
  'capability-templates:update',
  'action-templates:update',
  'verification-profiles:update',
  'digital-employees:update',
  'automation-policies:update',
  'adapter-definitions:update',
  // RFC-310 — assignments are repository configuration (repos:update tier).
  'repository-employee-assignments:read',
  'repository-employee-assignments:update',
  'scheduled-tasks:update',
  'webhook-triggers:update',
  'memory:update',
  'tasks:update',
  // RFC-248: `repos:update` 由 `PUT /api/repo-groups/:id` 引入——在此之前 repos
  // 域确实没有任何 PUT/PATCH 路由（那条 NOTE 曾在这里）。仓库组与 cached_repos
  // 同类，复用 repos:* 而不新增授权矩阵行（D5）。它**必须**同时进 MANAGER_EXTRA，
  // 否则 manager 能建组却改不了组、也无法给 PAT 授权（设计门 G4）。
  'repos:update',

  // ---------------------------------------------------------------------------
  // Matrix domain — delete. RFC-247 D4: every one of these must be ticked
  // EXPLICITLY on a token; none of them rides an account preset.
  // ---------------------------------------------------------------------------
  'agents:delete',
  'skills:delete',
  'mcps:delete',
  'plugins:delete',
  'workflows:delete',
  'workgroups:delete',
  'capability-templates:delete',
  'scheduled-tasks:delete',
  'webhook-triggers:delete',
  'repos:delete',
  'memory:delete',
  'tasks:delete',

  // RFC-310 — archive verb: these five types never hard-delete (immutable
  // revisions stay pinned by in-flight missions); archiving is the only
  // retirement, so the points are named :archive and NOT derived-listed with
  // DELETE_POINTS' explicit-tick rule.
  'action-templates:archive',
  'verification-profiles:archive',
  'digital-employees:archive',
  'automation-policies:archive',
  'adapter-definitions:archive',

  // ---------------------------------------------------------------------------
  // Matrix domain — execute.
  // ---------------------------------------------------------------------------
  'mcps:execute',
  'plugins:execute',
  'workflows:execute',
  'scheduled-tasks:execute',
  'repos:execute',
  // RFC-309 — starting a capability round from the platform (`POST
  // /api/code/rounds`). Deliberately NOT folded into `repos:write`: launching
  // spends model budget and writes to a code host, which is not the same act as
  // being allowed to change a repository's configuration, and should not be
  // granted as a side effect of it.
  'code-rounds:launch',
  'tasks:execute',
  // NOTE: no `skills:execute` — no execute-semantics route in the skills domain.
  //
  // NOTE: no `agents:execute` / `workgroups:execute` either. The only candidate
  // routes were `POST /api/{agents,workgroups}/:id/tasks`, and RFC-165 F15/N1
  // decided that launching is a TASK operation on every subject face: all three
  // launch endpoints gate uniformly on `tasks:execute`, with the agent path
  // explicitly EXEMPT from the agent method gate. Minting per-subject execute
  // points would reverse that decision AND leave two points no route
  // references — the "authorization UI lying to its user" failure this file
  // opens by warning about.
  //
  // RFC-247 also DELETES `tasks:cancel:own` / `tasks:cancel:all`. They were dead
  // points: `services/task.ts:2219` `cancelTask(db, id, opts)` takes no actor at
  // all, and a repo-wide grep finds zero references outside this file — already
  // recorded at docs/audit-backlog.md:62 ("`tasks:cancel:own/all` 零引用死点").
  // Cancel is an execute verb bounded by `canViewTask`, which is what the code
  // has always actually done.

  // ---------------------------------------------------------------------------
  // System domain — a token NEVER carries any of these (RFC-247 D7), not even
  // regardless of which access preset its owner uses.
  // ---------------------------------------------------------------------------
  'users:read',
  'users:write',
  'users:search',
  'settings:read',
  'settings:write',
  'oidc:read',
  'oidc:configure',
  'backup:run',
  'runtime:read',
  'account:self',
  // RFC-234 intent builder — explicitly out of the RFC-247 token surface.
  'intent:read',
  'intent:write',
  // RFC-253 — authoring the INLINE BODY of a script node, i.e. code the daemon
  // host will execute. It is not a CRUD verb on a resource domain (there is no
  // "script" resource — D1 keeps the body inline in the workflow), it is a
  // capability: "may cause arbitrary host execution". It therefore lives in the
  // system domain and never rides a token, so a leaked PAT with every matrix
  // grant still cannot write a script body.
  'scripts:author',
  // RFC-269 — authoring a code-host call node, i.e. deciding what the platform
  // does to GitLab/GitHub **with the platform-configured token**. Like
  // `scripts:author` it is a capability, not a CRUD verb on a resource domain
  // (there is no "code-host call" resource — the call is inline in the
  // workflow): "may act on the code host as the platform's bot identity, on any
  // repository that token can reach". Platform ACLs cannot bound that reach —
  // the permissions live on the code host, not here. System domain, so a leaked
  // PAT with every matrix grant still cannot write one.
  'code-host-calls:author',
  // RFC-257 (D19) — managing webhook ENDPOINTS (the verification secret and the
  // public URL token). Platform infrastructure, not a work resource: a leaked
  // PAT must never be able to read or rotate the ingress secret, so the point
  // is system-domain. It is absent from the user/manager default presets but
  // RFC-305 permits an explicit account grant; RFC-260 opened the read face
  // through webhook-endpoints:read.
  'webhook-endpoints:manage',
  // RFC-305 — capabilities that historically lived outside Permission as
  // admin/manager role predicates. Roles now select defaults only.
  'resource-acl:bypass',
  'memory-distill-jobs:manage',
  'intent:audit',
  'mcp-runtime-tests:audit',
  'webhook-triggers:override-owner',
] as const

export type Permission = (typeof PERMISSIONS)[number]
export type Role = 'admin' | 'user' | 'manager' | 'guest'

export const PermissionSchema = z.enum(PERMISSIONS)
export const RoleSchema = z.enum(['admin', 'user', 'manager', 'guest'])

// -----------------------------------------------------------------------------
// RFC-305 — exhaustive product/authorization catalog.
//
// PERMISSIONS remains the wire enum; this map is the mandatory metadata side of
// the same closed set.  User-management UI, API documentation and grant
// validation consume this object directly, so adding a permission cannot leave
// either dialog with a stale hand-written list.
// -----------------------------------------------------------------------------

export type PermissionDelegationMode = 'account-additive' | 'intrinsic'
export type PermissionRisk = 'standard' | 'elevated' | 'critical'
export type PermissionTokenMode = 'matrix' | 'account-range' | 'never'
export type PermissionGroup =
  | 'resources'
  | 'tasks'
  | 'memory-intent'
  | 'webhooks'
  | 'repositories'
  | 'privileged-authoring'
  | 'platform'

export type PermissionConstraint =
  | 'resource-acl'
  | 'task-membership'
  | 'task-global-range'
  | 'owner-or-override'

export type PermissionLabelKey = `permissions.catalog.${string}.label`
export type PermissionDescriptionKey = `permissions.catalog.${string}.description`

export interface PermissionCatalogEntry {
  readonly permission: Permission
  readonly group: PermissionGroup
  readonly labelKey: PermissionLabelKey
  readonly descriptionKey: PermissionDescriptionKey
  readonly delegation: PermissionDelegationMode
  readonly risk: PermissionRisk
  readonly token: PermissionTokenMode
  readonly constraints: ReadonlyArray<PermissionConstraint>
}

interface CatalogEntryOptions {
  readonly group: PermissionGroup
  readonly delegation?: PermissionDelegationMode
  readonly risk?: PermissionRisk
  readonly token?: PermissionTokenMode
  readonly constraints?: ReadonlyArray<PermissionConstraint>
}

function catalogEntry(
  permission: Permission,
  options: CatalogEntryOptions,
): PermissionCatalogEntry {
  const key = permission.replaceAll(':', '_')
  return Object.freeze({
    permission,
    group: options.group,
    labelKey: `permissions.catalog.${key}.label` as PermissionLabelKey,
    descriptionKey: `permissions.catalog.${key}.description` as PermissionDescriptionKey,
    delegation: options.delegation ?? 'account-additive',
    risk: options.risk ?? 'standard',
    token: options.token ?? 'matrix',
    constraints: Object.freeze([...(options.constraints ?? [])]),
  })
}

const resourceAcl = Object.freeze(['resource-acl'] as const)
const taskMembership = Object.freeze(['task-membership'] as const)
const taskGlobalRange = Object.freeze(['task-global-range'] as const)
const ownerOrOverride = Object.freeze(['owner-or-override'] as const)

const permissionCatalog = {
  'agents:read': catalogEntry('agents:read', { group: 'resources', constraints: resourceAcl }),
  'skills:read': catalogEntry('skills:read', { group: 'resources', constraints: resourceAcl }),
  'mcps:read': catalogEntry('mcps:read', { group: 'resources', constraints: resourceAcl }),
  'plugins:read': catalogEntry('plugins:read', { group: 'resources', constraints: resourceAcl }),
  'workflows:read': catalogEntry('workflows:read', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'workgroups:read': catalogEntry('workgroups:read', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'capability-templates:read': catalogEntry('capability-templates:read', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'action-templates:read': catalogEntry('action-templates:read', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'action-templates:create': catalogEntry('action-templates:create', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'action-templates:update': catalogEntry('action-templates:update', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'action-templates:archive': catalogEntry('action-templates:archive', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'verification-profiles:read': catalogEntry('verification-profiles:read', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'verification-profiles:create': catalogEntry('verification-profiles:create', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'verification-profiles:update': catalogEntry('verification-profiles:update', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'verification-profiles:archive': catalogEntry('verification-profiles:archive', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'digital-employees:read': catalogEntry('digital-employees:read', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'digital-employees:create': catalogEntry('digital-employees:create', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'digital-employees:update': catalogEntry('digital-employees:update', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'digital-employees:archive': catalogEntry('digital-employees:archive', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'automation-policies:read': catalogEntry('automation-policies:read', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'automation-policies:create': catalogEntry('automation-policies:create', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'automation-policies:update': catalogEntry('automation-policies:update', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'automation-policies:archive': catalogEntry('automation-policies:archive', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'adapter-definitions:read': catalogEntry('adapter-definitions:read', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'adapter-definitions:create': catalogEntry('adapter-definitions:create', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'adapter-definitions:update': catalogEntry('adapter-definitions:update', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'adapter-definitions:archive': catalogEntry('adapter-definitions:archive', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'repository-employee-assignments:read': catalogEntry('repository-employee-assignments:read', {
    group: 'repositories',
  }),
  'repository-employee-assignments:update': catalogEntry('repository-employee-assignments:update', {
    group: 'repositories',
  }),
  'scheduled-tasks:read': catalogEntry('scheduled-tasks:read', { group: 'tasks' }),
  'webhook-triggers:read': catalogEntry('webhook-triggers:read', { group: 'webhooks' }),
  'webhook-endpoints:read': catalogEntry('webhook-endpoints:read', { group: 'webhooks' }),
  'repos:read': catalogEntry('repos:read', { group: 'repositories' }),
  'memory:read': catalogEntry('memory:read', { group: 'memory-intent', constraints: resourceAcl }),
  'tasks:read': catalogEntry('tasks:read', { group: 'tasks', constraints: taskMembership }),
  'tasks:read:own': catalogEntry('tasks:read:own', {
    group: 'tasks',
    token: 'account-range',
    constraints: taskMembership,
  }),
  'tasks:read:all': catalogEntry('tasks:read:all', {
    group: 'tasks',
    risk: 'elevated',
    token: 'account-range',
    constraints: taskGlobalRange,
  }),
  'resource-acl:private': catalogEntry('resource-acl:private', {
    group: 'resources',
    token: 'account-range',
    constraints: resourceAcl,
  }),
  'agents:create': catalogEntry('agents:create', { group: 'resources', constraints: resourceAcl }),
  'skills:create': catalogEntry('skills:create', { group: 'resources', constraints: resourceAcl }),
  'mcps:create': catalogEntry('mcps:create', { group: 'resources', constraints: resourceAcl }),
  'plugins:create': catalogEntry('plugins:create', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'workflows:create': catalogEntry('workflows:create', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'workgroups:create': catalogEntry('workgroups:create', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'capability-templates:create': catalogEntry('capability-templates:create', {
    group: 'resources',
    risk: 'elevated',
    constraints: resourceAcl,
  }),
  'scheduled-tasks:create': catalogEntry('scheduled-tasks:create', { group: 'tasks' }),
  'webhook-triggers:create': catalogEntry('webhook-triggers:create', {
    group: 'webhooks',
    risk: 'elevated',
    constraints: ownerOrOverride,
  }),
  'repos:create': catalogEntry('repos:create', { group: 'repositories', risk: 'elevated' }),
  'memory:create': catalogEntry('memory:create', {
    group: 'memory-intent',
    constraints: resourceAcl,
  }),
  'agents:update': catalogEntry('agents:update', { group: 'resources', constraints: resourceAcl }),
  'skills:update': catalogEntry('skills:update', { group: 'resources', constraints: resourceAcl }),
  'mcps:update': catalogEntry('mcps:update', { group: 'resources', constraints: resourceAcl }),
  'plugins:update': catalogEntry('plugins:update', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'workflows:update': catalogEntry('workflows:update', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'workgroups:update': catalogEntry('workgroups:update', {
    group: 'resources',
    constraints: resourceAcl,
  }),
  'capability-templates:update': catalogEntry('capability-templates:update', {
    group: 'resources',
    risk: 'elevated',
    constraints: resourceAcl,
  }),
  'scheduled-tasks:update': catalogEntry('scheduled-tasks:update', { group: 'tasks' }),
  'webhook-triggers:update': catalogEntry('webhook-triggers:update', {
    group: 'webhooks',
    risk: 'elevated',
    constraints: ownerOrOverride,
  }),
  'memory:update': catalogEntry('memory:update', {
    group: 'memory-intent',
    constraints: resourceAcl,
  }),
  'tasks:update': catalogEntry('tasks:update', { group: 'tasks', constraints: taskMembership }),
  'repos:update': catalogEntry('repos:update', { group: 'repositories', risk: 'elevated' }),
  'agents:delete': catalogEntry('agents:delete', {
    group: 'resources',
    risk: 'elevated',
    constraints: resourceAcl,
  }),
  'skills:delete': catalogEntry('skills:delete', {
    group: 'resources',
    risk: 'elevated',
    constraints: resourceAcl,
  }),
  'mcps:delete': catalogEntry('mcps:delete', {
    group: 'resources',
    risk: 'elevated',
    constraints: resourceAcl,
  }),
  'plugins:delete': catalogEntry('plugins:delete', {
    group: 'resources',
    risk: 'elevated',
    constraints: resourceAcl,
  }),
  'workflows:delete': catalogEntry('workflows:delete', {
    group: 'resources',
    risk: 'elevated',
    constraints: resourceAcl,
  }),
  'workgroups:delete': catalogEntry('workgroups:delete', {
    group: 'resources',
    risk: 'elevated',
    constraints: resourceAcl,
  }),
  'capability-templates:delete': catalogEntry('capability-templates:delete', {
    group: 'resources',
    risk: 'elevated',
    constraints: resourceAcl,
  }),
  'scheduled-tasks:delete': catalogEntry('scheduled-tasks:delete', {
    group: 'tasks',
    risk: 'elevated',
  }),
  'webhook-triggers:delete': catalogEntry('webhook-triggers:delete', {
    group: 'webhooks',
    risk: 'critical',
    constraints: ownerOrOverride,
  }),
  'repos:delete': catalogEntry('repos:delete', { group: 'repositories', risk: 'critical' }),
  'memory:delete': catalogEntry('memory:delete', {
    group: 'memory-intent',
    risk: 'elevated',
    constraints: resourceAcl,
  }),
  'tasks:delete': catalogEntry('tasks:delete', {
    group: 'tasks',
    risk: 'critical',
  }),
  'mcps:execute': catalogEntry('mcps:execute', {
    group: 'resources',
    risk: 'elevated',
    constraints: resourceAcl,
  }),
  'plugins:execute': catalogEntry('plugins:execute', {
    group: 'resources',
    risk: 'elevated',
    constraints: resourceAcl,
  }),
  'workflows:execute': catalogEntry('workflows:execute', {
    group: 'resources',
    risk: 'elevated',
    constraints: resourceAcl,
  }),
  'scheduled-tasks:execute': catalogEntry('scheduled-tasks:execute', {
    group: 'tasks',
    risk: 'elevated',
  }),
  'repos:execute': catalogEntry('repos:execute', { group: 'repositories', risk: 'critical' }),
  'code-rounds:launch': catalogEntry('code-rounds:launch', {
    group: 'repositories',
    risk: 'elevated',
  }),
  'tasks:execute': catalogEntry('tasks:execute', {
    group: 'tasks',
    risk: 'elevated',
    constraints: taskMembership,
  }),
  'users:read': catalogEntry('users:read', {
    group: 'platform',
    token: 'never',
  }),
  'users:write': catalogEntry('users:write', {
    group: 'platform',
    risk: 'critical',
    token: 'never',
  }),
  'users:search': catalogEntry('users:search', { group: 'platform', token: 'never' }),
  'settings:read': catalogEntry('settings:read', {
    group: 'platform',
    token: 'never',
  }),
  'settings:write': catalogEntry('settings:write', {
    group: 'platform',
    risk: 'critical',
    token: 'never',
  }),
  'oidc:read': catalogEntry('oidc:read', {
    group: 'platform',
    token: 'never',
  }),
  'oidc:configure': catalogEntry('oidc:configure', {
    group: 'platform',
    risk: 'critical',
    token: 'never',
  }),
  'backup:run': catalogEntry('backup:run', {
    group: 'platform',
    risk: 'critical',
    token: 'never',
  }),
  'runtime:read': catalogEntry('runtime:read', { group: 'platform', token: 'never' }),
  'account:self': catalogEntry('account:self', {
    group: 'platform',
    delegation: 'intrinsic',
    token: 'never',
  }),
  'intent:read': catalogEntry('intent:read', { group: 'memory-intent', token: 'never' }),
  'intent:write': catalogEntry('intent:write', {
    group: 'memory-intent',
    risk: 'elevated',
    token: 'never',
  }),
  'scripts:author': catalogEntry('scripts:author', {
    group: 'privileged-authoring',
    risk: 'critical',
    token: 'never',
    constraints: resourceAcl,
  }),
  'code-host-calls:author': catalogEntry('code-host-calls:author', {
    group: 'privileged-authoring',
    risk: 'critical',
    token: 'never',
    constraints: resourceAcl,
  }),
  'webhook-endpoints:manage': catalogEntry('webhook-endpoints:manage', {
    group: 'webhooks',
    risk: 'critical',
    token: 'never',
  }),
  'resource-acl:bypass': catalogEntry('resource-acl:bypass', {
    group: 'platform',
    risk: 'critical',
    token: 'never',
  }),
  'memory-distill-jobs:manage': catalogEntry('memory-distill-jobs:manage', {
    group: 'memory-intent',
    risk: 'elevated',
    token: 'never',
  }),
  'intent:audit': catalogEntry('intent:audit', {
    group: 'memory-intent',
    risk: 'critical',
    token: 'never',
  }),
  'mcp-runtime-tests:audit': catalogEntry('mcp-runtime-tests:audit', {
    group: 'platform',
    risk: 'critical',
    token: 'never',
  }),
  'webhook-triggers:override-owner': catalogEntry('webhook-triggers:override-owner', {
    group: 'webhooks',
    risk: 'critical',
    token: 'never',
  }),
} satisfies Record<Permission, PermissionCatalogEntry>

export const PERMISSION_CATALOG: Readonly<Record<Permission, PermissionCatalogEntry>> =
  Object.freeze(permissionCatalog)

// -----------------------------------------------------------------------------
// RFC-247 — point classification. These are SELECTORS over PERMISSIONS (they
// overlap and do not jointly cover it), and they are the single source of truth
// for how a token's grant set is computed — see resolveTokenPermissions below.
//
// Declaration order matters: READ_POINTS and RANGE_POINTS are both derived by
// SUBTRACTING SYSTEM_DOMAIN_POINTS, so that set must exist first. An earlier
// draft hand-listed the system `:read` points to exclude and missed
// `intent:read`, which then rode into "reads a token always gets" — the exact
// class of silent widening this file is supposed to prevent.
// -----------------------------------------------------------------------------

/**
 * Points a token never carries, whatever its owner's role. Everything that
 * manages the platform itself rather than the work running on it.
 */
export const SYSTEM_DOMAIN_POINTS: ReadonlyArray<Permission> = [
  'users:read',
  'users:write',
  'users:search',
  'settings:read',
  'settings:write',
  'oidc:read',
  'oidc:configure',
  'backup:run',
  'runtime:read',
  'account:self',
  'intent:read',
  'intent:write',
  // RFC-253 — see the catalog entry: host code execution is a system-domain
  // capability, so no token may carry it (AC-26).
  'scripts:author',
  // RFC-309 — the template write points are NOT here, and that is the whole
  // design of the merge. RFC-304 put the framework writes in this list because
  // a framework WAS script bodies; a merged template is mostly agents, prompts
  // and parameters, and locking the object would have taken those away from
  // ordinary users along with the scripts.
  //
  // The dangerous half is fenced one level down instead: writing `scripts` or
  // `hooks` requires `scripts:author`, which IS still system-domain (above), so
  // a leaked PAT carrying every matrix grant still cannot author a script. What
  // it can do is change which agent a step uses — which is exactly the line the
  // two-layer split was drawing, now drawn around the fields that matter rather
  // than around the whole row.
  // RFC-269 — see the catalog entry: acting on the code host as the platform's
  // bot identity is a system-domain capability, so no token may carry it.
  'code-host-calls:author',
  // RFC-257 — see the catalog entry: the ingress secret surface never rides a token.
  'webhook-endpoints:manage',
  // RFC-305 — permissionized replacements for retired account-role predicates.
  'resource-acl:bypass',
  'memory-distill-jobs:manage',
  'intent:audit',
  'mcp-runtime-tests:audit',
  'webhook-triggers:override-owner',
]

/**
 * RFC-247 — RANGE points bound how far an ACCOUNT can see. They are account
 * permissions rather than independently selectable token grants, consumed by
 * handlers through `actor.permissions.has(...)` and therefore never appear in a
 * `RouteMeta`, so the startup reverse self-check (design §3.2) must treat them
 * as handler-consumed rather than dead. Every entry carries the file:line that
 * consumes it — without that rule this list degrades into the reverse check's
 * dustbin.
 */
export const RANGE_POINTS: ReadonlyArray<Permission> = [
  // routes/tasks.ts:183,188 · clarify.ts:125,178 · reviews.ts:120,162
  'tasks:read:all',
  // services/overview.ts — the "mine vs all" split
  'tasks:read:own',
  // services/resourceAcl.ts — owner/grant visibility for private ACL rows
  'resource-acl:private',
]

/**
 * Reads a token always gets, plus the range points that bound its reach.
 * Derived by subtraction from SYSTEM_DOMAIN_POINTS so a future system-domain
 * `:read` point cannot silently become a token grant.
 */
export const READ_POINTS: ReadonlyArray<Permission> = PERMISSIONS.filter(
  (p) => (p.endsWith(':read') || RANGE_POINTS.includes(p)) && !SYSTEM_DOMAIN_POINTS.includes(p),
)

/**
 * RFC-247 D4 — delete points must be named EXPLICITLY on a token. This replaces
 * RFC-222's hand-listed `PAT_EXPLICIT_ONLY_PERMISSIONS = ['tasks:delete']`:
 * deriving by suffix means a new resource type cannot silently widen a historical
 * token as the catalog grows.
 */
export const DELETE_POINTS: ReadonlyArray<Permission> = PERMISSIONS.filter((p) =>
  p.endsWith(':delete'),
)

/** Every matrix-domain point — i.e. everything a token can possibly hold. */
export const MATRIX_DOMAIN_POINTS: ReadonlyArray<Permission> = PERMISSIONS.filter(
  (p) => !SYSTEM_DOMAIN_POINTS.includes(p),
)

/**
 * RFC-247 §3.2 — the set the startup REVERSE self-check runs over: every point
 * here must be referenced by at least one `RouteMeta`, else the daemon refuses
 * to boot. Range points are excluded because handlers consume them directly
 * (see RANGE_POINTS); a dead point in the remainder would show up on the token
 * matrix as a capability that maps to no endpoint.
 */
export const ROUTE_BACKED_POINTS: ReadonlyArray<Permission> = MATRIX_DOMAIN_POINTS.filter(
  (p) => !RANGE_POINTS.includes(p),
)

// -----------------------------------------------------------------------------
// Role baselines. RFC-247 D15: EQUIVALENT to the pre-RFC-247 catalog — the
// shape of the points changed, the reach of each existing role did not.
// -----------------------------------------------------------------------------

// RFC-305 guest preset: only public rows from the six resource-ACL domains.
// No task, repository, memory, webhook, runtime or directory read is implied;
// `account:self` only keeps the authenticated account surface usable. Private
// visibility can be granted explicitly like any other preset difference.
const GUEST_BASELINE: ReadonlyArray<Permission> = [
  'agents:read',
  'skills:read',
  'mcps:read',
  'plugins:read',
  'workflows:read',
  'workgroups:read',
  'account:self',
]

const USER_RESOURCE_READS: ReadonlyArray<Permission> = [
  'agents:read',
  'skills:read',
  'mcps:read',
  'plugins:read',
  'workflows:read',
  'workgroups:read',
  // RFC-304 — both template layers are readable by any user. Binding one
  // requires seeing which frameworks exist; the script bodies inside them are
  // redacted from non-authors at serialization rather than by withholding the
  // whole read.
  'capability-templates:read',
  'action-templates:read',
  'verification-profiles:read',
  'digital-employees:read',
  'automation-policies:read',
  'adapter-definitions:read',
  'repository-employee-assignments:read',
  'scheduled-tasks:read',
  'repos:read',
  'runtime:read',
]

// RFC-099: any user may create the ACL'd resource types (creator becomes owner)
// and modify / delete the ones they own; the per-row check lives in
// services/resourceAcl.ts and these points are only the coarse method gate.
// RFC-247 splits the old `:write` into three, and adds the previously
// UNGATED domains (workgroups / schedules) at their real, current reach —
// they had no permission point at all, i.e. every logged-in user could use them.
const USER_RESOURCE_WRITES: ReadonlyArray<Permission> = [
  'agents:create',
  'agents:update',
  'agents:delete',
  'skills:create',
  'skills:update',
  'skills:delete',
  'mcps:create',
  'mcps:update',
  'mcps:delete',
  'plugins:create',
  'plugins:update',
  'plugins:delete',
  'workflows:create',
  'workflows:update',
  'workflows:delete',
  'workgroups:create',
  // RFC-309 — templates. Any user may create one and modify their own; the
  // per-row check is the resource ACL, as with every other type here. Script
  // and hook bodies inside a template are a separate, field-level gate
  // (`scripts:author`), so having this point does not confer them.
  'capability-templates:create',
  'capability-templates:update',
  'capability-templates:delete',
  // RFC-310 — same shape as capability templates: any user may create/own;
  // executable fields inside are a separate scripts:author field gate.
  'action-templates:create',
  'action-templates:update',
  'action-templates:archive',
  'verification-profiles:create',
  'verification-profiles:update',
  'verification-profiles:archive',
  'digital-employees:create',
  'digital-employees:update',
  'digital-employees:archive',
  'automation-policies:create',
  'automation-policies:update',
  'automation-policies:archive',
  'adapter-definitions:create',
  'adapter-definitions:update',
  'adapter-definitions:archive',
  'workgroups:update',
  'workgroups:delete',
  // Creating / editing a schedule arms a future launch, so it sat behind
  // `tasks:launch` (RFC-165 N1-r3) — which the user baseline has.
  'scheduled-tasks:create',
  'scheduled-tasks:update',
  'scheduled-tasks:delete',
]

// Execute points. Pre-RFC-247 these were reached either through `tasks:launch`
// (agent / workgroup task launches, schedule run-now) or through the resource's
// own `:write` (mcp probe, plugin check-update, workflow validate) — the user
// baseline had all of them.
const USER_EXECUTE: ReadonlyArray<Permission> = [
  'mcps:execute',
  'plugins:execute',
  'workflows:execute',
  'scheduled-tasks:execute',
  // RFC-309 — starting a capability round from a template. Sits with the other
  // execute-semantics points in the baseline rather than with `repos:execute`
  // (manager+): the act is "run this configured thing", the same shape as
  // running a workflow, and the whole point of the template merge is that an
  // ordinary group member can pick one and start work.
  'code-rounds:launch',
  'tasks:execute',
]

const USER_BASELINE: ReadonlyArray<Permission> = [
  ...USER_RESOURCE_READS,
  'resource-acl:private',
  ...USER_RESOURCE_WRITES,
  ...USER_EXECUTE,
  'users:search',
  'tasks:read',
  'tasks:read:own',
  'tasks:update',
  'account:self',
  // RFC-041 / RFC-099 / RFC-305: memory management is "scope-resource owner or
  // resource-acl:bypass", enforced per row by services/memory.ts canManageMemory.
  // RFC-247 folds the old approve/archive/edit/delete/write_feedback points
  // into the four verbs; the reach is unchanged.
  'memory:read',
  'memory:create',
  'memory:update',
  'memory:delete',
  // RFC-234 (D22): intent building is open to all users.
  'intent:read',
  'intent:write',
  // RFC-260/RFC-283/RFC-305 — webhook 读面全员开放；触发规则写面在 manager
  // 预设中默认开启，端点管理是可单独授予的显式能力。
  'webhook-triggers:read',
  'webhook-endpoints:read',
]

// RFC-222/RFC-305 — manager's extra permission preset over the user baseline.
// Every historical bypass is an explicit point; there is no role predicate.
const MANAGER_EXTRA: ReadonlyArray<Permission> = [
  'resource-acl:bypass',
  'memory-distill-jobs:manage',
  // RFC-253/RFC-305 — script authoring is present in this preset and can also
  // be granted explicitly to any account. The system domain bounds the TOKEN
  // surface, not the account-grant surface.
  'scripts:author',
  // RFC-309 — template writes moved to the user baseline; what stays here is
  // `scripts:author` above, which is what actually governs the script bodies.
  // RFC-269/RFC-305 — same shape as script authoring: preset default plus
  // explicit account grant; never available to PATs.
  'code-host-calls:author',
  // RFC-283 — manager 可创建触发规则，并仅修改/删除自己名下的规则。
  // 这三个点只是方法粗门，owner 边界由 webhookTriggers 路由逐行判定。
  'webhook-triggers:create',
  'webhook-triggers:update',
  'webhook-triggers:delete',
  'repos:create',
  'repos:update', // RFC-248 D5/G4 —— 仓库组走 repos:* 这一档
  'repository-employee-assignments:update', // RFC-310 —— 与 repos:update 同档
  'repos:delete',
  'repos:execute',
  'tasks:read:all',
]

export const ROLE_PERMISSIONS: Record<Role, ReadonlyArray<Permission>> = {
  admin: [...PERMISSIONS],
  user: USER_BASELINE,
  manager: [...USER_BASELINE, ...MANAGER_EXTRA],
  guest: GUEST_BASELINE,
}

export const INTRINSIC_PERMISSIONS: ReadonlyArray<Permission> = Object.freeze(
  PERMISSIONS.filter((permission) => PERMISSION_CATALOG[permission].delegation === 'intrinsic'),
)

export type AdditionalPermissionValidationCode =
  | 'user-permission-invalid'
  | 'user-permission-not-grantable'
  | 'user-permission-redundant'
  | 'user-permission-duplicate'

export class AdditionalPermissionValidationError extends Error {
  readonly code: AdditionalPermissionValidationCode
  readonly permission: unknown

  constructor(code: AdditionalPermissionValidationCode, permission: unknown) {
    super(code)
    this.name = 'AdditionalPermissionValidationError'
    this.code = code
    this.permission = permission
  }
}

export interface StoredPermissionDiagnostic {
  readonly code: AdditionalPermissionValidationCode
  readonly permission: unknown
}

/** RFC-305 — strict normalization used by every write boundary. */
export function normalizeAdditionalPermissionsForWrite(input: {
  readonly role: Role
  readonly additionalPermissions: ReadonlyArray<unknown>
}): ReadonlyArray<Permission> {
  const baseline = new Set(ROLE_PERMISSIONS[input.role])
  const seen = new Set<Permission>()
  const normalized: Permission[] = []

  for (const raw of input.additionalPermissions) {
    const parsed = PermissionSchema.safeParse(raw)
    if (!parsed.success) {
      throw new AdditionalPermissionValidationError('user-permission-invalid', raw)
    }
    const permission = parsed.data
    if (seen.has(permission)) {
      throw new AdditionalPermissionValidationError('user-permission-duplicate', permission)
    }
    seen.add(permission)
    if (PERMISSION_CATALOG[permission].delegation !== 'account-additive') {
      throw new AdditionalPermissionValidationError('user-permission-not-grantable', permission)
    }
    if (baseline.has(permission)) {
      throw new AdditionalPermissionValidationError('user-permission-redundant', permission)
    }
    normalized.push(permission)
  }

  return Object.freeze(PERMISSIONS.filter((permission) => normalized.includes(permission)))
}

/**
 * RFC-305 — fail-closed normalization for persisted rows. Invalid, intrinsic,
 * duplicate and now-redundant rows never widen authority; callers
 * receive diagnostics so operators can repair data without making auth depend
 * on successful cleanup.
 */
export function normalizeStoredAdditionalPermissions(input: {
  readonly role: Role
  readonly additionalPermissions: ReadonlyArray<unknown>
}): {
  readonly additionalPermissions: ReadonlyArray<Permission>
  readonly diagnostics: ReadonlyArray<StoredPermissionDiagnostic>
} {
  const baseline = new Set(ROLE_PERMISSIONS[input.role])
  const seen = new Set<Permission>()
  const normalized = new Set<Permission>()
  const diagnostics: StoredPermissionDiagnostic[] = []

  for (const raw of input.additionalPermissions) {
    const parsed = PermissionSchema.safeParse(raw)
    if (!parsed.success) {
      diagnostics.push({ code: 'user-permission-invalid', permission: raw })
      continue
    }
    const permission = parsed.data
    if (seen.has(permission)) {
      diagnostics.push({ code: 'user-permission-duplicate', permission })
      continue
    }
    seen.add(permission)
    if (PERMISSION_CATALOG[permission].delegation !== 'account-additive') {
      diagnostics.push({ code: 'user-permission-not-grantable', permission })
      continue
    }
    if (baseline.has(permission)) {
      diagnostics.push({ code: 'user-permission-redundant', permission })
      continue
    }
    normalized.add(permission)
  }

  return {
    additionalPermissions: Object.freeze(
      PERMISSIONS.filter((permission) => normalized.has(permission)),
    ),
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
  }
}

/** The only account-authority union formula used by backend and frontend. */
export function resolveEffectiveAccountPermissions(input: {
  readonly role: Role
  readonly additionalPermissions: ReadonlyArray<unknown>
}): ReadonlySet<Permission> {
  const additional = normalizeAdditionalPermissionsForWrite(input)
  return new Set([...ROLE_PERMISSIONS[input.role], ...additional])
}

/** UI/API derivation — every non-intrinsic point outside the preset is grantable. */
export function grantableAdditionalPermissions(role: Role): ReadonlyArray<Permission> {
  const baseline = new Set(ROLE_PERMISSIONS[role])
  return PERMISSIONS.filter(
    (permission) =>
      PERMISSION_CATALOG[permission].delegation === 'account-additive' && !baseline.has(permission),
  )
}

/**
 * Rebase explicitly selected additions onto a new role. Promotion removes
 * redundant rows and downgrade never resurrects a permission that was not
 * selected as an additional grant.
 */
export function additionalPermissionsForRole(
  role: Role,
  selectedEffectivePermissions: ReadonlySet<Permission>,
): ReadonlyArray<Permission> {
  const baseline = new Set(ROLE_PERMISSIONS[role])
  return Object.freeze(
    PERMISSIONS.filter(
      (permission) =>
        selectedEffectivePermissions.has(permission) &&
        PERMISSION_CATALOG[permission].delegation === 'account-additive' &&
        !baseline.has(permission),
    ),
  )
}

/** Preset membership helper. Authorization consumers must inspect effective permissions instead. */
export function presetHasPermission(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm)
}

/** Snapshot helper: points absent from the default `user` preset, all individually grantable. */
export const USER_PRESET_MISSING_PERMISSIONS: ReadonlyArray<Permission> = PERMISSIONS.filter(
  (p) => !USER_BASELINE.includes(p),
)

/**
 * Snapshot helper: points absent from the default `manager` preset. They remain
 * individually grantable; this list describes defaults, not an authorization class.
 */
export const MANAGER_PRESET_MISSING_PERMISSIONS: ReadonlyArray<Permission> = [
  'users:read',
  'users:write',
  'settings:read',
  'settings:write',
  'oidc:read',
  'oidc:configure',
  'backup:run',
  'tasks:delete',
  'webhook-endpoints:manage',
  'intent:audit',
  'mcp-runtime-tests:audit',
  'webhook-triggers:override-owner',
]

// -----------------------------------------------------------------------------
// RFC-247 — token grant resolution. THE formula; auth/actor.ts calls this and
// does not reimplement any part of it.
// -----------------------------------------------------------------------------

export interface ResolveTokenPermissionsInput {
  /** Current preset baseline + valid per-account grants, already resolved. */
  readonly accountPermissions: ReadonlySet<Permission>
  /** The matrix the user ticked when creating the token. May be empty (= read-only). */
  readonly matrix: ReadonlyArray<Permission>
}

/**
 * RFC-247 §2.2:
 *
 *   (READ_POINTS ∪ matrix) ∩ effectiveAccountPermissions \ SYSTEM_DOMAIN_POINTS
 *                                                         \ (DELETE_POINTS \ matrix)
 *
 * Three invariants this encodes, each of which has a regression test:
 *
 *  1. **Reads are always on.** An empty matrix yields a read-only token rather
 *     than — as the pre-RFC-247 `patScopes.length > 0` short-circuit did — a
 *     token holding the owner's ENTIRE account authority (docs/audit-backlog.md:62).
 *  2. **A token never exceeds its owner's effective permissions.**
 *  3. **Delete is opt-in per point.** A delete point the matrix does not name is
 *     stripped even though the account can hold it (RFC-247 D4).
 */
export function resolveTokenPermissions(input: ResolveTokenPermissionsInput): Set<Permission> {
  const ticked = new Set(input.matrix)
  const out = new Set<Permission>()

  for (const p of READ_POINTS) if (input.accountPermissions.has(p)) out.add(p)
  for (const p of ticked) if (input.accountPermissions.has(p)) out.add(p)

  for (const p of SYSTEM_DOMAIN_POINTS) out.delete(p)
  for (const p of DELETE_POINTS) if (!ticked.has(p)) out.delete(p)

  return out
}

/**
 * RFC-247/RFC-305 — the matrix points the current account may tick. The account page only
 * renders points in its effective permission set,
 * and token creation rejects anything outside this set with 422 rather than
 * silently dropping it (AC-7).
 */
export function grantableMatrixPoints(
  accountPermissions: ReadonlySet<Permission>,
): ReadonlyArray<Permission> {
  return MATRIX_DOMAIN_POINTS.filter(
    (permission) => accountPermissions.has(permission) && !READ_POINTS.includes(permission),
  )
}
