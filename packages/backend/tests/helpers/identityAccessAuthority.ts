import type { PatPurpose, Permission } from '@agent-workflow/shared'
import type {
  AdmittedDaemonCredential,
  AdmittedPatCredential,
  AdmittedSessionCredential,
  DirectAuthorityAdmission,
  DirectAuthorityIdentity,
} from '../../src/modules/identity-access/public/participants'

type TestDirectCredential =
  | Readonly<{ userId: string; source: 'session' }>
  | Readonly<{
      userId: string
      source: 'pat'
      patScopes?: ReadonlyArray<Permission>
      patPurpose?: PatPurpose
      patId?: string
    }>
  | Readonly<{ userId?: string; source: 'daemon' }>

/** Test-only adapter for exercising a runtime after the credential store has
 * been replaced by a fixture.  Production admitted credentials are minted
 * only in auth/session.ts after its real credential lookup succeeds. */
export function admitTestDirectAuthority(
  admission: DirectAuthorityAdmission,
  credential: TestDirectCredential,
): Promise<DirectAuthorityIdentity | null> {
  if (credential.source === 'session') {
    return admission.fromSession(
      Object.freeze({ userId: credential.userId }) as AdmittedSessionCredential,
    )
  }
  if (credential.source === 'pat') {
    return admission.fromPat(
      Object.freeze({
        userId: credential.userId,
        scopes: credential.patScopes ?? [],
        purpose: credential.patPurpose ?? 'mcp_only',
        patId: credential.patId ?? 'test-pat',
      }) as AdmittedPatCredential,
    )
  }
  return admission.fromDaemon(Object.freeze({}) as AdmittedDaemonCredential)
}
