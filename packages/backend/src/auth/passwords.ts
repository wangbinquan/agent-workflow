// RFC-036 — argon2id password hashing. We use Bun.password (argon2id by
// default) instead of adding a native dep; this keeps the single-binary build
// (M5) simple and Bun-only — every supported runtime ships Bun.
//
// Parameters track OWASP 2024 guidance for argon2id (memory ≈ 19 MiB,
// timeCost = 2, parallelism = 1).

export const HASH_OPTS = {
  algorithm: 'argon2id' as const,
  memoryCost: 19_456,
  timeCost: 2,
} as const

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < 8) {
    throw new Error('password too short')
  }
  return Bun.password.hash(plaintext, HASH_OPTS)
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  if (!hash) return false
  try {
    return await Bun.password.verify(plaintext, hash)
  } catch {
    return false
  }
}

// RFC-103 T9 (10-ACL) & RFC-629: a fixed dummy argon2id hash pre-computed with the
// exact same OWASP HASH_OPTS (m=19456,t=2,p=1) for 'aw-constant-time-dummy-secret'.
// Storing the valid PHC literal avoids spending ~20-40ms hashing at every module load
// while keeping even the very first rejected login constant-time against the real
// wrong-password verification path.
export const DUMMY_ARGON2ID_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$ebKNhASnTTSkS1k+ZzaRh6UXCQdHlum26nW46p1jCho$HlM0mQmBAZY0qsKuXlujiJhe3YSImTMzGctfXzTmAT0'

/**
 * RFC-103 T9: run a real argon2id verify against the pre-computed constant dummy
 * hash and always resolve `false`. Call this on login paths that reject BEFORE
 * checking a real hash (unknown user / inactive / no passwordHash) so total
 * response time matches the wrong-password path and does not leak account
 * existence/state — including on the very first probe after daemon start.
 */
export async function verifyPasswordDummy(plaintext: string): Promise<false> {
  try {
    await Bun.password.verify(plaintext, DUMMY_ARGON2ID_HASH)
  } catch {
    // ignore — timing is the point, not the result
  }
  return false
}
