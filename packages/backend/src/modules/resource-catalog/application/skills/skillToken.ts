export interface SkillPreconditionToken {
  readonly skillId: string
  readonly contentVersion: number
  readonly metaRevision: number
}

/** Provider-neutral byte-compatible successor to services/skillToken.ts. */
export function encodeSkillToken(token: SkillPreconditionToken): string {
  return Buffer.from(
    JSON.stringify([token.skillId, token.contentVersion, token.metaRevision]),
    'utf-8',
  ).toString('base64url')
}

export function decodeSkillToken(value: string): SkillPreconditionToken | null {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf-8'))
  } catch {
    return null
  }
  if (!Array.isArray(decoded) || decoded.length !== 3) return null
  const [skillId, contentVersion, metaRevision] = decoded
  if (typeof skillId !== 'string' || skillId.length === 0) return null
  if (!Number.isInteger(contentVersion) || Number(contentVersion) < 0) return null
  if (!Number.isInteger(metaRevision) || Number(metaRevision) < 0) return null
  return {
    skillId,
    contentVersion: Number(contentVersion),
    metaRevision: Number(metaRevision),
  }
}

export function skillTokenMatches(
  expected: SkillPreconditionToken,
  current: SkillPreconditionToken,
): boolean {
  return (
    expected.skillId === current.skillId &&
    expected.contentVersion === current.contentVersion &&
    expected.metaRevision === current.metaRevision
  )
}
