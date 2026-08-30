// RFC-348 — pure renderers that assemble INTENT.md sections from the teaching
// registries. No IO, no DB, no actor: `services/intent/intentDoc.ts` only
// concatenates what these return.
//
// Rendering rules (locked by tests/intent-teaching-registry.test.ts):
//  - a field's `form` never spells the outer `?`; `renderFieldForm` inserts it
//    right after the field NAME when `required` is false (so
//    `sessionMode:'isolated'|'inline'` → `sessionMode?:'isolated'|'inline'`),
//    and the rendered doc never contains `??`;
//  - `omit`ted fields are not rendered at all;
//  - field-level `note` / `mistake` render on the same line as their form;
//    entry-level `mistakes` are collected into the Common-mistakes section;
//  - privileged node kinds render their form only when the session holds the
//    permission; synthesized-only kinds are NAMED as withheld, never taught.

import {
  CODE_HOST_PROVIDERS,
  INTENT_LIMITS,
  INTENT_REDACTED,
  INTENT_RESOURCE_TYPES,
  NODE_KIND,
  WEBHOOK_TEMPLATE_VARS,
  WORKFLOW_INPUT_KIND,
  codeHostActionDef,
  codeHostActionFields,
  codeHostActionSupported,
  codeHostActionsByGroup,
  codeHostRequiredFields,
  isUnsupportedBinding,
  webhookTriggerToken,
  type IntentMountRequestSchema,
  type IntentOpSchema,
  type IntentQuestionSchema,
  type IntentResourceType,
  type NodeKind,
} from '@agent-workflow/shared'
import { INTENT_NODE_TEACHING } from './nodeKinds'
import { INTENT_PLATFORM_RESOURCE_MAP, platformOnlyResourceTypes } from './platformMap'
import { renderPermissionGrammar } from './permissionGrammar'
import { INTENT_RESOURCE_TEACHING } from './resourceTypes'
import type { IntentNodeAvailability, KeysOf } from './types'
import {
  WORKFLOW_EDGE_NOTES,
  WORKFLOW_EDGE_TEACHING,
  WORKFLOW_INPUT_BASE_TEACHING,
  WORKFLOW_INPUT_TEACHING,
  WORKFLOW_OUTPUT_TEACHING,
} from './workflowParts'

export { renderPermissionGrammar }

/**
 * RFC-253 / RFC-269 — whether the session initiator may author the two
 * privileged node kinds. The doc withholds a kind's FORM when they may not,
 * and says so explicitly (see `renderCapabilityLimits`).
 */
export interface IntentDocPrivileges {
  mayAuthorScripts: boolean
  mayAuthorCodeHostCalls: boolean
}

type PrivilegedAvailability = Extract<IntentNodeAvailability, { kind: 'privileged' }>

export function mayAuthorPermission(
  privileges: IntentDocPrivileges,
  permission: PrivilegedAvailability['permission'],
): boolean {
  switch (permission) {
    case 'scripts:author':
      return privileges.mayAuthorScripts
    case 'code-host-calls:author':
      return privileges.mayAuthorCodeHostCalls
  }
}

// ───────────────────────── loose views over the registries ─────────────────────────

type LooseScalar = {
  readonly form: string
  readonly required: boolean
  readonly note?: string
  readonly mistake?: string
  readonly nested?: LooseNested
}
type LooseOmitted = { readonly omit: true; readonly why: string }
type LooseField = LooseScalar | LooseOmitted
type LooseFields = Readonly<Record<string, LooseField>>
type LooseVariants = {
  readonly discriminator: string
  readonly variants: Readonly<Record<string, LooseFields>>
}
type LooseNested = LooseFields | LooseVariants

function isVariants(nested: LooseNested): nested is LooseVariants {
  return 'discriminator' in nested && 'variants' in nested
}

function isOmitted(field: LooseField): field is LooseOmitted {
  return 'omit' in field && field.omit === true
}

type LooseNodeEntry = {
  readonly availability: IntentNodeAvailability
  readonly fields?: LooseFields
  readonly notes: readonly string[]
  readonly mistakes: readonly string[]
}
type LooseResourceEntry = {
  readonly fields: LooseNested
  readonly notes: readonly string[]
  readonly mistakes: readonly string[]
}

function nodeEntry(kind: NodeKind): LooseNodeEntry {
  return INTENT_NODE_TEACHING[kind] as unknown as LooseNodeEntry
}
function resourceEntry(type: IntentResourceType): LooseResourceEntry {
  return INTENT_RESOURCE_TEACHING[type] as unknown as LooseResourceEntry
}

// ───────────────────────── field rendering ─────────────────────────

/** `form` with `?` inserted after the field name when optional; null for omitted fields. */
export function renderFieldForm(field: LooseField): string | null {
  if (isOmitted(field)) return null
  if (field.required) return field.form
  const colon = field.form.indexOf(':')
  return colon === -1
    ? `${field.form}?`
    : `${field.form.slice(0, colon)}?${field.form.slice(colon)}`
}

function renderFields(fields: LooseFields, separator: string): string {
  return Object.values(fields)
    .map(renderFieldForm)
    .filter((form): form is string => form !== null)
    .join(separator)
}

/** Field-level notes and counter-examples, depth-first in declaration order. */
export function collectFieldNotes(nested: LooseNested): string[] {
  const out: string[] = []
  const visit = (fields: LooseFields): void => {
    for (const field of Object.values(fields)) {
      if (isOmitted(field)) continue
      if (field.note !== undefined) out.push(field.note)
      if (field.mistake !== undefined) out.push(field.mistake)
      if (field.nested !== undefined) visitNested(field.nested)
    }
  }
  const visitNested = (n: LooseNested): void => {
    if (isVariants(n)) for (const variant of Object.values(n.variants)) visit(variant)
    else visit(n)
  }
  visitNested(nested)
  return out
}

/** Every non-omitted field NAME, including nested / variant sub-tables. */
export function collectFieldNames(nested: LooseNested): string[] {
  const out: string[] = []
  const visit = (fields: LooseFields): void => {
    for (const [name, field] of Object.entries(fields)) {
      if (isOmitted(field)) continue
      out.push(name)
      if (field.nested !== undefined) visitNested(field.nested)
    }
  }
  const visitNested = (n: LooseNested): void => {
    if (isVariants(n)) for (const variant of Object.values(n.variants)) visit(variant)
    else visit(n)
  }
  visitNested(nested)
  return out
}

/** Every omitted field NAME (top level and nested). */
export function collectOmittedFieldNames(nested: LooseNested): string[] {
  const out: string[] = []
  const visit = (fields: LooseFields): void => {
    for (const [name, field] of Object.entries(fields)) {
      if (isOmitted(field)) out.push(name)
      else if (field.nested !== undefined) visitNested(field.nested)
    }
  }
  const visitNested = (n: LooseNested): void => {
    if (isVariants(n)) for (const variant of Object.values(n.variants)) visit(variant)
    else visit(n)
  }
  visitNested(nested)
  return out
}

/** Join sentences with one space; a sentence starting with a newline joins as-is. */
function joinSentences(parts: readonly string[]): string {
  let out = ''
  for (const part of parts) {
    if (part.length === 0) continue
    if (out.length === 0 || part.startsWith('\n')) out += part
    else out += ` ${part}`
  }
  return out
}

// ───────────────────────── node kinds ─────────────────────────

export function isNodeKindAuthorable(kind: NodeKind, privileges: IntentDocPrivileges): boolean {
  const availability = nodeEntry(kind).availability
  if (availability.kind === 'public') return true
  if (availability.kind === 'privileged')
    return mayAuthorPermission(privileges, availability.permission)
  return false
}

/** Registry order, filtered to what THIS session may author. */
export function authorableNodeKinds(privileges: IntentDocPrivileges): NodeKind[] {
  return (Object.keys(INTENT_NODE_TEACHING) as NodeKind[]).filter((kind) =>
    isNodeKindAuthorable(kind, privileges),
  )
}

export function synthesizedOnlyNodeKinds(): NodeKind[] {
  return (Object.keys(INTENT_NODE_TEACHING) as NodeKind[]).filter(
    (kind) => nodeEntry(kind).availability.kind === 'synthesized-only',
  )
}

/** Privileged kinds the session may NOT author, with their availability record. */
export function withheldPrivilegedNodeKinds(
  privileges: IntentDocPrivileges,
): Array<{ kind: NodeKind; availability: PrivilegedAvailability }> {
  const out: Array<{ kind: NodeKind; availability: PrivilegedAvailability }> = []
  for (const kind of Object.keys(INTENT_NODE_TEACHING) as NodeKind[]) {
    const availability = nodeEntry(kind).availability
    if (availability.kind !== 'privileged') continue
    if (mayAuthorPermission(privileges, availability.permission)) continue
    out.push({ kind, availability })
  }
  return out
}

/** `{id,kind:'<kind>',<fields…>}` — the FORM anchor tests key on. */
export function renderNodeForm(kind: NodeKind): string {
  const entry = nodeEntry(kind)
  if (entry.fields === undefined) throw new Error(`node kind '${kind}' has no authorable form`)
  const fields = renderFields(entry.fields, ',')
  return `{id,kind:'${kind}'${fields.length === 0 ? '' : `,${fields}`}}`
}

/**
 * RFC-269 — the action catalog, DERIVED from the code-host registry so it can
 * never go stale against the validator (`codeHostRequiredFields` is the same
 * function the validator reads). `*` = required on that provider, `?` =
 * optional; unsupported actions are printed as such rather than hidden.
 */
export function renderCodeHostActionCatalog(): string {
  const lines: string[] = []
  for (const { group, actions } of codeHostActionsByGroup()) {
    for (const action of actions) {
      const perProvider = CODE_HOST_PROVIDERS.map((provider) => {
        if (!codeHostActionSupported(action, provider)) {
          const binding = codeHostActionDef(action).bindings[provider]
          const reason = isUnsupportedBinding(binding) ? binding.reasonKey : 'unsupported'
          return `${provider}: UNSUPPORTED (${reason})`
        }
        const required = new Set<string>(codeHostRequiredFields(action, provider))
        const fields = codeHostActionFields(action, provider).map((field) => {
          const options =
            field.control === 'select' && field.options !== undefined
              ? `(${field.options.join('|')})`
              : ''
          return `${field.name}${required.has(field.name) ? '*' : '?'}${options}`
        })
        return `${provider}: ${fields.length === 0 ? '(no fields)' : fields.join(', ')}`
      })
      lines.push(`    - \`${action}\` [${group}] — ${perProvider.join(' · ')}`)
    }
  }
  return lines.join('\n')
}

function renderNodeFormLine(kind: NodeKind): string {
  const entry = nodeEntry(kind)
  const sentences = [...collectFieldNotes(entry.fields ?? {}), ...entry.notes]
  const prose = joinSentences(sentences)
  let line = `  - \`${renderNodeForm(kind)}\`.${prose.length === 0 ? '' : ` ${prose}`}`
  if (kind === 'code-host-call') line += `\n${renderCodeHostActionCatalog()}`
  return line
}

function renderSynthesizedOnlyLine(kind: NodeKind): string {
  const entry = nodeEntry(kind)
  return `  - NOT AVAILABLE TO YOU: \`${kind}\`. ${joinSentences(entry.notes)} It is named here so you know it exists and is withheld — do not emit it, and do not treat its absence from the list below as an oversight.`
}

/** The "Supported node forms" block (synthesized-only kinds named first, then every authorable form). */
export function renderSupportedNodeForms(privileges: IntentDocPrivileges): string {
  const lines = [
    '  Every node has `{id,kind}` and may carry `position:{x,y}` / `title`. Supported node forms:',
    ...synthesizedOnlyNodeKinds().map(renderSynthesizedOnlyLine),
    ...authorableNodeKinds(privileges).map(renderNodeFormLine),
  ]
  return lines.join('\n')
}

// ───────────────────────── workflow parts ─────────────────────────

export function renderWorkflowInputDeclarations(): string {
  const base = `{${renderFields(WORKFLOW_INPUT_BASE_TEACHING, ',')}}`
  const kinds = WORKFLOW_INPUT_KIND.map((kind) => {
    const teaching = WORKFLOW_INPUT_TEACHING[kind]
    return `\`${kind}{${renderFields(teaching.extra, ',')}}\``
  })
  const notes = WORKFLOW_INPUT_KIND.flatMap((kind) =>
    collectFieldNotes(WORKFLOW_INPUT_TEACHING[kind].extra),
  )
  return [
    `  Input declarations all use \`${base}\`. Supported kinds and extra fields:`,
    `  ${kinds.join('; ')}`,
    ...notes.map((note) => `  ${note}`),
  ].join('\n')
}

/** Root `definition.outputs[]` (WorkflowOutputBindingSchema) — the task-level output declarations. */
export function renderOutputDeclarations(): string {
  const form = `outputs:[{${renderFields(WORKFLOW_OUTPUT_TEACHING, ',')}}]`
  return `  Root-level \`${form}\` (optional) publishes named task outputs by binding each to a node port; the \`output\` node's \`ports\` is the canonical form the canvas writes and uses the same \`{name,bind}\` shape, so declare a result port in one place and keep both consistent when both exist.`
}

export function renderEdgeSentence(): string {
  const required = Object.fromEntries(
    Object.entries(WORKFLOW_EDGE_TEACHING).filter(
      ([, field]) => !isOmitted(field) && field.required,
    ),
  ) as LooseFields
  const form = `{${renderFields(required, ',')}}`
  const boundary = WORKFLOW_EDGE_TEACHING.boundary.note
  return `  Ordinary edges: \`${form}\`. ${joinSentences([boundary, ...WORKFLOW_EDGE_NOTES])}`
}

// ───────────────────────── resource types ─────────────────────────

function renderResourceForm(fields: LooseNested): string {
  if (isVariants(fields)) {
    return Object.values(fields.variants)
      .map((variant) => `\`{${renderFields(variant, ', ')}}\``)
      .join(' OR ')
  }
  return `\`{${renderFields(fields, ', ')}}\``
}

export function renderResourceLine(
  type: IntentResourceType,
  privileges: IntentDocPrivileges,
): string {
  const entry = resourceEntry(type)
  const prose = joinSentences([...collectFieldNotes(entry.fields), ...entry.notes])
  let line = `- **${type}**: ${renderResourceForm(entry.fields)}.${prose.length === 0 ? '' : ` ${prose}`}`
  if (type === 'workflow') {
    line += `\n${renderWorkflowInputDeclarations()}\n${renderSupportedNodeForms(privileges)}\n${renderEdgeSentence()}\n${renderOutputDeclarations()}`
  }
  return line
}

// ───────────────────────── sections ─────────────────────────

/** The two call kinds and their selector fields, as TYPED registry lookups: a
 *  rename in the roster or in the entry's field table fails to compile here. */
const CALL_SELECTORS = {
  workflow: { kind: 'call-workflow', name: 'workflowName', ref: 'workflowRef', id: 'workflowId' },
  workgroup: {
    kind: 'call-workgroup',
    name: 'workgroupName',
    ref: 'workgroupRef',
    id: 'workgroupId',
  },
} as const satisfies {
  workflow: {
    kind: NodeKind
    name: keyof (typeof INTENT_NODE_TEACHING)['call-workflow']['fields']
    ref: keyof (typeof INTENT_NODE_TEACHING)['call-workflow']['fields']
    id: keyof (typeof INTENT_NODE_TEACHING)['call-workflow']['fields']
  }
  workgroup: {
    kind: NodeKind
    name: keyof (typeof INTENT_NODE_TEACHING)['call-workgroup']['fields']
    ref: keyof (typeof INTENT_NODE_TEACHING)['call-workgroup']['fields']
    id: keyof (typeof INTENT_NODE_TEACHING)['call-workgroup']['fields']
  }
}

/** "## Reference rules (hard)" — contract-locked prose; every kind / field name comes from the registry. */
export function renderReferenceRules(): string {
  const wf = CALL_SELECTORS.workflow
  const wg = CALL_SELECTORS.workgroup
  return `## Reference rules (hard)

- Reference existing resources ONLY by their session handle
  (\`res#<type>#<n>\`, as listed in inventory/ and mounted/).
- EXACTLY ONE exception, inside a workflow definition: \`${wf.kind}\` /
  \`${wg.kind}\` nodes select their target by its exact NAME — the backticked
  name printed next to the handle in inventory/ — because the name is the field
  the platform persists and exports to YAML. Copy it character for character; a
  handle in \`${wf.name}\` / \`${wg.name}\` is wrong. Two consequences follow
  from the name being resolved LATE (at launch, not at save), and you must
  respect both:
  - **A name is not a stable reference.** Renaming a target later breaks every
    caller (\`call-workflow-ref-missing\`). If the user renames something that
    other workflows call, say that those callers need updating too.
  - **Names are not unique.** If more than one resource in inventory/ carries
    the target's name, launch binds the OLDEST one the launching user can see —
    possibly not the one meant. Ask the user which one instead of guessing.
  - **To bind precisely, add the handle alongside the name**: \`${wf.ref}\` /
    \`${wg.ref}\` (a \`res#…\` handle or a \`$new:…\` tempRef). When present it
    decides WHICH row the edge binds to, so a same-name collision cannot pick
    the wrong one; the name still travels with the node (it is what the platform
    persists and exports). Under \`mounted/\` these nodes are shown to you in
    exactly that form — name plus \`${wf.ref}\`/\`${wg.ref}\` — so echoing an
    edge back unchanged preserves the binding the user already has. Never write
    \`${wf.id}\` / \`${wg.id}\`: those are platform-internal ids you cannot
    see, and a changeset carrying one is rejected.
- Reference resources you are creating in this changeset by their
  \`$new:<slug>\` tempRef.
- NEVER invent ids, ULIDs, usernames or file paths. Unknown handle = rejection.
- Prefer REUSING existing resources over creating near-duplicates.
- To modify a resource that is NOT under mounted/, use the \`requests\` port to
  ask the user to mount it — mounting requires their approval.`
}

const WEBHOOK_TRIGGER_TOKEN_CATALOG = WEBHOOK_TEMPLATE_VARS.map(webhookTriggerToken).join(', ')

export function renderPlatformModel(privileges: IntentDocPrivileges): string {
  const privilegedOverview = withheldOrHeldOverview(privileges)
  const authorable = authorableNodeKinds(privileges)
  return `## Platform model (essentials)

Resource types you may create or update (${INTENT_RESOURCE_TYPES.length}): ${INTENT_RESOURCE_TYPES.join(', ')}.
- An **agent** is a persona (frontmatter + system prompt body) with typed
  output ports; it may reference skills / mcp / plugins / other agents.
- A **workflow** is a static DAG: agent-single nodes (each runs one agent with
  a prompt template), input/output nodes, wrapper-git / wrapper-loop /
  wrapper-fanout containers, review (human approval) and clarify nodes, plus
  call-workflow / call-workgroup, which delegate a stage to an independent child
  task${privilegedOverview.length === 0 ? '' : `, and ${privilegedOverview.join(' / ')}`}.
  Wrappers list inner node ids in \`nodeIds\`; nodes stay flat in \`nodes[]\`.
  "Supported node forms" under Payload schemas is EXHAUSTIVE — a kind absent
  from it does not exist for you, whatever the platform may support elsewhere.
  Node kinds you may author in this session (${authorable.length}): ${authorable
    .map((kind) => `\`${kind}\``)
    .join(', ')}.
- A **workgroup** is a roster of agent/human members with a mode
  (leader_worker | free_collab | dynamic_workflow) and a charter.
- A **skill** is a directory: SKILL.md (authored via \`bodyMd\`) + auxiliary
  TEXT files.`
}

/** The overview must not advertise a kind whose FORM the doc then withholds. */
function withheldOrHeldOverview(privileges: IntentDocPrivileges): string[] {
  const out: string[] = []
  for (const kind of Object.keys(INTENT_NODE_TEACHING) as NodeKind[]) {
    const availability = nodeEntry(kind).availability
    if (availability.kind !== 'privileged') continue
    if (!mayAuthorPermission(privileges, availability.permission)) continue
    out.push(availability.overviewLabel)
  }
  return out
}

export function renderPlatformCapabilityMap(): string {
  const lines = platformOnlyResourceTypes().map((type) => {
    const teaching = INTENT_PLATFORM_RESOURCE_MAP[type]
    if (teaching.stance !== 'platform-only') throw new Error(`unexpected stance for ${type}`)
    const managed =
      teaching.managedAt.kind === 'route'
        ? `Managed at \`${teaching.managedAt.path}\``
        : `No dedicated page (${teaching.managedAt.note})`
    return `- \`${type}\` — ${teaching.purpose}. ${managed}.`
  })
  return `## Platform capability map (exists, but not yours to create)

These ${lines.length} resource types exist on the platform and are listed read-only under \`inventory/platform/\` so you can recognise them by name. The changeset contract cannot create, update, mount or reference any of them: if the user needs one, say where it is configured and offer what you CAN build.
${lines.join('\n')}`
}

/** Approved wording (design §3, RFC-235 D33): the pre-selection is a preference the message may override on any turn. */
export const REQUESTED_ARTIFACT_PICKED =
  "The user pre-selected **<type>** in the composer. Prefer it when the goal fits: make a <type> the primary resource and add supporting resources it needs. If the user's message — on any turn — explicitly asks for a different kind, follow the message; do not ask for confirmation just because it differs from the pre-selection."
export const REQUESTED_ARTIFACT_NONE =
  'No type requested (Auto): choose the resource mix yourself from the goal.'

/** RFC-235 D33 — the UI-picked type is a preference, never a constraint. */
export function renderRequestedArtifactType(type: IntentResourceType | null): string {
  const body =
    type === null ? REQUESTED_ARTIFACT_NONE : REQUESTED_ARTIFACT_PICKED.replaceAll('<type>', type)
  return `## Requested artifact type\n\n${body}`
}

/**
 * RFC-253 / RFC-269 — withheld privileged kinds must be stated, not silently
 * absent, and the omission list is PER WITHHELD KIND (Codex round-2 P2), never
 * the union: an actor who may author scripts still SEES a redacted `env`
 * (masking is permission-blind) but gets no rehydration, so telling them to
 * omit it would delete a stored credential. Empty when nothing is withheld.
 */
export function renderCapabilityLimits(privileges: IntentDocPrivileges): string {
  const withheld = withheldPrivilegedNodeKinds(privileges)
  if (withheld.length === 0) return ''
  const untouchable = withheld.map((entry) => entry.availability.untouchableFields).join(' / ')
  return `## Capability limits (hard)

The user who started this session does NOT hold the permission these node kinds
require:
${withheld.map((entry) => `- \`kind:'${entry.kind}'\` requires \`${entry.availability.permission}\`.`).join('\n')}

So you must not CREATE one and must not CHANGE one — **and must not DELETE one
either**. That third rule is the one that bites, because an \`update\` payload
carries the COMPLETE definition:

- **Creating / changing**: do not emit a new node of these kinds, and do not
  alter any field of an existing one. If the user asks for one, tell them
  plainly that their account lacks the permission — do not silently substitute
  another kind — and offer what you CAN build instead (typically an agent whose
  prompt does the same work).
- **Preserving**: a workflow under \`mounted/\` MAY ALREADY CONTAIN one. Its
  privileged fields are printed as \`${INTENT_REDACTED}\` precisely because you may not read
  them. When you update that workflow, copy the node back with the same \`id\`,
  the same \`kind\`, the same place in \`nodes[]\` and its edges untouched — but
  **OMIT these WHOLE FIELDS instead of echoing the marker** — ${withheld
    .map(
      (entry) => `\`${entry.availability.redactedFields.join('` / `')}\` on a ${entry.kind} node`,
    )
    .join(', ')}. Leave the field out of the node object entirely; do not send it
  emptied, and do not send the inner keys either (${withheld
    .map((entry) => entry.availability.nestedRedactionHint)
    .join('; ')}). Any string
  containing \`${INTENT_REDACTED}\` is rejected as a corrupted credential before the permission
  check is even reached, so echoing the marker fails the changeset; omitting the
  field is what tells the platform to restore the stored value. This applies ONLY
  to the kinds listed above — a redacted field on a node kind you MAY author is
  not restored for you, so omitting it there would delete it. Dropping a whole
  node of a listed kind — or editing any field you CAN see on one
  (${untouchable}) — counts as CHANGING it.

Apply is all-or-nothing: any of these is refused with
\`script-author-forbidden\` / \`code-host-author-forbidden\` and takes the whole
changeset down with it — including the unrelated edit the user actually asked
for.`
}

/** RFC-234 live-run lesson (deepseek 2026-07-28): payloads are STRICT objects, so spell out every field list. */
export function renderPayloadSchemas(
  privileges: IntentDocPrivileges,
  workflowSchemaVersion: number,
): string {
  const perType = INTENT_RESOURCE_TYPES.map((type) => renderResourceLine(type, privileges))
  return `## Payload schemas (STRICT — unknown keys are rejected)

Common rules:
- \`name\` for **agent / skill / mcp / plugin**: machine slug matching ^[a-z0-9][a-z0-9_-]*$ (human wording goes in \`description\`). These names become an OpenCode agent key, an on-disk skill directory and an MCP server key, so they stay ASCII.
- \`name\` for **workflow / workgroup**: an ordinary human-readable name in the USER'S OWN LANGUAGE — Chinese is expected when the user writes Chinese (\`代码审计流水线\`). Must not start with \`_\`, must not contain control characters or line breaks, at most 128 characters.
- \`opId\`: \`op-1\`, \`op-2\`, … in order. tempRef: \`$new:<slug>\`.
- The changeset port contains ONE flat \`{"$schema_version":1,"ops":[…]}\` — never nest an \`ops\` array inside an op.
- ref = a \`res#<type>#<n>\` handle or a \`$new:<slug>\` tempRef declared in this same changeset.
- Output budget: the WHOLE changeset must fit your model output limit. Keep \`bodyMd\`/\`instructions\` concise (aim ≤120 lines each). If the bundle risks truncation, emit fewer ops this turn and say in \`summary\` what you will add next turn.

Webhook trigger templates are a PUBLIC workflow capability, independent of privileged node permissions:
- The only valid webhook form is \`{{trigger.webhook.<field>}}\`. It works in agent \`promptTemplate\`, call-workgroup \`goalTemplate\`, review \`commentInjectTemplate\`, and every code-host-call template value (including custom path/query/body).
- These are the complete ${WEBHOOK_TEMPLATE_VARS.length} canonical tokens: ${WEBHOOK_TRIGGER_TOKEN_CATALOG}.
- Trigger values are execution context, NOT workflow inputs. Do not add synthetic workflow \`inputs[]\`, input nodes, root parameters, or edges for them. Only create an ordinary workflow input when the USER explicitly asks to expose an event value for manual entry so the same workflow can run without a webhook.
- Never generate legacy root forms such as \`{{mr_iid}}\` for webhook data or \`{{trigger.mr_iid}}\`. A non-webhook launch of a trigger-dependent workflow is rejected before execution; do not fake a fallback by flattening trigger fields.
- \`event_json\` is available like every other standard field and is capped at 32 KiB. An author who needs a literal token writes \`{{!trigger.webhook.mr_iid}}\`.

Per-type payload fields (workflow \`definition.$schema_version\` is ${workflowSchemaVersion}):
${perType.join('\n')}

Worked example (one agent):
\`{"$schema_version":1,"ops":[{"opId":"op-1","action":"create","resourceType":"agent","tempRef":"$new:code-auditor","payload":{"name":"code-auditor","description":"代码审计代理：逐文件审查 git diff","outputs":["findings"],"bodyMd":"# 角色\\n你审查 git diff…"}}]}\`

JSON closure check (especially when the final op is a workflow): after the last edge,
close the edges array, then close definition, payload, and the final op, then close
the ops array and root object. The final structural suffix is \`]}}}]}\`, not
\`]}}]}\`. Do not rely on prose self-checks; emit the actual delimiters.`
}

/** Cross-field counter-examples from every entry the session may author (field-adjacent `mistake`s stay on their line). */
export function renderCommonMistakes(privileges: IntentDocPrivileges): string {
  const items: string[] = []
  for (const type of INTENT_RESOURCE_TYPES) items.push(...resourceEntry(type).mistakes)
  for (const kind of authorableNodeKinds(privileges)) items.push(...nodeEntry(kind).mistakes)
  return `## Common mistakes (hard)\n\n${items.map((item) => `- ${item}`).join('\n')}`
}

// ───────────────────────── envelope / working directory ─────────────────────────

/** The intent envelope's four ports (turnEngine reads the same names off the parsed envelope). */
export const INTENT_ENVELOPE_PORTS = {
  summary: 'summary',
  changeset: 'changeset',
  questions: 'questions',
  requests: 'requests',
} as const

/** Per-turn batching guidance (hard guidance, not parser limits); locked by intent-doc-validator-contract. */
export const INTENT_TURN_GUIDANCE = Object.freeze({
  maxOps: 8,
  maxWorkflowNodesCreatedOrReplaced: 6,
  targetChangesetBytes: 256 * 1024,
})

/** "## Single-turn delivery budget" — the batching guidance, `summary` derived from the port roster. */
export function renderDeliveryBudget(): string {
  return `## Single-turn delivery budget (hard guidance, not parser limits)

- Emit at most ${INTENT_TURN_GUIDANCE.maxOps} changeset ops in one turn.
- Across workflow create/update payloads, create or fully replace at most ${INTENT_TURN_GUIDANCE.maxWorkflowNodesCreatedOrReplaced} workflow nodes in one turn.
- Target at most ${INTENT_TURN_GUIDANCE.targetChangesetBytes / 1024} KiB of changeset JSON.
- If the user's final goal is larger, deliver one complete, verifiable slice now (dependencies first or one workflow slice), then list the remaining work in \`${INTENT_ENVELOPE_PORTS.summary}\` for the next turn.
- Every slice MUST end with a complete nonce-bound envelope. Never omit the current turn's result merely to keep thinking.

The server still accepts the larger formal limits printed below; these numbers guide reliable batching and do not shrink that accepted domain.`
}

/** Op / question / mount-request field names, compile-checked against the shared schemas. */
const OP_CREATE_FIELDS = [
  'opId',
  'action',
  'resourceType',
  'tempRef',
  'payload',
] as const satisfies readonly KeysOf<typeof IntentOpSchema>[]
const OP_UPDATE_FIELDS = [
  'opId',
  'action',
  'resourceType',
  'target',
  'payload',
] as const satisfies readonly KeysOf<typeof IntentOpSchema>[]
const QUESTION_FIELDS = [
  'id',
  'question',
  'options',
  'multiSelect',
] as const satisfies readonly KeysOf<typeof IntentQuestionSchema>[]
const MOUNT_REQUEST_FIELDS = ['resourceType', 'name', 'reason'] as const satisfies readonly KeysOf<
  typeof IntentMountRequestSchema
>[]

/** Decorations the model needs beside a field name (literal values, ranges, optional marks). */
const OP_FIELD_FORMS: Partial<Record<KeysOf<typeof IntentOpSchema>, string>> = {
  target: "target:'res#…'",
}
const QUESTION_FIELD_FORMS: Partial<Record<KeysOf<typeof IntentQuestionSchema>, string>> = {
  options: 'options[2..4]',
}
const MOUNT_REQUEST_FIELD_FORMS: Partial<Record<KeysOf<typeof IntentMountRequestSchema>, string>> =
  {
    reason: 'reason?',
  }

function fieldList<K extends string>(
  fields: readonly K[],
  forms: Partial<Record<K, string>>,
  extra: Partial<Record<K, string>> = {},
): string {
  return `{${fields.map((field) => extra[field] ?? forms[field] ?? field).join(', ')}}`
}

/** The working-directory layout paragraph; file names are the dump's own constants. */
export const RUNTIMES_INVENTORY_FILE = 'inventory/runtimes.md'
export const PLATFORM_INVENTORY_DIR = 'inventory/platform/'
const AGENT_RUNTIME_FIELD =
  'runtime' satisfies keyof (typeof INTENT_RESOURCE_TEACHING)['agent']['fields']
const AGENT_TYPE = 'agent' satisfies IntentResourceType

export function renderWorkingDirectoryLayout(): string {
  return `You are the intent builder for the agent-workflow platform. Working directory
layout:

- \`INTENT.md\` — this document (goal, history, current draft, output contract)
- \`inventory/\` — summaries of every resource you may reference by handle
- \`${RUNTIMES_INVENTORY_FILE}\` — runtime profiles an ${AGENT_TYPE}'s \`${AGENT_RUNTIME_FIELD}\` may name, with the effective default
- \`${PLATFORM_INVENTORY_DIR}\` — read-only rows of the platform-managed resource types you cannot create
- \`mounted/\` — full dumps of the resources this session works on`
}

/** "## Output contract" — envelope ports, op / question / request shapes and the formal limits (contract-locked prose). */
export function renderOutputContract(langDirective: string): string {
  const ports = INTENT_ENVELOPE_PORTS
  const createOp = fieldList(OP_CREATE_FIELDS, OP_FIELD_FORMS, { action: "action:'create'" })
  const updateOp = fieldList(OP_UPDATE_FIELDS, OP_FIELD_FORMS, { action: "action:'update'" })
  return `## Output contract

End your reply with ONE envelope (last one wins). Ports:
- \`${ports.summary}\` (required, ≤2 KiB): what you did or why you are asking.
- EXACTLY ONE of:
  - \`${ports.changeset}\`: JSON \`{"$schema_version":1,"ops":[...]}\` — ops are
    \`${createOp}\` or
    \`${updateOp}\`.
    Updates carry the COMPLETE new document, not a diff. Limits: ≤${INTENT_LIMITS.maxOps} ops,
    canonical JSON ≤${INTENT_LIMITS.maxChangesetBytes} bytes, skill files ≤${INTENT_LIMITS.maxSkillFiles} × ${INTENT_LIMITS.maxSkillFileBytes} bytes.
  - \`${ports.questions}\`: JSON array of ≤${INTENT_LIMITS.maxQuestions} \`${fieldList(QUESTION_FIELDS, QUESTION_FIELD_FORMS)}\`
    — use when the intent is ambiguous; the user answers before you generate.
- \`${ports.requests}\` (optional): JSON array of ≤${INTENT_LIMITS.maxMountRequests}
  \`${fieldList(MOUNT_REQUEST_FIELDS, MOUNT_REQUEST_FIELD_FORMS)}\` mount SUGGESTIONS (user must approve).

${langDirective}`
}

/** Every NODE_KIND the shared roster knows, for tests that cross-check the registry. */
export function allNodeKinds(): readonly NodeKind[] {
  return NODE_KIND
}
