// RFC-398 §3.6: dependency-free values shared by domain validation and runtimes.
export type PostgresqlProfileRef =
  | { readonly kind: 'env'; readonly urlEnv: string; readonly databaseName?: string }
  | { readonly kind: 'crewstation'; readonly role: 'source' | 'target' }

function validDatabaseName(name: string): boolean {
  return name.length > 0 && !/[/\s\0]/u.test(name) && new TextEncoder().encode(name).length <= 63
}

/** Database names in persisted references use exactly encodeURIComponent. */
export function parsePostgresqlProfileRef(value: string): PostgresqlProfileRef | null {
  if (value === 'crewstation:source' || value === 'crewstation:target')
    return { kind: 'crewstation', role: value === 'crewstation:source' ? 'source' : 'target' }
  const match = /^env:([A-Za-z_][A-Za-z0-9_]*)(?:\/([^/]+))?$/.exec(value)
  if (!match || match[0] !== value) return null
  const urlEnv = match[1]!
  if (match[2] === undefined) return { kind: 'env', urlEnv }
  try {
    const databaseName = decodeURIComponent(match[2])
    if (!validDatabaseName(databaseName) || encodeURIComponent(databaseName) !== match[2])
      return null
    return { kind: 'env', urlEnv, databaseName }
  } catch {
    return null
  }
}

/** Preserve the hosted role restrictions at each existing validation point. */
export function isPostgresqlProfileRef(value: string, hostedRole?: 'source' | 'target'): boolean {
  const parsed = parsePostgresqlProfileRef(value)
  return parsed !== null && (parsed.kind === 'env' || parsed.role === hostedRole)
}

export function environmentPostgresqlProfileRef(urlEnv: string, databaseName?: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.exec(urlEnv)?.[0] !== urlEnv)
    throw new Error('postgresql-profile-reference-invalid')
  const value = `env:${urlEnv}${databaseName === undefined ? '' : `/${encodeURIComponent(databaseName)}`}`
  if (!isPostgresqlProfileRef(value)) throw new Error('postgresql-profile-reference-invalid')
  return value
}
