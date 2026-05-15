// Regression: the task-detail canvas grid container used to ALWAYS
// get a `1fr 480px` grid-template-columns. NodeDetailDrawer returns
// null when no node-run is selected, so the column was
// reserved-but-empty and the canvas got squeezed to ~82px on narrow
// viewports (e.g. with a 220px sidebar + 638px main + 32px padding ×
// 2, the canvas track resolved to 574 - 480 - 12 = 82px). The user
// then sees a workflow that "doesn't fill the screen."
//
// Now the `--with-drawer` modifier is only applied when there's an
// actually-rendered drawer. Mirror of `editorLayoutClass` from the
// workflow editor.

import { describe, expect, test } from 'vitest'
import { taskCanvasLayoutClass } from '../src/routes/tasks.detail'

describe('taskCanvasLayoutClass', () => {
  test('no selected node run: base class only, no drawer column reserved', () => {
    expect(taskCanvasLayoutClass(null)).toBe('task-canvas-layout')
    expect(taskCanvasLayoutClass(null)).not.toContain('--with-drawer')
  })

  test('with a selected node run: drawer column reserved', () => {
    expect(taskCanvasLayoutClass('nr_01234')).toBe(
      'task-canvas-layout task-canvas-layout--with-drawer',
    )
  })

  test('toggle is purely a function of selection state', () => {
    let cls = taskCanvasLayoutClass(null)
    expect(cls).not.toContain('--with-drawer')
    cls = taskCanvasLayoutClass('nr_abcdef')
    expect(cls).toContain('--with-drawer')
    cls = taskCanvasLayoutClass(null)
    expect(cls).not.toContain('--with-drawer')
  })
})
