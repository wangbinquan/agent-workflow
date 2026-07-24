// RFC-054 W1-2 — API contract registry.
//
// Every endpoint mounted under `packages/backend/src/routes/*.ts` must
// appear in `ENDPOINTS` below. The coverage-guard test
// (`api-contract-coverage.test.ts`) greps the routes/*.ts sources and asserts
// no method+path appears in production that is missing here. New routes that
// land without a registry entry → CI red.
//
// Each entry can also declare:
//   - `public: true`          — public route; multiAuth skips it (no 401 case).
//   - `happy: HappyFixture`   — request fixture the contract test runs and
//                               schema-validates the 2xx response against.
//
// Without `happy`, an entry still gets:
//   - a 401 case (if not public) confirming the auth gate.
//   - the coverage-guard sanity check that it is registered.
//
// W1-2 deliberately keeps the happy-path coverage to a curated subset.
// Follow-ups (Wave 2 / Wave 3) can layer in detailed Zod schemas for the
// remaining ~110 endpoints incrementally — adding `happy: {...}` to an
// existing entry is non-breaking.

import { z } from 'zod'
import {
  AgentSchema,
  ErrorResponseSchema,
  ImportWorkflowResultSchema,
  McpSchema,
  OverviewResponseSchema,
  SkillSchema,
  WorkgroupSchema,
  WorkflowDetailSchema,
  WorkflowDraftValidationReceiptSchema,
  WorkflowValidationReceiptSchema,
  serializeWorkflowDefinitionCandidateV1,
} from '@agent-workflow/shared'
import { createHash } from 'node:crypto'
import type { ContractHarness } from './harness'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

export interface HappyFixture {
  /** Static path-param overrides, e.g. `{ id: '01...' }` for `/api/x/:id`. */
  pathParams?: Record<string, string> | ((h: ContractHarness) => Record<string, string>)
  /** Static query string. */
  query?: Record<string, string>
  /** Static or dynamic body. */
  body?: unknown | ((h: ContractHarness) => unknown | Promise<unknown>)
  /** Extra headers (e.g. `content-type: multipart/form-data`). Auth is added. */
  headers?: Record<string, string>
  /** Expected HTTP status. Defaults to 200. */
  status?: number
  /** Schema the response body must satisfy. Defaults to a permissive z.unknown(). */
  schema?: z.ZodType
  /** Skip happy assertion with a reason — useful for endpoints whose happy
   *  path requires complex side-effect seeds we haven't built yet. */
  skipHappy?: string
}

export interface EndpointSpec {
  method: HttpMethod
  path: string
  /** true → multiAuth bypasses; no 401 case generated. Default: false. */
  public?: boolean
  happy?: HappyFixture
}

// ----------------------------------------------------------------------------
// Permissive shape used as the default happy schema — every endpoint at least
// returns a JSON object (or array). When detailed schemas are added in later
// PRs, override this on the relevant entry.
// ----------------------------------------------------------------------------
const JsonValue: z.ZodType = z.unknown()

// ----------------------------------------------------------------------------
// Registry. Keep ordered by route file then path for readability.
// ----------------------------------------------------------------------------
export const ENDPOINTS: EndpointSpec[] = [
  // ---- health ----
  {
    method: 'GET',
    path: '/health',
    public: true,
    happy: {
      schema: z
        .object({
          ok: z.literal(true),
          opencodeVersion: z.string().nullable(),
          dbVersion: z.number(),
          uptime: z.number(),
          runningTasks: z.number(),
        })
        .passthrough(),
    },
  },

  // ---- auth (RFC-036) ----
  { method: 'POST', path: '/api/auth/login', public: true },
  { method: 'GET', path: '/api/auth/bootstrap/status' },
  { method: 'POST', path: '/api/auth/bootstrap/admin' },
  { method: 'POST', path: '/api/auth/logout' },
  { method: 'GET', path: '/api/auth/me' },
  { method: 'POST', path: '/api/auth/change-password' },
  { method: 'GET', path: '/api/auth/sessions' },
  { method: 'POST', path: '/api/auth/sessions/:id/revoke' },
  { method: 'GET', path: '/api/auth/pats' },
  { method: 'POST', path: '/api/auth/pats' },
  { method: 'DELETE', path: '/api/auth/pats/:id' },
  { method: 'GET', path: '/api/auth/identities' },
  { method: 'DELETE', path: '/api/auth/identities/:id' },

  // ---- oidc-auth (mixed: providers list + login flow are public) ----
  { method: 'GET', path: '/api/auth/oidc/providers', public: true },
  { method: 'POST', path: '/api/auth/oidc/:slug/login/start', public: true },
  { method: 'GET', path: '/api/auth/oidc/:slug/callback', public: true },

  // ---- oidc (admin) ----
  { method: 'GET', path: '/api/oidc/login-policy' },
  { method: 'PUT', path: '/api/oidc/login-policy' },
  { method: 'GET', path: '/api/oidc/providers' },
  { method: 'POST', path: '/api/oidc/providers' },
  { method: 'GET', path: '/api/oidc/providers/:id' },
  { method: 'PATCH', path: '/api/oidc/providers/:id' },
  { method: 'DELETE', path: '/api/oidc/providers/:id' },
  { method: 'POST', path: '/api/oidc/providers/:id/test' },

  // ---- agents ----
  {
    method: 'GET',
    path: '/api/agents',
    happy: { schema: z.array(z.any()) },
  },
  {
    method: 'GET',
    path: '/api/agents/:id',
    happy: {
      pathParams: (h) => ({ id: h.fixtures.agentId }),
      schema: AgentSchema,
    },
  },
  { method: 'GET', path: '/api/agents/builtins/skill-merger' },
  { method: 'POST', path: '/api/agents' },
  { method: 'POST', path: '/api/agents/import-resolve' },
  { method: 'PUT', path: '/api/agents/:id' },
  { method: 'DELETE', path: '/api/agents/:id' },
  { method: 'POST', path: '/api/agents/:id/rename' },
  // RFC-165 §4: single-agent launch (service-level entry; tasks:launch gate).
  { method: 'POST', path: '/api/agents/:id/tasks' },
  {
    method: 'GET',
    path: '/api/agents/:id/closure',
    happy: {
      pathParams: (h) => ({ id: h.fixtures.agentId }),
      schema: z.object({ ok: z.literal(true) }).passthrough(),
    },
  },
  { method: 'POST', path: '/api/agents/closure-preview' },

  // ---- mcps (RFC-028) ----
  {
    method: 'GET',
    path: '/api/mcps',
    happy: { schema: z.array(z.any()) },
  },
  {
    method: 'GET',
    path: '/api/mcps/:id',
    happy: {
      pathParams: (h) => ({ id: h.fixtures.mcpId }),
      schema: McpSchema,
    },
  },
  { method: 'POST', path: '/api/mcps' },
  { method: 'PUT', path: '/api/mcps/:id' },
  { method: 'DELETE', path: '/api/mcps/:id' },
  { method: 'POST', path: '/api/mcps/:id/rename' },
  { method: 'GET', path: '/api/mcps/probes' },
  { method: 'GET', path: '/api/mcps/:id/probe' },
  { method: 'POST', path: '/api/mcps/:id/probe' },

  // ---- plugins (RFC-031) ----
  {
    method: 'GET',
    path: '/api/plugins',
    happy: { schema: z.array(z.any()) },
  },
  { method: 'GET', path: '/api/plugins/:id' },
  { method: 'POST', path: '/api/plugins' },
  { method: 'PUT', path: '/api/plugins/:id' },
  { method: 'DELETE', path: '/api/plugins/:id' },
  { method: 'POST', path: '/api/plugins/:id/rename' },
  { method: 'POST', path: '/api/plugins/:id/check-update' },
  { method: 'POST', path: '/api/plugins/:id/upgrade' },

  // ---- skills ----
  {
    method: 'GET',
    path: '/api/skills',
    happy: { schema: z.array(z.any()) },
  },
  {
    method: 'GET',
    path: '/api/skills/:id',
    happy: {
      pathParams: (h) => ({ id: h.fixtures.skillId }),
      schema: SkillSchema,
    },
  },
  { method: 'POST', path: '/api/skills' },
  { method: 'PUT', path: '/api/skills/:id' },
  { method: 'DELETE', path: '/api/skills/:id' },
  { method: 'GET', path: '/api/skills/:id/content' },
  { method: 'PUT', path: '/api/skills/:id/content' },
  { method: 'POST', path: '/api/skills/:id/save' }, // RFC-170 T4 combined-save (token OCC)
  { method: 'GET', path: '/api/skills/:id/files' },
  { method: 'GET', path: '/api/skills/:id/file' },
  { method: 'PUT', path: '/api/skills/:id/file' },
  { method: 'DELETE', path: '/api/skills/:id/file' },
  { method: 'POST', path: '/api/skills/import-zip/parse' },
  { method: 'POST', path: '/api/skills/import-zip/commit' },
  // RFC-101: skill content version history.
  { method: 'GET', path: '/api/skills/:id/versions' },
  { method: 'GET', path: '/api/skills/:id/versions/diff' },
  { method: 'GET', path: '/api/skills/:id/versions/:v/content' },
  { method: 'POST', path: '/api/skills/:id/versions/:v/restore' },

  // ---- fusions (RFC-101 memory→skill fusion) ----
  { method: 'POST', path: '/api/fusions' },
  { method: 'GET', path: '/api/fusions' },
  { method: 'GET', path: '/api/fusions/pending-count' },
  { method: 'GET', path: '/api/fusions/:id' },
  { method: 'POST', path: '/api/fusions/:id/approve' },
  { method: 'POST', path: '/api/fusions/:id/reject' },
  { method: 'POST', path: '/api/fusions/:id/cancel' },

  // ---- workflows ----
  {
    method: 'GET',
    path: '/api/workflows',
    happy: { schema: z.array(z.any()) },
  },
  {
    method: 'GET',
    path: '/api/workflows/:id',
    happy: {
      pathParams: (h) => ({ id: h.fixtures.workflowId }),
      schema: WorkflowDetailSchema,
    },
  },
  {
    method: 'POST',
    path: '/api/workflows',
    happy: {
      body: {
        name: 'contract-created-workflow',
        description: '',
        definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
      },
      status: 201,
      schema: WorkflowDetailSchema,
    },
  },
  { method: 'PUT', path: '/api/workflows/:id' },
  { method: 'DELETE', path: '/api/workflows/:id' },
  {
    method: 'POST',
    path: '/api/workflows/:id/validate',
    happy: {
      pathParams: (h) => ({ id: h.fixtures.workflowId }),
      body: (h: ContractHarness) => ({
        expectedVersion: h.fixtures.workflowVersion,
        expectedSnapshotHash: h.fixtures.workflowSnapshotHash,
      }),
      schema: WorkflowValidationReceiptSchema,
    },
  },
  {
    method: 'POST',
    path: '/api/workflows/:id/validate-draft',
    happy: {
      pathParams: (h) => ({ id: h.fixtures.workflowId }),
      body: () => {
        const definition = { $schema_version: 4 as const, inputs: [], nodes: [], edges: [] }
        return {
          definition,
          claimedCandidateHash: createHash('sha256')
            .update(serializeWorkflowDefinitionCandidateV1(definition), 'utf8')
            .digest('hex'),
        }
      },
      schema: WorkflowDraftValidationReceiptSchema,
    },
  },
  { method: 'GET', path: '/api/workflows/:id/export' },
  {
    method: 'POST',
    path: '/api/workflows/import',
    happy: {
      body: {
        mode: 'new',
        yamlText:
          "name: contract-imported-workflow\ndescription: ''\ndefinition:\n  $schema_version: 4\n  inputs: []\n  nodes: []\n  edges: []\n",
      },
      status: 201,
      schema: ImportWorkflowResultSchema,
    },
  },

  // ---- workgroups (RFC-164) ----
  {
    method: 'GET',
    path: '/api/workgroups',
    happy: { schema: z.array(z.any()) },
  },
  {
    method: 'GET',
    path: '/api/workgroups/:id',
    happy: {
      pathParams: (h) => ({ id: h.fixtures.workgroupId }),
      schema: WorkgroupSchema,
    },
  },
  { method: 'POST', path: '/api/workgroups' },
  { method: 'PUT', path: '/api/workgroups/:id' },
  { method: 'DELETE', path: '/api/workgroups/:id' },
  { method: 'POST', path: '/api/workgroups/:id/rename' },
  { method: 'POST', path: '/api/workgroups/:id/tasks' },
  { method: 'GET', path: '/api/workgroup-tasks/pending-count' },
  { method: 'GET', path: '/api/workgroup-tasks/:taskId/room' },
  { method: 'POST', path: '/api/workgroup-tasks/:taskId/messages' },
  { method: 'POST', path: '/api/workgroup-tasks/:taskId/assignments/:id/cancel' },
  { method: 'POST', path: '/api/workgroup-tasks/:taskId/assignments/:id/deliver' },
  { method: 'POST', path: '/api/workgroup-tasks/:taskId/confirm' },
  { method: 'PUT', path: '/api/workgroup-tasks/:taskId/config' },
  // RFC-167 — dynamic-workflow confirm gate + one-shot save-as
  { method: 'POST', path: '/api/workgroup-tasks/:taskId/dw-confirm' },
  { method: 'POST', path: '/api/workgroup-tasks/:taskId/dw-save-as-workflow' },

  // ---- repos (path / refs / file system) ----
  { method: 'GET', path: '/api/repos/files' },
  { method: 'GET', path: '/api/repos/refs' },

  // ---- cached-repos (RFC-024 / RFC-033) ----
  { method: 'GET', path: '/api/cached-repos' },
  { method: 'POST', path: '/api/cached-repos/:id/refresh' },
  { method: 'DELETE', path: '/api/cached-repos/:id' },
  { method: 'POST', path: '/api/cached-repos/batch-import' },
  { method: 'GET', path: '/api/cached-repos/imports/:batchId' },
  { method: 'POST', path: '/api/cached-repos/imports/:batchId/rows/:rowId/retry' },

  // ---- tasks ----
  {
    method: 'GET',
    path: '/api/tasks',
    happy: { schema: z.array(z.any()) },
  },
  {
    method: 'GET',
    path: '/api/tasks/:id',
    happy: {
      pathParams: (h) => ({ id: h.fixtures.taskId }),
      schema: z.object({ task: z.any() }).passthrough(),
    },
  },
  { method: 'POST', path: '/api/tasks' },
  // RFC-222 — admin-only hard delete (tasks:delete + type-to-confirm body).
  { method: 'DELETE', path: '/api/tasks/:id' },
  { method: 'POST', path: '/api/tasks/:id/cancel' },
  { method: 'POST', path: '/api/tasks/:id/resume' },
  // RFC-109 — workflow re-sync
  { method: 'GET', path: '/api/tasks/:id/workflow-sync-preview' },
  { method: 'POST', path: '/api/tasks/:id/sync-workflow' },
  { method: 'POST', path: '/api/tasks/:id/diagnose' },
  { method: 'GET', path: '/api/tasks/:id/alerts' },
  // RFC-108 T3: per-task system-recovery audit trail.
  { method: 'GET', path: '/api/tasks/:id/recovery-events' },
  // RFC-108 T11: clear an auto-recovery quarantine.
  { method: 'POST', path: '/api/tasks/:id/clear-recovery-suspension' },
  // RFC-057: Diagnose-Panel repair options.
  { method: 'GET', path: '/api/tasks/:id/alerts/:alertId/repair-options' },
  { method: 'POST', path: '/api/tasks/:id/alerts/:alertId/repair' },
  { method: 'GET', path: '/api/tasks/:id/diff' },
  // ---- scheduled tasks (RFC-159) ----
  { method: 'GET', path: '/api/scheduled-tasks' },
  { method: 'GET', path: '/api/scheduled-tasks/:id' },
  { method: 'POST', path: '/api/scheduled-tasks' },
  { method: 'PUT', path: '/api/scheduled-tasks/:id' },
  { method: 'DELETE', path: '/api/scheduled-tasks/:id' },
  { method: 'POST', path: '/api/scheduled-tasks/:id/run-now' },
  { method: 'GET', path: '/api/tasks/:id/structural-diff' },
  { method: 'GET', path: '/api/tasks/:id/call-targets' },
  { method: 'GET', path: '/api/tasks/:id/node-runs' },
  { method: 'GET', path: '/api/tasks/:id/node-runs/:nodeRunId/events' },
  { method: 'GET', path: '/api/tasks/:id/node-runs/:nodeRunId/inventory' },
  { method: 'GET', path: '/api/tasks/:id/node-runs/:nodeRunId/session' },
  { method: 'GET', path: '/api/tasks/:id/nodes/:nodeRunId/stdout' },
  { method: 'POST', path: '/api/tasks/:id/nodes/:nodeRunId/retry' },
  // RFC-099 (D6): the per-node assignments endpoint was removed — task
  // membership is the answer-rights boundary. Members panel replaces it.
  { method: 'GET', path: '/api/tasks/:id/members' },
  { method: 'PUT', path: '/api/tasks/:id/members' },
  // RFC-065: task detail page "工作目录" tab — list + read worktree files.
  { method: 'GET', path: '/api/tasks/:id/worktree-tree' },
  { method: 'GET', path: '/api/tasks/:id/worktree-file' },

  // ---- worktree-files ----
  { method: 'GET', path: '/api/worktree-files/:taskId' },
  { method: 'GET', path: '/api/worktree-files/:taskId/*' },
  // ---- port-artifacts (RFC-193) ----
  { method: 'GET', path: '/api/tasks/:taskId/port-artifacts/:nodeRunId/:portName' },

  // ---- reviews (RFC-005) ----
  { method: 'GET', path: '/api/reviews' },
  { method: 'GET', path: '/api/reviews/pending-count' },
  { method: 'GET', path: '/api/reviews/:nodeRunId' },
  { method: 'GET', path: '/api/reviews/:nodeRunId/versions' },
  { method: 'GET', path: '/api/reviews/:nodeRunId/versions/:versionId' },
  // RFC-142: multi-doc round history (list expand + read-only historical-round view).
  { method: 'GET', path: '/api/reviews/:nodeRunId/rounds' },
  { method: 'POST', path: '/api/reviews/:nodeRunId/decision' },
  { method: 'POST', path: '/api/reviews/:nodeRunId/comments' },
  { method: 'PATCH', path: '/api/reviews/:nodeRunId/comments/:commentId' },
  { method: 'DELETE', path: '/api/reviews/:nodeRunId/comments/:commentId' },
  // RFC-079: multi-document review per-item selection.
  { method: 'PATCH', path: '/api/reviews/:nodeRunId/documents/:docVersionId/selection' },

  // ---- clarify (RFC-023) ----
  { method: 'GET', path: '/api/clarify' },
  { method: 'GET', path: '/api/clarify/pending-count' },
  { method: 'GET', path: '/api/clarify/:nodeRunId' },
  { method: 'POST', path: '/api/clarify/:nodeRunId/answers' },
  // RFC-099 (D8): collaborative per-question answer draft.
  { method: 'PUT', path: '/api/clarify/:nodeRunId/draft' },

  // ---- task question list / 任务中心 (RFC-120) ----
  { method: 'GET', path: '/api/tasks/:id/questions' },
  { method: 'POST', path: '/api/tasks/:id/questions/manual' },
  { method: 'POST', path: '/api/tasks/:id/questions/:entryId/confirm' },
  { method: 'POST', path: '/api/tasks/:id/questions/:entryId/reassign' },
  { method: 'POST', path: '/api/tasks/:id/questions/:entryId/stage' },
  { method: 'POST', path: '/api/tasks/:id/questions/dispatch' },

  // ---- per-(task, asking-node) clarify directive toggle (RFC-122) ----
  { method: 'GET', path: '/api/tasks/:id/clarify-directives' },
  { method: 'POST', path: '/api/tasks/:id/nodes/:nodeId/clarify-directive' },

  // ---- memories (RFC-041 / RFC-043 / RFC-045) ----
  { method: 'GET', path: '/api/memories' },
  { method: 'POST', path: '/api/memories' },
  { method: 'GET', path: '/api/memories/:id' },
  { method: 'PATCH', path: '/api/memories/:id' },
  { method: 'DELETE', path: '/api/memories/:id' },
  { method: 'POST', path: '/api/memories/:id/archive' },
  { method: 'POST', path: '/api/memories/:id/unarchive' },
  { method: 'POST', path: '/api/memories/:id/promote' },

  // ---- memory-distill-jobs (RFC-043) ----
  { method: 'GET', path: '/api/memory-distill-jobs' },
  { method: 'GET', path: '/api/memory-distill-jobs/:id' },
  { method: 'GET', path: '/api/memory-distill-jobs/:id/session' },
  { method: 'POST', path: '/api/memory-distill-jobs/:id/retry' },
  { method: 'POST', path: '/api/memory-distill-jobs/:id/cancel' },

  // ---- taskFeedback (RFC-044 ish) ----
  { method: 'GET', path: '/api/tasks/:taskId/feedback' },
  { method: 'POST', path: '/api/tasks/:taskId/feedback' },

  // ---- users (RFC-036) ----
  { method: 'GET', path: '/api/users' },
  { method: 'GET', path: '/api/users/search' },
  // RFC-099: batch id → public fields for attribution chips.
  { method: 'POST', path: '/api/users/lookup' },
  { method: 'GET', path: '/api/users/:id' },
  { method: 'POST', path: '/api/users' },
  { method: 'PATCH', path: '/api/users/:id' },
  { method: 'DELETE', path: '/api/users/:id' },
  { method: 'POST', path: '/api/users/:id/reset-password' },

  // ---- config (admin) ----
  {
    method: 'GET',
    path: '/api/config',
    happy: { schema: z.object({}).passthrough() },
  },
  { method: 'PUT', path: '/api/config' },

  // ---- daemon effective binding (settings:read; Network tab readout) ----
  { method: 'GET', path: '/api/daemon' },

  // ---- plantuml proxy (RFC-105 WP-B; any logged-in user) ----
  // No endpoint configured in the contract harness → 200 { unconfigured: true }.
  {
    method: 'POST',
    path: '/api/plantuml/render',
    happy: { body: { source: '@startuml\nA->B\n@enduml' }, schema: z.object({}).passthrough() },
  },

  // ---- runtime ----
  // RFC-135: the legacy GET /api/runtime/opencode + /api/runtime/claude probes
  // were removed with their last consumer (homepage → /api/runtimes/status).
  { method: 'GET', path: '/api/runtime/models' },

  // ---- runtime registry (RFC-112) ----
  {
    method: 'GET',
    path: '/api/runtimes',
    happy: { schema: z.object({}).passthrough() },
  },
  // RFC-135: per-enabled-runtime live status (homepage hero).
  {
    method: 'GET',
    path: '/api/runtimes/status',
    happy: { schema: z.object({ runtimes: z.array(z.object({}).passthrough()) }) },
  },

  // ---- overview (RFC-190) ----
  // Homepage capability portal: per-actor-visible resource counts + 7d task
  // stats. Validated against the real shared schema (backend writes it).
  {
    method: 'GET',
    path: '/api/overview',
    happy: { schema: OverviewResponseSchema },
  },
  { method: 'POST', path: '/api/runtimes/probe' },
  { method: 'POST', path: '/api/runtimes' },
  { method: 'PUT', path: '/api/runtimes/:name' },
  { method: 'DELETE', path: '/api/runtimes/:name' },
  { method: 'POST', path: '/api/runtimes/:name/probe' },
  { method: 'POST', path: '/api/runtimes/:name/enabled' },

  // ---- backup ----
  { method: 'POST', path: '/api/backup' },
  // ---- RFC-213 disaster recovery ----
  { method: 'POST', path: '/api/restore' },
  // RFC-213 impl-gate P1-5 — staged-restore visibility + cancel (admin-only).
  { method: 'GET', path: '/api/restore/pending' },
  { method: 'DELETE', path: '/api/restore/pending' },
  // ---- RFC-099 resource ACL (mounted via mountAclEndpoints in resourceAcl.ts) ----
  //
  // These twelve were absent for their entire life: `mountAclEndpoints` builds
  // the path at runtime (`${cfg.base}/:${cfg.param}/acl`), and the coverage
  // guard's route scanner only matches string literals — so it reported the
  // registry as complete while the owner-transfer and grant-editing entry point
  // of every ACL'd resource type sat outside the contract suite entirely (no
  // 401 gate, no shape check, nothing). The scanner now reconstructs them from
  // the call sites; see api-contract-coverage.test.ts and
  // design/test-guard-audit-2026-07-21 gap B1-routes-3.
  { method: 'GET', path: '/api/agents/:id/acl' },
  { method: 'PUT', path: '/api/agents/:id/acl' },
  { method: 'GET', path: '/api/skills/:id/acl' },
  { method: 'PUT', path: '/api/skills/:id/acl' },
  { method: 'GET', path: '/api/mcps/:id/acl' },
  { method: 'PUT', path: '/api/mcps/:id/acl' },
  { method: 'GET', path: '/api/plugins/:id/acl' },
  { method: 'PUT', path: '/api/plugins/:id/acl' },
  { method: 'GET', path: '/api/workflows/:id/acl' },
  { method: 'PUT', path: '/api/workflows/:id/acl' },
  { method: 'GET', path: '/api/workgroups/:id/acl' },
  { method: 'PUT', path: '/api/workgroups/:id/acl' },
]

// ----------------------------------------------------------------------------
// Re-export for tests + small helpers.
// ----------------------------------------------------------------------------

export { ErrorResponseSchema, JsonValue }

/** Endpoints that should respond 401 when called without auth. */
export const AUTH_REQUIRED_ENDPOINTS = ENDPOINTS.filter((e) => !e.public)

/** Public endpoints (no 401 expected). */
export const PUBLIC_ENDPOINTS = ENDPOINTS.filter((e) => e.public === true)
