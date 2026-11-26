// RFC-621 — the system principal's user id (moved from the backend's `auth/systemIdentity.ts`): the owner of framework
// built-ins (`builtin` agents and workflows, see the ACL schemas) and the actor id of framework-initiated writes. It lives
// in shared so every backend layer takes it from one neutral place.
export const SYSTEM_USER_ID = '__system__'
