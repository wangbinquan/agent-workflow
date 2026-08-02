// RFC-247 D3 / D4-2 / C10 / AC-8 / AC-23 — the token matrix derivation.
//
// This is the data behind the account page's permission picker. Two properties
// carry real weight and are easy to break by accident:
//
//   · a role never sees a cell it cannot actually grant (AC-23). Rendering an
//     ungrantable cell as "disabled" would teach the user the capability exists
//     for them and is merely off, which is the opposite of true.
//   · no template ever selects a delete point (AC-8), "full" included. A
//     template is chosen in one click by someone who decided not to read the
//     grid — fine for "may create workflows", not fine for "may delete every
//     workflow it can see".

import { describe, expect, it } from 'vitest'
import { grantableMatrixPoints, type Permission } from '@agent-workflow/shared'
import {
  buildMatrix,
  matchingTemplate,
  selectionHasDelete,
  templatePoints,
} from '@/lib/token-matrix'

describe('RFC-247 buildMatrix — only grantable cells (AC-23)', () => {
  it('every produced cell is one the role can really grant', () => {
    for (const role of ['user', 'manager', 'admin'] as const) {
      const grantable = new Set(grantableMatrixPoints(role))
      for (const row of buildMatrix(role)) {
        for (const cell of row.cells) {
          expect(grantable.has(cell.permission)).toBe(true)
        }
      }
    }
  })

  it('a plain user is offered no repos cell at all', () => {
    // repos writes belong to manager/admin. Omitted, not disabled.
    const rows = buildMatrix('user')
    expect(rows.find((r) => r.resource === 'repos')).toBeUndefined()
  })

  it('a manager IS offered repos cells', () => {
    const repos = buildMatrix('manager').find((r) => r.resource === 'repos')
    expect(repos).toBeDefined()
    expect(repos!.cells.map((c) => c.verb).sort()).toEqual(['create', 'delete', 'execute'])
  })

  it('never produces a row with zero cells', () => {
    for (const role of ['user', 'manager', 'admin'] as const) {
      for (const row of buildMatrix(role)) expect(row.cells.length).toBeGreaterThan(0)
    }
  })

  it('offers no verb that has no route behind it', () => {
    // `repos:update` and `skills:execute` were never created (no route
    // implements them); a matrix that offered them would advertise a capability
    // that maps to no endpoint.
    const all = buildMatrix('admin').flatMap((r) => r.cells.map((c) => c.permission))
    expect(all).not.toContain('repos:update')
    expect(all).not.toContain('skills:execute')
    // …and the two launch-subject verbs RFC-165 F15/N1 rules out
    expect(all).not.toContain('agents:execute')
    expect(all).not.toContain('workgroups:execute')
  })

  it('marks delete cells so the UI can weight them', () => {
    for (const row of buildMatrix('admin')) {
      for (const cell of row.cells) {
        expect(cell.isDelete).toBe(cell.verb === 'delete')
      }
    }
  })
})

describe('RFC-247 templates — no template grants delete (AC-8)', () => {
  for (const template of ['read-only', 'task-automation', 'full'] as const) {
    for (const role of ['user', 'manager', 'admin'] as const) {
      it(`${template} / ${role} selects no delete point`, () => {
        const points = templatePoints(template, role)
        expect(points.filter((p) => p.endsWith(':delete'))).toEqual([])
      })
    }
  }

  it('read-only is the empty matrix — reads are always on', () => {
    expect(templatePoints('read-only', 'admin')).toEqual([])
  })

  it('task-automation covers the task and schedule domains and nothing else', () => {
    const points = templatePoints('task-automation', 'admin')
    expect(points.length).toBeGreaterThan(0)
    for (const p of points) {
      expect(p.startsWith('tasks:') || p.startsWith('scheduled-tasks:')).toBe(true)
    }
    // it must actually let a token launch work, or the template is a lie
    expect(points).toContain('tasks:execute')
  })

  it('task-automation grants nothing that edits a resource definition', () => {
    const points = templatePoints('task-automation', 'admin')
    for (const p of points) {
      expect(p.startsWith('workflows:')).toBe(false)
      expect(p.startsWith('agents:')).toBe(false)
      expect(p.startsWith('skills:')).toBe(false)
    }
  })

  it('full covers every grantable non-delete point for the role', () => {
    for (const role of ['user', 'manager', 'admin'] as const) {
      const expected = grantableMatrixPoints(role).filter((p) => !p.endsWith(':delete'))
      expect([...templatePoints('full', role)].sort()).toEqual([...expected].sort())
    }
  })

  it('never offers a role a point outside its own grantable set', () => {
    for (const template of ['read-only', 'task-automation', 'full'] as const) {
      const grantable = new Set(grantableMatrixPoints('user'))
      for (const p of templatePoints(template, 'user')) expect(grantable.has(p)).toBe(true)
    }
  })
})

describe('RFC-247 matchingTemplate — reflect the selection back accurately', () => {
  it('an empty selection reads as read-only', () => {
    expect(matchingTemplate(new Set(), 'admin')).toBe('read-only')
  })

  it('an exact template selection is recognised', () => {
    const points = new Set(templatePoints('task-automation', 'admin'))
    expect(matchingTemplate(points, 'admin')).toBe('task-automation')
  })

  it('adding ONE delete point stops it matching any template', () => {
    // Precisely the case the UI must not mislabel: a "full" chip on a selection
    // that also deletes would hide the one thing worth noticing.
    const points = new Set<Permission>(templatePoints('full', 'admin'))
    points.add('agents:delete')
    expect(matchingTemplate(points, 'admin')).toBe(null)
  })

  it('a partial selection matches nothing', () => {
    expect(matchingTemplate(new Set<Permission>(['agents:create']), 'admin')).toBe(null)
  })
})

describe('RFC-247 selectionHasDelete', () => {
  it('is false for every template', () => {
    for (const template of ['read-only', 'task-automation', 'full'] as const) {
      expect(selectionHasDelete(new Set(templatePoints(template, 'admin')))).toBe(false)
    }
  })

  it('is true as soon as one delete point is ticked', () => {
    expect(selectionHasDelete(new Set<Permission>(['tasks:delete']))).toBe(true)
  })
})
