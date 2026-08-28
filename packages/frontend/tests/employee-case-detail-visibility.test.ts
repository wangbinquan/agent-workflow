import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const read = (file: string): string =>
  readFileSync(resolve(import.meta.dirname, '..', 'src', file), 'utf8')

describe('RFC-337 employee Case detail visibility', () => {
  test('uses five URL-backed panes instead of one vertical card stream', () => {
    const route = read('routes/employee-cases.$caseId.tsx')

    expect(route).toContain('validateSearch: validateEmployeeCaseDetailSearch')
    expect(route).toContain('<PageSectionNav<EmployeeCaseDetailTab>')
    for (const tab of ['overview', 'details', 'artifacts', 'execution', 'activity']) {
      expect(route).toContain(`tab === '${tab}'`)
    }
    expect(route).toContain('withEmployeeCaseDetailTab(previous, nextTab)')
  })

  test('shows one completed runtime input and never routes it back to authoring', () => {
    const route = read('routes/employee-cases.$caseId.tsx')
    const panorama = read('components/digital-employees/EmployeeCapabilityPanorama.tsx')

    expect(route).toContain('runtimeIngress={{')
    expect(route).toContain("state: 'completed'")
    expect(route).toContain("detail: zh ? '已接收' : 'Received'")
    expect(route).toContain('onSelectIngress={selectRuntimeInput}')
    expect(route).toContain('data-testid="employee-case-input-inspector"')
    expect(route).not.toContain("to: '/tasks/new'")
    expect(route).not.toContain("to: '/events'")
    expect(panorama).toContain('projectedIngresses.find(')
    expect(panorama).toContain('props.runtimeIngress.presentation')
  })

  test('renders the same exact MR href on page, artifact, region, work-item, and inspector surfaces', () => {
    const route = read('routes/employee-cases.$caseId.tsx')
    const panorama = read('components/digital-employees/EmployeeCapabilityPanorama.tsx')
    const display = read('components/digital-employees/ResponsibilityFlowDisplay.tsx')

    expect(route).toContain('data-testid="employee-case-header-mr-link"')
    expect(route).toContain('data-testid="employee-case-overview-mr"')
    expect(route).toContain('data-testid="employee-case-artifact-mr"')
    expect(route).toContain('data-testid="employee-case-selected-work-item-mr-link"')
    expect(route.match(/href=\{delivery\.webUrl\}/g)?.length).toBeGreaterThanOrEqual(4)
    expect(route).toContain('externalResourceAction={(target) =>')
    expect(panorama).toContain('employee-toolbox-region__external-action')
    expect(display).toContain('employee-toolbox-card__external-action')
    expect(display).toContain('target="_blank"')
  })

  test('keeps long inputs, JSON, changed paths, and mobile columns bounded', () => {
    const route = read('routes/employee-cases.$caseId.tsx')
    const styles = read('styles.css')

    expect(route).toContain(
      'const targetBranch = detail.workspace?.targetBranch ?? repository?.defaultBranch ?? null',
    )
    expect(route).not.toContain(
      'detail.workspace?.targetBranch ?? delivery?.targetBranch ?? repository?.defaultBranch',
    )
    expect(styles).toContain('.employee-case-input-block > pre')
    expect(styles).toContain('.employee-case-path-list--bounded')
    expect(styles).toContain('.employee-case-fact-grid')
    expect(styles).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.employee-case-fact-grid,[\s\S]*?grid-template-columns: 1fr/,
    )
  })
})
