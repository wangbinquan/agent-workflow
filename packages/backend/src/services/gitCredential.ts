// Compatibility export for clone/background-refresh call sites. RFC-321 owns
// the implementation in source-control infrastructure; new publication code
// must import the exact-target lease there instead of adding another facade.
export {
  cleanupOrphanedGitCredentialLeases,
  computeGitCredentialResponse,
  credentialFreeHttpUrl,
  extractGitUserinfo,
  gitCredentialHelperValue,
  leaseGitCredential,
  leaseTargetBoundGitCredential,
  parseGitCredentialRequest,
  runGitCredentialSubcommand,
  type GitCredentialLeasePayloadV1,
  type GitCredentialLease,
} from '@/modules/source-control/infrastructure/gitCredentialLease'
