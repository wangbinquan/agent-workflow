// RFC-370: bootstrap selects credential adapters; inbound middleware only
// consumes the public authentication query. Compatibility exports keep legacy
// local credential consumers on the same implementation during their cutover.
export {
  createLocalHttpAuthentication as composeLocalHttpAuthentication,
  parseLocalBearerHeader,
} from '../infrastructure/local/httpAuthentication'
export { createHttpAuthenticationMiddleware as composeHttpAuthenticationMiddleware } from '../inbound/http/authentication'
export {
  admitDaemonIdentity,
  admitDurableWorkOwner,
  actorOfDirectAuthority,
  describeCredential,
  resolveActor,
  resolveActorWithWsCredential,
  resolveIdentity,
  reresolveActor,
  reresolveIdentity,
  type DirectAuthorityAdmissionRuntime,
  type ResolvedUpgradeIdentity,
  type WsCredentialFingerprint,
  type WsCredentialWithExpiry,
} from '../infrastructure/local/localCredentialAdmission'
