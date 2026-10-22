export const EMPLOYEE_CASE_DETAIL_TABS = [
  'overview',
  'design',
  'details',
  'artifacts',
  'execution',
  'activity',
] as const

export type EmployeeCaseDetailTab = (typeof EMPLOYEE_CASE_DETAIL_TABS)[number]

const EMPLOYEE_CASE_DETAIL_TAB_SET = new Set<string>(EMPLOYEE_CASE_DETAIL_TABS)

export interface EmployeeCaseDetailSearch extends Record<string, unknown> {
  tab?: EmployeeCaseDetailTab
  designSelection?: string[]
  designView?: string
}

export function isEmployeeCaseDetailTab(value: unknown): value is EmployeeCaseDetailTab {
  return typeof value === 'string' && EMPLOYEE_CASE_DETAIL_TAB_SET.has(value)
}

/** Preserve unrelated search state while dropping an unknown detail destination. */
export function validateEmployeeCaseDetailSearch(
  raw: Record<string, unknown>,
): EmployeeCaseDetailSearch {
  const { tab: _invalidTab, ...rest } = raw
  const result: EmployeeCaseDetailSearch = isEmployeeCaseDetailTab(raw.tab)
    ? { ...rest, tab: raw.tab }
    : rest
  delete result.designSelection
  delete result.designView
  if (
    Array.isArray(raw.designSelection) &&
    raw.designSelection.length <= 250 &&
    raw.designSelection.every((id) => typeof id === 'string' && id.length <= 200)
  )
    result.designSelection = raw.designSelection
  if (typeof raw.designView === 'string' && raw.designView.length <= 200)
    result.designView = raw.designView
  return result
}

export function withEmployeeCaseDetailTab<T extends Record<string, unknown>>(
  previous: T,
  tab: EmployeeCaseDetailTab,
): T & { tab: EmployeeCaseDetailTab } {
  return { ...previous, tab }
}
