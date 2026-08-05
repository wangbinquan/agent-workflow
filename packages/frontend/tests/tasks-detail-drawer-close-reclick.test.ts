// Regression: in /tasks/:id, clicking a node opens the NodeDetailDrawer.
// Until this test landed, the drawer ✕ called only `setSelectedNodeRunId(null)`
// — it never told `WorkflowCanvas` to release its xyflow selection. The
// underlying node stayed highlighted and a re-click on it was swallowed
// by xyflow's `handleNodeClick` (selected && !multiSelectActive → no-op).
//
// Fix: forward a `WorkflowCanvasHandle` ref into `TaskStatusCanvas` and
// call `clearSelection()` from a `closeNodeDrawer` helper that wraps the
// state-clearing path. Mirrors the editor route (`workflows.edit.tsx`).
//
// We pin the wiring textually because driving xyflow drag events in
// happy-dom is unreliable (see comment in `canvas-edge-changes.test.ts`).

import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/routes/tasks.detail.tsx',
)

describe('tasks.detail wires NodeDetailDrawer close through WorkflowCanvas.clearSelection', () => {
  test('imports WorkflowCanvasHandle alongside WorkflowCanvas', async () => {
    const src = await fs.readFile(SRC, 'utf8')
    expect(src).toMatch(
      /import \{ WorkflowCanvas, type WorkflowCanvasHandle \} from '@\/components\/canvas\/WorkflowCanvas'/,
    )
  })

  test('TaskDetailPage owns a canvasRef of WorkflowCanvasHandle', async () => {
    const src = await fs.readFile(SRC, 'utf8')
    expect(src).toMatch(/const canvasRef = useRef<WorkflowCanvasHandle \| null>\(null\)/)
  })

  test('drawer onClose is wired to a helper that calls clearSelection BEFORE clearing local state', async () => {
    const src = await fs.readFile(SRC, 'utf8')
    // The order matters: clearing local state first would unmount the
    // drawer instantly but leave xyflow's selection stuck (the original
    // bug). Pin both the call AND its position relative to setSelectedNodeRunId.
    const helper = src.match(
      /const closeNodeDrawer = \(\) => \{\s*canvasRef\.current\?\.clearSelection\(\)\s*setSelectedNodeRunId\(null\)\s*\}/,
    )
    expect(helper).not.toBeNull()
    expect(src).toMatch(/onClose=\{closeNodeDrawer\}/)
    // Forbid the old broken pattern.
    expect(src).not.toMatch(/onClose=\{\(\) => setSelectedNodeRunId\(null\)\}/)
  })

  test('TaskStatusCanvas accepts canvasRef and forwards it to WorkflowCanvas', async () => {
    const src = await fs.readFile(SRC, 'utf8')
    // Prop on the inner component. RFC-158 narrowed React.Ref → RefObject so the
    // onSelect review branch can read canvasRef.current?.clearSelection().
    expect(src).toMatch(/canvasRef\?: React\.RefObject<WorkflowCanvasHandle \| null>/)
    // ...threaded into WorkflowCanvas.
    expect(src).toMatch(/<WorkflowCanvas\s+ref=\{canvasRef\}/)
  })
})
