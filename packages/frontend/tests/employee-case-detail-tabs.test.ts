import { describe, expect, it } from 'vitest'

import {
  EMPLOYEE_CASE_DETAIL_TABS,
  isEmployeeCaseDetailTab,
  validateEmployeeCaseDetailSearch,
  withEmployeeCaseDetailTab,
} from '../src/lib/employee-case-detail-tabs'

describe('employee Case detail route tabs', () => {
  it('accepts exactly the five RFC-337 destinations', () => {
    expect(EMPLOYEE_CASE_DETAIL_TABS).toEqual([
      'overview',
      'details',
      'artifacts',
      'execution',
      'activity',
    ])
    for (const tab of EMPLOYEE_CASE_DETAIL_TABS) expect(isEmployeeCaseDetailTab(tab)).toBe(true)
    expect(isEmployeeCaseDetailTab('inputs')).toBe(false)
    expect(isEmployeeCaseDetailTab(null)).toBe(false)
  })

  it('drops an unknown tab without discarding unrelated search state', () => {
    expect(validateEmployeeCaseDetailSearch({ tab: 'unknown', trace: 'keep' })).toEqual({
      trace: 'keep',
    })
  })

  it('updates only the tab key', () => {
    expect(withEmployeeCaseDetailTab({ trace: 'keep', tab: 'details' }, 'artifacts')).toEqual({
      trace: 'keep',
      tab: 'artifacts',
    })
  })
})
