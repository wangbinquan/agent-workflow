// RFC-594 — the history contract of the retired code-round host (RFC-304; its writer was deleted by RFC-310 PR-10 T104).
// Historical code-round tasks still decode, list and project their outcome, and a round's output hangs off the one node
// of its synthesized snapshot. Moved from `services/codeRoundContract.ts` (RFC-294 W9-D). Like the agent host and
// digital-employee host leaves beside it, this file imports nothing, so the outcome projection can take the id without
// reaching anything that launches a task. The snapshot synthesizer, which only test fixtures for historical rows still
// call, is `tests/helpers/codeRoundHistory.ts`.

/**
 * The one node of a round's synthesized snapshot. Named like the agent host's
 * `__agent_main__` so the two read as the same family in a node_runs dump.
 */
export const CODE_ROUND_NODE_ID = '__code_round__'
