// User regression 2026-08-23: the digital-employee task detail had the full
// responsibility map and all ReactionRounds, but a running capability was only
// a static blue card. This locks the workflow-matching live pulse, completed
// green state, selection/state separation, and the uncollapsed history timeline.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const read = (file: string): string =>
  readFileSync(resolve(import.meta.dirname, '..', 'src', file), 'utf8')

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `selector ${selector} was not found`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('\n}', start)
  expect(end, `selector ${selector} was not closed`).toBeGreaterThan(start)
  return css.slice(start, end + 2)
}

describe('digital employee task runtime visualization', () => {
  test('completed capabilities stay green and running capabilities pulse like workflow nodes', () => {
    const css = read('styles.css')
    const completed = block(css, '.employee-toolbox-card--completed')
    const running = block(css, '.employee-toolbox-card--running')

    expect(completed).toContain('var(--success)')
    expect(running).toContain('animation: employee-runtime-node-running-pulse 1.4s')
    expect(css).toContain('@keyframes employee-runtime-node-running-pulse')
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.employee-toolbox-card--running \{[\s\S]*?animation: none/,
    )
  })

  test('selecting a historical node does not overwrite its runtime color', () => {
    const css = read('styles.css')

    expect(css).toContain('.employee-toolbox-card--active:not(')
    expect(css).toContain('.employee-toolbox-card--active:is(')
    expect(css).toContain('.employee-toolbox-card--completed,')
    expect(css).toContain('outline-offset: 1px')
  })

  test('composite ingress and review tools fit their capability-lane grid tracks', () => {
    const css = read('styles.css')
    const ingress = block(css, '.employee-toolbox-ingress-branch')
    const review = block(css, '.employee-toolbox-review-branch')
    const panorama = read('components/digital-employees/ResponsibilitySwimlaneMap.tsx')

    expect(ingress).toContain('width: 100%')
    expect(ingress).not.toContain('width: 224px')
    expect(review).toContain('width: 100%')
    expect(review).not.toContain('width: 168px')
    expect(panorama).toContain("() => 'minmax(0, 1fr)'")
  })

  test('the page renders the active capability panorama and every round on a chronological timeline', () => {
    const detail = read('routes/employee-cases.$caseId.tsx')
    const panorama = read('components/digital-employees/ResponsibilitySwimlaneMap.tsx')

    expect(detail).toContain("zh ? '数字员工实际能力图'")
    expect(detail).toContain('<EmployeeCapabilityPanorama')
    expect(detail).toContain('toolState={runtimeToolState}')
    expect(detail).toContain('reviewToolState={runtimeReviewToolState}')
    expect(detail).toContain('data.capabilityActivation.activeWorkItemRefs')
    expect(panorama).toContain('export function EmployeeCapabilityPanorama')
    expect(panorama).toContain("mode: 'conditional' | 'active'")
    expect(panorama).toContain('capabilityToolState(item)?.active !== false')
    expect(detail).toContain("zh ? '任务流水 · 时间轴'")
    expect(detail).toContain("? '历史执行过的所有节点'")
    expect(detail).toContain('const chronologicalRounds = [...data.rounds].sort(')
    expect(detail).toContain('chronologicalRounds.map((round, index) =>')
    expect(detail).toContain('latestRoundByWorkItem.set(round.workItemRef, round)')
    expect(detail).not.toContain('latestRoundByWorkItem.values()')
  })
})
