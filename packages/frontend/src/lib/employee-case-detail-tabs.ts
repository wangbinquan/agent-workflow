export const EMPLOYEE_CASE_DETAIL_TABS = [
  'overview',
  'details',
  'artifacts',
  'execution',
  'activity',
] as const

export type EmployeeCaseDetailTab = (typeof EMPLOYEE_CASE_DETAIL_TABS)[number]

const EMPLOYEE_CASE_DETAIL_TAB_SET = new Set<string>(EMPLOYEE_CASE_DETAIL_TABS)

export interface EmployeeCaseDetailSearch extends Record<string, unknown> {
  tab?: EmployeeCaseDetailTab
}

export function isEmployeeCaseDetailTab(value: unknown): value is EmployeeCaseDetailTab {
  return typeof value === 'string' && EMPLOYEE_CASE_DETAIL_TAB_SET.has(value)
}

/** Preserve unrelated search state while dropping an unknown detail destination. */
export function validateEmployeeCaseDetailSearch(
  raw: Record<string, unknown>,
): EmployeeCaseDetailSearch {
  const { tab: _invalidTab, ...rest } = raw
  return isEmployeeCaseDetailTab(raw.tab) ? { ...rest, tab: raw.tab } : rest
}

export function withEmployeeCaseDetailTab<T extends Record<string, unknown>>(
  previous: T,
  tab: EmployeeCaseDetailTab,
): T & { tab: EmployeeCaseDetailTab } {
  return { ...previous, tab }
}
