// RFC-395 II-b V1: frozen published SQLite receipt aliases.
export const LEGACY_MIGRATION_HASHES: Readonly<Record<string, readonly string[]>> = {
  '0052_rfc108_recovery_events': [
    '3b5f02214e1c06a1b05ab2eaef4d1209815d60198850eba9ad4a899fa14c96f0',
  ],
  '0069_rfc129_review_selection_stale': [
    '547c53f30c3a8a8fd4df278ce0310e4a2a89f3683b6336559c31093b669f4e24',
  ],
  '0084_rfc164_workgroup_tasks': [
    '8c9f8244e564b54951c284a5ed7f20f0c9077d621ff7d49465420490182024b7',
  ],
  '0085_rfc165_task_space': ['033da7e58069bce3c90c3f2688f018417fceb5bc0995577ce828a351590800a3'],
  '0095_rfc189_wg_round': ['ae58ca1a757cc36c41af5b1a8a077a3bda436924ae074acf5a408babb5ccdfca'],
  '0107_rfc217_clarify_unify_t17': [
    '7d9cc403ede0aea34d7a6557ff0f10de73a8adb04fad09430e973c94aee2b1b4',
  ],
  // 2026-09-02 — unlike the entries around it, this alias does not predate the
  // canonical form: 0111 was amended (`json_group_array(x ORDER BY y)` →
  // ordered subquery, so the statement parses on SQLite < 3.44) AFTER it had
  // shipped and been applied everywhere, and the repin was omitted. Every
  // existing database then stopped at migration-history-preflight and the
  // daemon refused to start. The receipt below is the sha256 of the shipped
  // bytes, kept verbatim at
  // tests/fixtures/shipped-migrations/0111_rfc223_agent_refs_to_id.sql, and
  // migration-0111-rfc223.test.ts holds the two forms to the same end state —
  // which is what makes accepting the older receipt sound.
  '0111_rfc223_agent_refs_to_id': [
    '8f7584ecb9229bf9bfad82040d9fab68a11ed4885748e7f034eee0b0f8510d97',
  ],
  '0125_rfc238_mcp_runtime_playground': [
    '475944d58ef1c8341ed86e3c88ce080aebcef8dbc23548ea43345be3a8eee450',
  ],
  '0139_rfc261_webhook_delivery_scale': [
    '1c14427b8a7f740617841f759c302f9efbe0ab611e3dd23b553c4a6a1ded794e',
  ],
}
