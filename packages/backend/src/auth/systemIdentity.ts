/** Stable identifier for the daemon-owned system principal.
 * Kept in a dependency-free leaf so identity and ACL adapters do not import
 * the legacy Actor compatibility module merely to compare an identifier. */
export const SYSTEM_USER_ID = '__system__'
