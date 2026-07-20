// Regression: the workflow editor's grid container used to ALWAYS get
// the `editor-layout--with-inspector` class, which locks a 480px third
// column for the inspector drawer. NodeInspector returns null when no
// node is selected, so the column was reserved-but-empty and the middle
// `1fr` canvas column was squeezed down to ~0px on narrow viewports —
// at which point users could no longer drop palette items onto the
// canvas (no hit-testable surface).
//
// Now the class only appears when there's a selected node. This test
// pins that contract on the small pure helper that produces the class.

import { describe, expect, test } from 'vitest'
import { editorLayoutClass } from '../src/routes/workflows.edit'

describe('editorLayoutClass', () => {
  test('no selection: base class only, no inspector column reserved', () => {
    expect(editorLayoutClass(null)).toBe('editor-layout editor-layout--wide')
    expect(editorLayoutClass(null)).not.toContain('--with-inspector')
  })

  test('selection: inspector column reserved', () => {
    expect(editorLayoutClass('agent_1')).toBe(
      'editor-layout editor-layout--wide editor-layout--with-inspector',
    )
  })

  test('toggle is purely a function of selection state', () => {
    // The flow is: user clicks a node → class flips on → user clicks
    // empty pane → selectedId reverts to null → class flips off.
    // Reproduce that round trip.
    let cls = editorLayoutClass(null)
    expect(cls).not.toContain('--with-inspector')
    cls = editorLayoutClass('node_xyz')
    expect(cls).toContain('--with-inspector')
    cls = editorLayoutClass(null)
    expect(cls).not.toContain('--with-inspector')
  })

  test('compact and phone modes never reserve a hidden inspector track', () => {
    expect(editorLayoutClass('agent_1', 'compact')).toBe('editor-layout editor-layout--compact')
    expect(editorLayoutClass('agent_1', 'phone')).toBe('editor-layout editor-layout--phone')
  })
})
