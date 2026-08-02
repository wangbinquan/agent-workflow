// RFC-247 D3 / D4 / C10 — the token authorization matrix, as pure data.
//
// The account page renders this; the logic lives here so it can be asserted
// without a DOM. Everything below derives from the shared permission catalog —
// there is no second list of resources or verbs to drift out of sync, which is
// the same reason the backend derives its gate from the route declarations
// rather than from a parallel table.

import {
  grantableMatrixPoints,
  MATRIX_RESOURCES,
  MATRIX_VERBS,
  type MatrixResource,
  type MatrixVerb,
  type Permission,
  type Role,
} from '@agent-workflow/shared'

/** One cell: a (resource, verb) pair the current role is allowed to tick. */
export interface MatrixCell {
  readonly resource: MatrixResource
  readonly verb: MatrixVerb
  readonly permission: Permission
  /**
   * RFC-247 D4 — delete is opt-in per point and never rides a preset. The UI
   * marks these so the weight of the choice is visible at the moment of making
   * it, not discovered later.
   */
  readonly isDelete: boolean
}

/** One row of the advanced grid: a resource plus the verbs this role may grant. */
export interface MatrixRow {
  readonly resource: MatrixResource
  readonly cells: ReadonlyArray<MatrixCell>
}

/**
 * Build the grid for one role.
 *
 * RFC-247 C10 / AC-23: only cells the role can ACTUALLY grant are produced. A
 * plain user never sees a repos write cell, because `repos:*` writes belong to
 * manager and admin — rendering it disabled would be worse than omitting it: it
 * teaches the user that the capability exists for them and is merely switched
 * off, which is the opposite of true.
 *
 * A resource whose row would be empty is dropped entirely rather than rendered
 * as a header with nothing under it.
 */
export function buildMatrix(role: Role): ReadonlyArray<MatrixRow> {
  const grantable = new Set(grantableMatrixPoints(role))
  const rows: MatrixRow[] = []
  for (const resource of MATRIX_RESOURCES) {
    const cells: MatrixCell[] = []
    for (const verb of MATRIX_VERBS) {
      const permission = `${resource}:${verb}` as Permission
      if (!grantable.has(permission)) continue
      cells.push({ resource, verb, permission, isDelete: verb === 'delete' })
    }
    if (cells.length > 0) rows.push({ resource, cells })
  }
  return rows
}

/** The preset templates offered above the advanced grid (RFC-247 C10). */
export type TemplateId = 'read-only' | 'task-automation' | 'full'

export interface TemplateDef {
  readonly id: TemplateId
  /**
   * Which points this template selects, given the role's grantable set.
   * NEVER includes a delete point — see `templatePoints`.
   */
  readonly select: (grantable: ReadonlySet<Permission>) => ReadonlyArray<Permission>
}

/**
 * RFC-247 D4-2 — **no template ever includes a delete point**, the "full"
 * template included.
 *
 * The reason is about how presets are used: a preset is picked in one click by
 * someone who has decided not to read the grid. That is fine for "may create
 * workflows" and not fine for "may delete every workflow it can see". Delete
 * stays a deliberate, individual tick.
 */
export function templatePoints(template: TemplateId, role: Role): ReadonlyArray<Permission> {
  const grantable = new Set(grantableMatrixPoints(role))
  const notDelete = (p: Permission): boolean => !p.endsWith(':delete')
  switch (template) {
    case 'read-only':
      // Empty matrix. Reads are always on (D3), so this is a complete,
      // meaningful token — not a degenerate one.
      return []
    case 'task-automation':
      // Everything needed to launch work and carry it through its human gates,
      // and nothing that edits the definitions being run.
      return [...grantable].filter(
        (p) => notDelete(p) && (p.startsWith('tasks:') || p.startsWith('scheduled-tasks:')),
      )
    case 'full':
      return [...grantable].filter(notDelete)
  }
}

/** Which template, if any, exactly matches the current selection. */
export function matchingTemplate(selected: ReadonlySet<Permission>, role: Role): TemplateId | null {
  for (const id of ['read-only', 'task-automation', 'full'] as const) {
    const points = templatePoints(id, role)
    if (points.length !== selected.size) continue
    if (points.every((p) => selected.has(p))) return id
  }
  return null
}

/**
 * Does this selection contain any delete point? Drives the confirmation copy —
 * a token that can delete deserves to say so before it is minted.
 */
export function selectionHasDelete(selected: ReadonlySet<Permission>): boolean {
  for (const p of selected) if (p.endsWith(':delete')) return true
  return false
}
