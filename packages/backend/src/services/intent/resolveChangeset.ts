// RFC-234 §3/§9 — the SINGLE resolve seam between the model-facing changeset
// (handles + tempRefs) and canonical platform ids.
//
// T5 ships the RECEIPT-level validation (runs the moment a changeset arrives,
// before anything is shown as a confirmable draft):
//   - every handle exists in the session manifest and slot types match;
//   - update targets must be DETAIL manifest entries (fully dumped this epoch);
//   - tempRef graph is acyclic and slot-type-correct;
//   - secret carriers are sentinel-only + the credential scanner is clean
//     (findings surface separately — they block confirm until waived at
//     commit time, design §8).
// T6 extends this file with full canonical resolution + apply preflight.

import {
  collectIntentWorkflowAgentRefs,
  collectWorkflowTemplateSurfaces,
  extractTemplateRefs,
  findNonSentinelSecretCarriers,
  intentHandleType,
  isIntentTempRef,
  scanForCredentialPatterns,
  WORKFLOW_SCHEMA_VERSION,
  WorkflowDefinitionSchema,
  type AclResourceType,
  type CredentialFinding,
  type IntentChangeset,
  type IntentOp,
  validateFinalNameForType,
} from '@agent-workflow/shared'
import { manifestByHandle, type IntentContextManifest, type IntentManifestEntry } from './manifest'

export interface DraftValidationReport {
  /** Blocking structural errors — the draft cannot be committed while any exist. */
  errors: string[]
  /** Credential-shaped strings; block commit unless explicitly waived per slot. */
  credentialFindings: Array<CredentialFinding & { opId: string }>
}

interface TypedRef {
  opId: string
  ref: string
  expectedType: AclResourceType
  slot: string
}

/** Typed reference walk — mirrors collectChangesetRefs but keeps the slot's
 *  expected resource type so `dependsOn: [res#mcp#1]` is caught here, not at
 *  apply time. */
export function collectTypedRefs(cs: IntentChangeset): TypedRef[] {
  const out: TypedRef[] = []
  for (const op of cs.ops) {
    const push = (ref: string, expectedType: AclResourceType, slot: string) =>
      out.push({ opId: op.opId, ref, expectedType, slot })
    switch (op.resourceType) {
      case 'agent': {
        op.payload.skills.forEach((s, i) => {
          if (typeof s === 'string') push(s, 'skill', `skills[${i}]`)
        })
        op.payload.dependsOn.forEach((r, i) => push(r, 'agent', `dependsOn[${i}]`))
        op.payload.mcp.forEach((r, i) => push(r, 'mcp', `mcp[${i}]`))
        op.payload.plugins.forEach((r, i) => push(r, 'plugin', `plugins[${i}]`))
        break
      }
      case 'workflow': {
        const { refs } = collectIntentWorkflowAgentRefs(
          op.payload.definition as { nodes: Array<Record<string, unknown>> },
        )
        refs.forEach((r, i) => push(r, 'agent', `definition.agentRef[${i}]`))
        break
      }
      case 'workgroup': {
        op.payload.members.forEach((m, i) => {
          if (m.memberType === 'agent') push(m.agentRef, 'agent', `members[${i}].agentRef`)
        })
        break
      }
      default:
        break
    }
  }
  return out
}

function tempRefType(cs: IntentChangeset, tempRef: string): AclResourceType | undefined {
  const op = cs.ops.find((o) => o.action === 'create' && o.tempRef === tempRef)
  return op?.resourceType
}

/** Detect cycles over the tempRef dependency graph (create-op → tempRefs it
 *  references). Returns the ops participating in a cycle. */
export function findTempRefCycles(cs: IntentChangeset): string[] {
  const byTempRef = new Map<string, IntentOp>()
  for (const op of cs.ops) {
    if (op.action === 'create') byTempRef.set(op.tempRef, op)
  }
  const edges = new Map<string, string[]>()
  for (const typed of collectTypedRefs(cs)) {
    if (!isIntentTempRef(typed.ref)) continue
    const from = cs.ops.find((o) => o.opId === typed.opId)
    if (from === undefined || from.action !== 'create') continue
    edges.set(from.tempRef, [...(edges.get(from.tempRef) ?? []), typed.ref])
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const cyclic = new Set<string>()
  const visit = (node: string, stack: string[]): void => {
    const s = state.get(node)
    if (s === 'done') return
    if (s === 'visiting') {
      for (const member of stack.slice(stack.indexOf(node))) cyclic.add(member)
      return
    }
    state.set(node, 'visiting')
    for (const next of edges.get(node) ?? []) visit(next, [...stack, node])
    state.set(node, 'done')
  }
  for (const tempRef of byTempRef.keys()) visit(tempRef, [])
  return [...cyclic]
}

export function validateDraftChangeset(
  manifest: IntentContextManifest,
  cs: IntentChangeset,
): DraftValidationReport {
  const errors: string[] = []
  const credentialFindings: DraftValidationReport['credentialFindings'] = []
  const byHandle = manifestByHandle(manifest)

  for (const op of cs.ops) {
    if (op.action === 'update') {
      const entry = byHandle.get(op.target)
      if (entry === undefined) {
        errors.push(`${op.opId}: unknown target handle ${op.target}`)
      } else if (entry.resourceType !== op.resourceType) {
        errors.push(
          `${op.opId}: target ${op.target} is a ${entry.resourceType}, not ${op.resourceType}`,
        )
      } else if (!entry.detail) {
        errors.push(
          `${op.opId}: target ${op.target} is inventory-only — request a mount before updating it (intent-target-not-mounted)`,
        )
      }
    }
    // secret carriers must be sentinel-or-empty
    for (const pointer of findNonSentinelSecretCarriers(op)) {
      errors.push(
        `${op.opId}: secret carrier must be the ‹secret› sentinel (${pointer}) (intent-secret-value-forbidden)`,
      )
    }
    // credential-shaped strings anywhere in the payload
    for (const finding of scanForCredentialPatterns(op.payload, `/${op.opId}/payload`)) {
      credentialFindings.push({ ...finding, opId: op.opId })
    }

    // RFC-292: Intent is a first-class workflow authoring boundary. Scan every
    // inventoried template surface before confirm so legacy/malformed trigger
    // refs become repair feedback instead of a late apply/runtime surprise.
    if (op.resourceType === 'workflow') {
      const rawDefinition = op.payload.definition
      if (rawDefinition.$schema_version !== WORKFLOW_SCHEMA_VERSION) {
        errors.push(
          `${op.opId}: workflow $schema_version must be ${WORKFLOW_SCHEMA_VERSION} (intent-workflow-schema-version)`,
        )
      }
      const parsedDefinition = WorkflowDefinitionSchema.safeParse(rawDefinition)
      if (parsedDefinition.success) {
        for (const surface of collectWorkflowTemplateSurfaces(parsedDefinition.data)) {
          for (const ref of extractTemplateRefs(surface.text)) {
            if (ref.kind !== 'invalid') continue
            errors.push(
              `${op.opId}: invalid template reference '{{${ref.raw}}}' at ${surface.pointer} (${ref.reason})`,
            )
          }
        }
      }
    }
  }

  for (const typed of collectTypedRefs(cs)) {
    if (isIntentTempRef(typed.ref)) {
      const t = tempRefType(cs, typed.ref)
      if (t === undefined) {
        errors.push(`${typed.opId}: ${typed.slot} references undeclared tempRef ${typed.ref}`)
      } else if (t !== typed.expectedType) {
        errors.push(
          `${typed.opId}: ${typed.slot} expects a ${typed.expectedType}, but ${typed.ref} creates a ${t}`,
        )
      }
      continue
    }
    const handleType = intentHandleType(typed.ref)
    const entry = byHandle.get(typed.ref)
    if (entry === undefined) {
      errors.push(
        `${typed.opId}: ${typed.slot} references unknown handle ${typed.ref} (intent-ref-unknown)`,
      )
    } else if (handleType !== typed.expectedType) {
      errors.push(
        `${typed.opId}: ${typed.slot} expects a ${typed.expectedType} handle, got ${typed.ref}`,
      )
    }
  }

  for (const cyclicRef of findTempRefCycles(cs)) {
    errors.push(`tempRef cycle involving ${cyclicRef}`)
  }

  return { errors, credentialFindings }
}

// ─────────────────────────────────────────────────────────────────────────────
// T6 — server-issued slots, decision overlay, copy normalization and final
// handle/tempRef → id resolution (design §9.2/§9.3).
// ─────────────────────────────────────────────────────────────────────────────

import { ulid } from 'ulid'
import { INTENT_SECRET_SENTINEL, intentHandleType as handleTypeOf } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'

/** A server-issued fillable slot (design-gate P1-3): commit decisions may only
 *  address slots derived HERE from the exact confirmed draft — anything else
 *  is a 422. slotIds are deterministic so the confirm UI and the apply request
 *  agree byte-for-byte. */
export type IntentSlot =
  | { kind: 'secret'; slotId: string; opId: string; jsonPointer: string }
  | { kind: 'secretWaiver'; slotId: string; opId: string; jsonPointer: string }
  | { kind: 'humanBinding'; slotId: string; opId: string; displayName: string }
  | { kind: 'finalName'; slotId: string; opId: string }

/** Script nodes of a passthrough workflow definition that carry a record env,
 *  with their node index (pointer segment). ONE walker for both slot
 *  derivation and confirm-time value injection — the two must never disagree
 *  about which entries exist. */
function collectScriptEnvNodes(
  definition: unknown,
): Array<[number, { env: Record<string, string> }]> {
  const nodes = (definition as { nodes?: unknown[] } | undefined)?.nodes
  if (!Array.isArray(nodes)) return []
  const out: Array<[number, { env: Record<string, string> }]> = []
  nodes.forEach((node, i) => {
    if (typeof node !== 'object' || node === null) return
    const rec = node as { kind?: unknown; env?: unknown }
    if (rec.kind !== 'script') return
    if (typeof rec.env !== 'object' || rec.env === null || Array.isArray(rec.env)) return
    out.push([i, { env: rec.env as Record<string, string> }])
  })
  return out
}

export function deriveIntentSlots(
  manifest: IntentContextManifest,
  cs: IntentChangeset,
): { slots: IntentSlot[]; report: DraftValidationReport } {
  const report = validateDraftChangeset(manifest, cs)
  const slots: IntentSlot[] = []
  for (const op of cs.ops) {
    if (op.resourceType === 'mcp') {
      const config = op.payload.config as {
        env?: Record<string, string>
        headers?: Record<string, string>
      }
      const pushSecret = (base: string, rec: Record<string, string> | undefined) => {
        for (const key of Object.keys(rec ?? {})) {
          const pointer = `${base}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
          if ((rec as Record<string, string>)[key] === INTENT_SECRET_SENTINEL) {
            slots.push({
              kind: 'secret',
              slotId: `secret:${op.opId}:${pointer}`,
              opId: op.opId,
              jsonPointer: pointer,
            })
          }
        }
      }
      if (op.payload.type === 'local') pushSecret('/config/env', config.env)
      if (op.payload.type === 'remote') pushSecret('/config/headers', config.headers)
    }
    if (op.resourceType === 'workflow') {
      // RFC-253 T28 — script-node env mirrors MCP env: the model may only emit
      // the sentinel; each sentinel becomes a server-issued slot the user fills
      // at confirm time. Pointers are payload-relative (MCP precedent above).
      for (const [i, node] of collectScriptEnvNodes(op.payload.definition)) {
        for (const [key, value] of Object.entries(node.env)) {
          if (value !== INTENT_SECRET_SENTINEL) continue
          const pointer = `/definition/nodes/${i}/env/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
          slots.push({
            kind: 'secret',
            slotId: `secret:${op.opId}:${pointer}`,
            opId: op.opId,
            jsonPointer: pointer,
          })
        }
      }
    }
    if (op.resourceType === 'workgroup') {
      for (const member of op.payload.members) {
        if (member.memberType === 'human') {
          slots.push({
            kind: 'humanBinding',
            slotId: `human:${op.opId}:${member.displayName}`,
            opId: op.opId,
            displayName: member.displayName,
          })
        }
      }
    }
    slots.push({ kind: 'finalName', slotId: `name:${op.opId}`, opId: op.opId })
  }
  for (const finding of report.credentialFindings) {
    slots.push({
      kind: 'secretWaiver',
      slotId: `waiver:${finding.opId}:${finding.jsonPointer}`,
      opId: finding.opId,
      jsonPointer: finding.jsonPointer,
    })
  }
  return { slots, report }
}

export interface IntentDecision {
  opId: string
  /** 'modify' (default) applies an update in place; 'copy' normalizes the
   *  update into a CREATE of a derived private resource (design-gate P0-4). */
  applyMode?: 'modify' | 'copy'
  slots?: Array<{ slotId: string; value: string }>
}

export type ResolvedIntentOp = {
  opId: string
  resourceType: AclResourceType
  /** Final canonical id this op lands on (pre-minted for creates/copies). */
  resourceId: string
  /** Manifest entry for in-place updates (fence source); absent for creates. */
  manifestEntry?: IntentManifestEntry
  action: 'create' | 'update'
  /** True when this create was normalized from a copy decision. */
  fromCopy: boolean
  /**
   * RFC-291 — the copy SOURCE's handle, set only when `fromCopy`.
   *
   * Deliberately separate from `manifestEntry`: that field means "fence source
   * for an in-place update" and is intentionally dropped for copies (a copy is
   * not in-place, and carrying it would misfire the fence check). The commit
   * needs the source identity for a different purpose — retiring it as a mount
   * root — so it gets its own field rather than overloading that one.
   */
  copiedFromHandle?: string
  /** Canonicalized payload with slot values overlaid and every cross-resource
   *  reference replaced by a FINAL canonical id. Shape follows the op type. */
  payload: Record<string, unknown>
}

export interface ResolvedIntentBundle {
  /** Topologically ordered: skills → mcps → plugins → agents (dependsOn order)
   *  → workflows/workgroups. */
  ops: ResolvedIntentOp[]
  /** tempRef / copied-handle → final id (for receipts + rewiring assertions). */
  finalIdByRef: Map<string, string>
  /** secret slot values by (opId, jsonPointer) — NEVER persisted; consumed by
   *  the appliers and then dropped. */
  secretValues: Map<string, string>
  waivedPointers: Set<string>
}

function requireDecisionSlots(
  issued: IntentSlot[],
  decisions: IntentDecision[],
): Map<string, string> {
  const issuedById = new Map(issued.map((s) => [s.slotId, s]))
  const values = new Map<string, string>()
  for (const decision of decisions) {
    for (const filled of decision.slots ?? []) {
      const slot = issuedById.get(filled.slotId)
      if (slot === undefined || slot.opId !== decision.opId) {
        throw new ValidationError('intent-slot-unknown', `slot '${filled.slotId}' was not issued`)
      }
      values.set(filled.slotId, filled.value)
    }
  }
  return values
}

/** Resolve the confirmed draft + decisions into an ordered, canonical bundle.
 *  Pure given its inputs — the DB-touching prepare/commit phases run in
 *  applyChangeset.ts. Throws ValidationError on any contract violation. */
export function resolveIntentBundle(input: {
  manifest: IntentContextManifest
  changeset: IntentChangeset
  decisions: IntentDecision[]
  /** Occupied names per type in the actor's namespace (name-conflict precheck). */
  occupiedNames: ReadonlyMap<AclResourceType, ReadonlySet<string>>
  /**
   * Codex impl-gate P0-1 — update targets the actor may NOT modify in place
   * (foreign/builtin owner, or a type whose in-place update is unsupported).
   * handle → human reason. The caller (applyChangeset / the detail route)
   * derives this from the DB; enforcement lives HERE so every commit path
   * shares one choke point: such an op MUST carry applyMode 'copy'.
   */
  copyOnlyTargets?: ReadonlyMap<string, string>
}): ResolvedIntentBundle {
  const { manifest, changeset, decisions } = input
  const { slots, report } = deriveIntentSlots(manifest, changeset)
  if (report.errors.length > 0) {
    throw new ValidationError('intent-draft-invalid', 'draft has blocking validation errors', {
      errors: report.errors.slice(0, 32),
    })
  }
  const slotValues = requireDecisionSlots(slots, decisions)
  const decisionByOp = new Map(decisions.map((d) => [d.opId, d]))
  const byHandle = manifestByHandle(manifest)

  // Waivers: every credential finding must be explicitly waived.
  const waivedPointers = new Set<string>()
  for (const slot of slots) {
    if (slot.kind === 'secretWaiver' && slotValues.get(slot.slotId) === 'waived') {
      waivedPointers.add(`${slot.opId}:${slot.jsonPointer}`)
    }
  }
  for (const finding of report.credentialFindings) {
    if (!waivedPointers.has(`${finding.opId}:${finding.jsonPointer}`)) {
      throw new ValidationError(
        'intent-secret-value-forbidden',
        `credential-shaped value at ${finding.jsonPointer} (op ${finding.opId}) requires an explicit waiver`,
        { jsonPointer: finding.jsonPointer, opId: finding.opId },
      )
    }
  }

  // Secrets: every sentinel carrier must be filled.
  const secretValues = new Map<string, string>()
  for (const slot of slots) {
    if (slot.kind !== 'secret') continue
    const value = slotValues.get(slot.slotId)
    if (value === undefined || value.length === 0) {
      throw new ValidationError(
        'intent-secret-required',
        `secret slot ${slot.jsonPointer} (op ${slot.opId}) must be filled at confirm time`,
      )
    }
    secretValues.set(`${slot.opId}:${slot.jsonPointer}`, value)
  }

  // ── final ids: creates mint now; copy decisions normalize update → create ──
  const copyOnly = input.copyOnlyTargets ?? new Map<string, string>()
  for (const op of changeset.ops) {
    if (op.action !== 'update') continue
    const reason = copyOnly.get(op.target)
    if (reason !== undefined && decisionByOp.get(op.opId)?.applyMode !== 'copy') {
      throw new ValidationError(
        'intent-foreign-modify-forbidden',
        `${op.opId}: ${op.target} cannot be modified in place (${reason}) — choose copy`,
        { opId: op.opId, target: op.target, reason },
      )
    }
  }

  const finalIdByRef = new Map<string, string>()
  const copiedHandles = new Map<string, string>() // handle → new id
  for (const op of changeset.ops) {
    if (op.action === 'create') {
      finalIdByRef.set(op.tempRef, ulid())
    } else if (decisionByOp.get(op.opId)?.applyMode === 'copy') {
      const newId = ulid()
      copiedHandles.set(op.target, newId)
      finalIdByRef.set(op.target, newId)
    } else {
      const entry = byHandle.get(op.target)
      if (entry === undefined) {
        throw new ValidationError('intent-ref-unknown', `unknown target handle ${op.target}`)
      }
      finalIdByRef.set(op.target, entry.resourceId)
    }
  }
  const resolveRef = (ref: string): string => {
    const direct = finalIdByRef.get(ref)
    if (direct !== undefined) return direct
    const entry = byHandle.get(ref)
    if (entry !== undefined) return entry.resourceId
    throw new ValidationError('intent-ref-unknown', `unknown reference ${ref}`)
  }

  // ── per-op canonical payloads (slot overlay + ref rewrite) ──
  const nameOf = (op: IntentChangeset['ops'][number]): string => {
    const custom = slotValues.get(`name:${op.opId}`)
    const base = (op.payload as { name: string }).name
    if (custom === undefined || custom.length === 0) return base
    // P1-5: the rename overlay lands AFTER schema parse — re-run the
    // per-type name grammar so a slot value cannot bypass canonical rules.
    const invalid = validateFinalNameForType(op.resourceType, custom)
    if (invalid !== null) {
      throw new ValidationError('intent-slot-value-invalid', `${op.opId}: finalName ${invalid}`, {
        opId: op.opId,
        slotId: `name:${op.opId}`,
      })
    }
    return custom
  }

  const resolved: ResolvedIntentOp[] = []
  for (const op of changeset.ops) {
    const decision = decisionByOp.get(op.opId)
    const isCopy = op.action === 'update' && decision?.applyMode === 'copy'
    const action: 'create' | 'update' = op.action === 'create' || isCopy ? 'create' : 'update'
    const resourceId =
      op.action === 'create'
        ? (finalIdByRef.get(op.tempRef) as string)
        : (finalIdByRef.get(op.target) as string)
    const entry = op.action === 'update' ? byHandle.get(op.target) : undefined
    if (op.action === 'update' && !isCopy) {
      if (entry === undefined || !entry.detail) {
        throw new ValidationError(
          'intent-target-not-mounted',
          `update target ${op.target} is not mounted in detail this epoch`,
        )
      }
    }
    const name = nameOf(op)
    if (action === 'create') {
      const occupied = input.occupiedNames.get(op.resourceType)
      if (occupied?.has(name.toLowerCase()) === true) {
        throw new ValidationError(
          'intent-name-conflict',
          `${op.resourceType} name '${name}' is taken`,
          {
            opId: op.opId,
            name,
          },
        )
      }
    }

    let payload: Record<string, unknown>
    switch (op.resourceType) {
      case 'agent': {
        const p = op.payload
        payload = {
          name,
          description: p.description,
          outputs: p.outputs,
          ...(p.outputKinds === undefined ? {} : { outputKinds: p.outputKinds }),
          ...(p.inputs === undefined ? {} : { inputs: p.inputs }),
          ...(p.outputWrapperPortNames === undefined
            ? {}
            : { outputWrapperPortNames: p.outputWrapperPortNames }),
          ...(p.role === undefined ? {} : { role: p.role }),
          syncOutputsOnIterate: p.syncOutputsOnIterate ?? true,
          ...(p.runtime === undefined ? {} : { runtime: p.runtime }),
          permission: p.permission ?? {},
          skills: p.skills.map((s) =>
            typeof s === 'string' ? { kind: 'managed', skillId: resolveRef(s) } : s,
          ),
          dependsOn: p.dependsOn.map(resolveRef),
          mcp: p.mcp.map(resolveRef),
          plugins: p.plugins.map(resolveRef),
          frontmatterExtra: p.frontmatterExtra ?? {},
          bodyMd: p.bodyMd,
        }
        break
      }
      case 'skill': {
        payload = {
          name,
          description: op.payload.description,
          frontmatterExtra: op.payload.frontmatterExtra ?? {},
          bodyMd: op.payload.bodyMd,
          files: op.payload.files,
        }
        break
      }
      case 'mcp': {
        const config = JSON.parse(JSON.stringify(op.payload.config)) as Record<string, unknown>
        const overlay = (base: string, rec: Record<string, string> | undefined) => {
          for (const key of Object.keys(rec ?? {})) {
            const pointer = `${base}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
            const secret = secretValues.get(`${op.opId}:${pointer}`)
            if (secret !== undefined) (rec as Record<string, string>)[key] = secret
          }
        }
        if (op.payload.type === 'local') {
          overlay('/config/env', (config as { env?: Record<string, string> }).env)
        } else {
          overlay('/config/headers', (config as { headers?: Record<string, string> }).headers)
        }
        payload = {
          type: op.payload.type,
          name,
          description: op.payload.description,
          enabled: op.payload.enabled ?? true,
          config,
        }
        break
      }
      case 'plugin': {
        payload = {
          name,
          spec: op.payload.spec,
          options: op.payload.optionsJson ?? {},
          description: op.payload.description,
          enabled: op.payload.enabled ?? true,
        }
        break
      }
      case 'workflow': {
        const def = JSON.parse(JSON.stringify(op.payload.definition)) as {
          nodes: Array<Record<string, unknown>>
        }
        for (const node of def.nodes) {
          if (node.kind !== 'agent-single') continue
          const ref = node.agentRef as string
          delete node.agentRef
          node.agentId = resolveRef(ref)
        }
        // RFC-253 T28 — inject confirm-time secret values into script env; the
        // sentinel itself must never be persisted as a runtime value.
        for (const [i, scriptNode] of collectScriptEnvNodes(def)) {
          for (const key of Object.keys(scriptNode.env)) {
            const pointer = `/definition/nodes/${i}/env/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
            const secret = secretValues.get(`${op.opId}:${pointer}`)
            if (secret !== undefined) scriptNode.env[key] = secret
          }
        }
        payload = { name, description: op.payload.description, definition: def }
        break
      }
      case 'workgroup': {
        type ResolvedMember =
          | { memberType: 'agent'; agentId: string; displayName: string; roleDesc: string }
          | { memberType: 'human'; userId: string; displayName: string; roleDesc: string }
        const members = op.payload.members.flatMap((m): ResolvedMember[] => {
          if (m.memberType === 'agent') {
            return [
              {
                memberType: 'agent' as const,
                agentId: resolveRef(m.agentRef),
                displayName: m.displayName,
                roleDesc: m.roleDesc,
              },
            ]
          }
          const binding = slotValues.get(`human:${op.opId}:${m.displayName}`)
          if (binding === undefined || binding.length === 0 || binding === 'drop') {
            return [] // unbound placeholder → dropped (user chose not to bind)
          }
          return [
            {
              memberType: 'human' as const,
              userId: binding,
              displayName: m.displayName,
              roleDesc: m.roleDesc,
            },
          ]
        })
        payload = {
          name,
          description: op.payload.description,
          instructions: op.payload.instructions,
          mode: op.payload.mode,
          ...(op.payload.leaderDisplayName === undefined
            ? {}
            : { leaderDisplayName: op.payload.leaderDisplayName }),
          ...(op.payload.outputContract === undefined
            ? {}
            : { outputContract: op.payload.outputContract }),
          switches: op.payload.switches ?? {
            shareOutputs: true,
            directMessages: false,
            blackboard: false,
          },
          maxRounds: op.payload.maxRounds ?? 20,
          completionGate: op.payload.completionGate ?? true,
          ...(op.payload.clarifyBudget === undefined
            ? {}
            : { clarifyBudget: op.payload.clarifyBudget }),
          ...(op.payload.fanOut === undefined ? {} : { fanOut: op.payload.fanOut }),
          members,
        }
        break
      }
    }

    resolved.push({
      opId: op.opId,
      resourceType: op.resourceType,
      resourceId,
      ...(entry === undefined || isCopy ? {} : { manifestEntry: entry }),
      action,
      fromCopy: isCopy,
      // RFC-291 — copies carry their source handle so the commit can retire it
      // as a mount root (and derive the lineage root from the pre-commit
      // manifest). `manifestEntry` stays absent for copies, on purpose.
      ...(isCopy && op.action === 'update' ? { copiedFromHandle: op.target } : {}),
      payload,
    })
  }

  // ── topo order: skills → mcps → plugins → agents (dependsOn) → wf/wg ──
  const typeRank = (t: AclResourceType): number =>
    t === 'skill' ? 0 : t === 'mcp' ? 1 : t === 'plugin' ? 2 : t === 'agent' ? 3 : 4
  const agentDeps = new Map<string, Set<string>>()
  for (const op of resolved) {
    if (op.resourceType !== 'agent') continue
    agentDeps.set(
      op.resourceId,
      new Set(
        (op.payload.dependsOn as string[]).filter((id) =>
          resolved.some((o) => o.resourceId === id),
        ),
      ),
    )
  }
  const ordered = [...resolved].sort((a, b) => typeRank(a.resourceType) - typeRank(b.resourceType))
  // stable insertion-sort agents so dependsOn targets precede dependents
  const agentsOnly = ordered.filter((o) => o.resourceType === 'agent')
  const sortedAgents: ResolvedIntentOp[] = []
  const placed = new Set<string>()
  let guard = agentsOnly.length * agentsOnly.length + 1
  const queue = [...agentsOnly]
  while (queue.length > 0 && guard-- > 0) {
    const op = queue.shift() as ResolvedIntentOp
    const deps = agentDeps.get(op.resourceId) ?? new Set()
    if ([...deps].every((d) => placed.has(d) || !agentsOnly.some((o) => o.resourceId === d))) {
      sortedAgents.push(op)
      placed.add(op.resourceId)
    } else {
      queue.push(op)
    }
  }
  if (queue.length > 0) {
    throw new ValidationError('intent-draft-invalid', 'agent dependsOn cycle within the bundle')
  }
  let agentCursor = 0
  const finalOps = ordered.map((op) =>
    op.resourceType === 'agent' ? (sortedAgents[agentCursor++] as ResolvedIntentOp) : op,
  )

  void handleTypeOf
  return { ops: finalOps, finalIdByRef, secretValues, waivedPointers }
}
