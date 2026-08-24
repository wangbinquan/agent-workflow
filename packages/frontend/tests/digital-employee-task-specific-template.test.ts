import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { validateDigitalEmployeeTypeSearch } from '../src/routes/digital-employees.$typeRef'

const caseDetailSource = readFileSync(
  resolve(import.meta.dirname, '../src/routes/employee-cases.$caseId.tsx'),
  'utf8',
)
const employeeTypeSource = readFileSync(
  resolve(import.meta.dirname, '../src/routes/digital-employees.$typeRef.tsx'),
  'utf8',
)
const styles = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8')

describe('digital employee task specific template navigation', () => {
  test('preserves only a non-empty job template request on the jobs workspace', () => {
    expect(
      validateDigitalEmployeeTypeSearch({ view: 'jobs', jobTemplateId: 'job-template-9' }),
    ).toEqual({ view: 'jobs', jobTemplateId: 'job-template-9' })
    expect(validateDigitalEmployeeTypeSearch({ view: 'jobs', jobTemplateId: '   ' })).toEqual({
      view: 'jobs',
    })
    expect(
      validateDigitalEmployeeTypeSearch({
        view: 'employees',
        jobTemplateId: 'job-template-9',
        employeeId: 'employee-1',
      }),
    ).toEqual({ view: 'employees' })
  })

  test('preserves a role-level tool target only when both role and slot are present', () => {
    expect(
      validateDigitalEmployeeTypeSearch({
        view: 'toolbox',
        workItem: 'analyze-implement',
        toolRole: ' planning ',
        toolSlot: ' plan ',
      }),
    ).toEqual({
      view: 'toolbox',
      workItem: 'analyze-implement',
      toolRole: 'planning',
      toolSlot: 'plan',
    })
    expect(
      validateDigitalEmployeeTypeSearch({
        view: 'toolbox',
        workItem: 'analyze-implement',
        toolRole: 'planning',
      }),
    ).toEqual({ view: 'toolbox', workItem: 'analyze-implement' })
  })

  test('the Case action carries the frozen job template id', () => {
    expect(caseDetailSource).toContain("view: 'jobs'")
    expect(caseDetailSource).toContain('jobTemplateId: data.capabilityActivation.jobTemplateRef.id')
  })

  test('the jobs workspace opens the requested template in its editor', () => {
    expect(employeeTypeSource).toContain('requestedJobTemplateId={search.jobTemplateId}')
    expect(employeeTypeSource).toContain('openExistingRef.current(requestedJobTemplate)')
  })

  test('the employee dialog form and custom select chain can shrink inside the dialog body', () => {
    expect(styles).toMatch(/\.employee-dialog-form\s*\{[^}]*min-width:\s*0;/s)
    expect(styles).toMatch(/\.form-field\s*\{[^}]*min-width:\s*0;/s)
    expect(styles).toMatch(/\.select\s*\{[^}]*min-width:\s*0;/s)
    expect(styles).toMatch(/\.select__trigger\s*\{[^}]*min-width:\s*0;/s)
    expect(styles).toMatch(/\.select__value\s*\{[^}]*min-width:\s*0;/s)
  })
})
