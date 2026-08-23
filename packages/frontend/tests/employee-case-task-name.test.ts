// User regression 2026-08-23: the Case detail used the employee display name
// as its title and replaced the exact employee identity with generic lifecycle copy.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'employee-cases.$caseId.tsx'),
  'utf8',
)

describe('digital employee Case task naming', () => {
  test('uses the persisted task name as the page title', () => {
    expect(source).toContain('title={data.case.name}')
    expect(source).not.toContain(
      "data.capabilityActivation.displayName || (zh ? '数字员工任务' : 'Digital employee task')",
    )
  })

  test('shows the broad category followed by the exact employee name', () => {
    expect(source).toContain('localized(data.employeeType.displayName, language)')
    expect(source).toContain('data.capabilityActivation.displayName')
    expect(source).not.toContain('持续负责到外部合入或结束')
  })
})
