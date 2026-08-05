// RFC-016 §7 / C3: source-level guard that the wrapper rendering CSS has
// migrated from the old placeholder card to the new group container. JSDOM
// doesn't run layout so a visual-position assertion would be misleading;
// we instead lock the *presence* of the new rules and the *absence* of the
// old ones so future refactors can't silently regress the wrapper visual
// contract.

import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

async function styles(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return fs.readFile(path.join(here, '../src/styles.css'), 'utf8')
}

async function wrapperNodes(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return fs.readFile(path.join(here, '../src/components/canvas/nodes/WrapperNodes.tsx'), 'utf8')
}

describe('styles.css wrapper rule migration', () => {
  test('legacy .canvas-node--wrapper {} block is gone (was the 240px placeholder)', async () => {
    const css = await styles()
    expect(css).not.toMatch(/\.canvas-node--wrapper\s*\{/)
  })

  test('legacy per-kind .canvas-node--wrapper-git / -loop blocks are gone', async () => {
    const css = await styles()
    expect(css).not.toMatch(/\.canvas-node--wrapper-git\s*\{/)
    expect(css).not.toMatch(/\.canvas-node--wrapper-loop\s*\{/)
  })

  test('new .canvas-node--wrapper-group rule + per-kind modifiers are present', async () => {
    const css = await styles()
    expect(css).toMatch(/\.canvas-node--wrapper-group\s*\{/)
    expect(css).toMatch(/\.canvas-node--wrapper-group--git\s*\{/)
    expect(css).toMatch(/\.canvas-node--wrapper-group--loop\s*\{/)
  })

  test('drop-hover / leave-hint feedback classes are wired up', async () => {
    const css = await styles()
    expect(css).toMatch(/\.canvas-node--wrapper-group--drop-hover\s*\{/)
    expect(css).toMatch(/\.canvas-node--wrapper-group--leave-hint\s*\{/)
  })

  test('wrapper-header-pill rule is defined', async () => {
    const css = await styles()
    expect(css).toMatch(/\.wrapper-header-pill\s*\{/)
  })

  // Regression: wrapper output ports (git_diff, loop outputBindings) are
  // rendered along the BOTTOM edge centered, NOT on the right side. The
  // shared right-side port-rows path doesn't fit wrappers — wrapper-group
  // carries `padding: 0` (so the visible rect matches the bbox xyflow uses
  // for child clipping), and the default -14px right-handle offset would
  // push the dot outside the wrapper. JSDOM doesn't run layout, so we lock
  // the CSS source.
  test('bottom-port rule for wrapper output ports is defined', async () => {
    const css = await styles()
    expect(css).toMatch(/\.canvas-node__bottom-ports\s*\{/)
    expect(css).toMatch(/\.canvas-node__bottom-port\s*\{/)
    // Anchored to the wrapper bottom edge with horizontal centering.
    expect(css).toMatch(
      /\.canvas-node__bottom-ports\s*\{[^}]*position:\s*absolute[^}]*bottom:\s*0[^}]*justify-content:\s*center/s,
    )
  })
})

describe('WrapperNodes.tsx component-level guards', () => {
  test('exports unified GroupWrapperNode (not two separate components)', async () => {
    const src = await wrapperNodes()
    expect(src).toMatch(/export function GroupWrapperNode\(/)
  })

  test('component sets the canvas-node--wrapper-group class', async () => {
    const src = await wrapperNodes()
    expect(src).toMatch(/canvas-node--wrapper-group/)
  })

  test('loop branch keeps the RFC-003 INBOUND catch-all but renders no named left ports', async () => {
    const src = await wrapperNodes()
    // catch-all is still referenced — wrapper accepts inbound drops.
    expect(src).toMatch(/INBOUND_HANDLE_ID/)
    // The legacy `side="left" ports={data.inputPorts}` invocation is gone.
    expect(src).not.toMatch(/side="left"\s+ports={data\.inputPorts}/)
  })

  test('output ports render along bottom edge (Position.Bottom), not via PortHandles side="right"', async () => {
    const src = await wrapperNodes()
    // Bottom-port column rendering present.
    expect(src).toMatch(/canvas-node__bottom-ports/)
    expect(src).toMatch(/Position\.Bottom/)
    // The previous `<PortHandles side="right" ports={data.outputPorts} />`
    // invocation is gone — wrappers must NOT use the shared right-side path.
    expect(src).not.toMatch(/side="right"\s+ports={data\.outputPorts}/)
  })
})
