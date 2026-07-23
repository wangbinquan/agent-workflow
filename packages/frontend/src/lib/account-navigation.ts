export const ACCOUNT_SECTIONS = ['overview', 'security', 'tokens'] as const
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number]

export interface AccountSearch extends Record<string, unknown> {
  section?: Exclude<AccountSection, 'overview'>
}

export function parseAccountSection(value: unknown): AccountSection {
  return typeof value === 'string' && (ACCOUNT_SECTIONS as readonly string[]).includes(value)
    ? (value as AccountSection)
    : 'overview'
}

export function validateAccountSearch(raw: Record<string, unknown>): AccountSearch {
  const { section, ...adjacent } = raw
  const parsed = parseAccountSection(section)
  return parsed === 'overview' ? adjacent : { ...adjacent, section: parsed }
}

export function withAccountSection<T extends Record<string, unknown>>(
  previous: T,
  section: AccountSection,
): T & { section?: Exclude<AccountSection, 'overview'> } {
  const { section: _previousSection, ...adjacent } = previous
  return (section === 'overview' ? adjacent : { ...adjacent, section }) as T & {
    section?: Exclude<AccountSection, 'overview'>
  }
}
