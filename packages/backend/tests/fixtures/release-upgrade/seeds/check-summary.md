# RFC-398 T8 preparation evidence

Final candidate: Bun 1.4.3. SQL receipt/seed preparation only; no converter, auto-upgrade, current daemon, HTTP acceptance, `db migration`, or test execution.

`seed-ledger check --write-coverage` completed successfully for all **57 distinct builds / 80 releases**. Across the matrix: **4,462 table/build pairs, 4,444 nonempty, 18 proposed metadata exemptions, zero missing tables, zero insert/migration/integrity failures**. All 56 epoch-1 builds have every stored table populated. The epoch-2 build has all 232 business tables populated.

The exact tables, row counts, provenance and build keys are in [coverage.json](../coverage.json). Exemptions are proposed, not approved; the strict approval-sensitive check is not an acceptance PASS.

## Per-build result

“Covered” counts tables with rows. Exempt tables remain empty. Every row below has zero failures. Tags on the same row share one registry build key.

| Release tags                       | Covered | Total tables | Proposed exemptions |
| ---------------------------------- | ------: | -----------: | ------------------: |
| v0.1.0                             |      13 |           13 |                   0 |
| v0.2.0                             |      18 |           18 |                   0 |
| v0.5.0                             |      25 |           25 |                   0 |
| v0.6.0                             |      29 |           29 |                   0 |
| v0.6.1, v0.6.2, v0.6.3             |      29 |           29 |                   0 |
| v0.6.4                             |      30 |           30 |                   0 |
| v0.7.0                             |      31 |           31 |                   0 |
| v0.8.0                             |      33 |           33 |                   0 |
| v0.9.0                             |      34 |           34 |                   0 |
| v0.9.1                             |      34 |           34 |                   0 |
| v0.9.2, v0.9.3                     |      34 |           34 |                   0 |
| v0.9.4                             |      34 |           34 |                   0 |
| v0.9.5, v0.10.0                    |      34 |           34 |                   0 |
| v0.11.0, v0.11.1, v0.11.2, v0.11.3 |      34 |           34 |                   0 |
| v0.12.0, v0.12.1, v0.12.2          |      36 |           36 |                   0 |
| v0.12.3, v0.12.4, v0.12.5, v0.12.6 |      36 |           36 |                   0 |
| v0.13.0, v0.13.1, v0.13.2, v0.13.3 |      40 |           40 |                   0 |
| v0.13.4                            |      40 |           40 |                   0 |
| v0.13.5                            |      40 |           40 |                   0 |
| v0.13.6, v0.13.7                   |      40 |           40 |                   0 |
| v0.14.0                            |      46 |           46 |                   0 |
| v0.14.1                            |      46 |           46 |                   0 |
| v0.15.0, v0.15.1                   |      46 |           46 |                   0 |
| v0.16.0                            |      46 |           46 |                   0 |
| v0.16.1                            |      46 |           46 |                   0 |
| v0.16.2                            |      45 |           45 |                   0 |
| v0.16.3                            |      45 |           45 |                   0 |
| v0.17.0                            |      47 |           47 |                   0 |
| v0.17.1, v0.17.2                   |      47 |           47 |                   0 |
| v0.17.3                            |      52 |           52 |                   0 |
| v0.17.4, v0.17.5                   |      53 |           53 |                   0 |
| v0.17.6                            |      58 |           58 |                   0 |
| v0.17.7                            |      63 |           63 |                   0 |
| v0.17.8, v0.17.9, v0.17.10         |      63 |           63 |                   0 |
| v0.17.11                           |      68 |           68 |                   0 |
| v0.18.0                            |      68 |           68 |                   0 |
| v0.18.1                            |      70 |           70 |                   0 |
| v0.18.2                            |      70 |           70 |                   0 |
| v0.18.3                            |      70 |           70 |                   0 |
| v0.18.4                            |      70 |           70 |                   0 |
| v0.18.5                            |      72 |           72 |                   0 |
| v0.18.6                            |      72 |           72 |                   0 |
| v0.18.7, v0.18.8                   |      76 |           76 |                   0 |
| v0.18.9, v0.18.10                  |      93 |           93 |                   0 |
| v0.18.11                           |     126 |          126 |                   0 |
| v0.18.12                           |     166 |          166 |                   0 |
| v0.18.13                           |     168 |          168 |                   0 |
| v0.18.14                           |     177 |          177 |                   0 |
| v0.18.15                           |     179 |          179 |                   0 |
| v0.18.16                           |     180 |          180 |                   0 |
| v0.18.17                           |     186 |          186 |                   0 |
| v0.18.18                           |     186 |          186 |                   0 |
| v0.18.19                           |     186 |          186 |                   0 |
| v0.19.0                            |     186 |          186 |                   0 |
| v0.19.1                            |     191 |          191 |                   0 |
| v0.19.2                            |     200 |          200 |                   0 |
| v0.19.3                            |     237 |          255 |                  18 |

As additional authoring preparation, the frozen epoch-1 ledger including `0259`–`0262` was assembled through the same SQL-only library: **224/224 stored tables populated, zero failures** (222 business tables plus journal and SQLite allocator). Those four tail entries are not attributed to v0.19.2 or added to any release receipt.

## Static checks and scope

- Strict scoped TypeScript check passed for the five T8 TypeScript files, including the authored regression tests.
- Scoped ESLint passed. Its only output was the existing Node module-type warning for the repository ESLint configuration.
- Scoped Prettier and source-reference checks passed. All 222 current business source tables have every column classified by direct preservation, projections, archive or metadata rules.
- Oracle authority file hashes match the cited RFC files; each file:line reference resolves to a nonempty line.
- Hosted object IDs have corresponding small local content bodies. Reconstruction verifies each content digest, release SQL hash, receipt order, foreign keys and SQLite quick-check result.
- Tool regression cases are authored but were not run. No old binary recordings were needed; all data is explicitly curated.
- All T8 repository writes are inside the allowed file list. Existing Job R tools were reused without modification. No Git staging, commit, stash, branch or worktree operations were performed.

## Candidate fingerprints

The tree digests below hash each sorted repository-relative path, NUL, raw file bytes, NUL. This covers the exact data/tool candidate, independently of moving shared-main history.

| Input                        | SHA-256                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| 264 seed/snapshot JSON files | `6d1d0126a76b1d1bac66d25d19aa2cd9407649558b6233c1469caa9f13416642` |
| Five T8 TypeScript files     | `b79f800bbbf701c631a39607c192569c1629d79db865253cbfbde58ccaf04315` |
| releases.json                | `7f752c18416e3c1f79b823e36ff2a021a8ec1ae6a3e39789fd42d3f53ef2e374` |
| mapping-oracle.json          | `32c99b9ad2132b2ebd4223fe86de7d20ab299f8242c73b489e0b0ae02602791d` |
| coverage.json                | `b87fc6e3e8608e0bafdf9efd21db3142ffca39e6e9252ad1688f6d4da9ee916d` |

The seed/snapshot JSON totals 624,366 bytes and contains 666 explicit seed rows; SQL defaults and backfills add further rows. The row count excludes installation metadata materialized by the preparation helper.

## Rule-declaration oracle entries

Exactly **108** entries use `source: "rule-declaration"`, all `sourcePhase: "pre-upgrade"`. They are retired physical tables absent from the RFC's 222-table frozen-current roster. Their declared destination is no live business table (`destinations: []`); the evidence is the generic archive declaration at `packages/backend/src/platform/persistence/migration/conversion/generic/archive.ts:17` (`produces: []`). Their original keys, schema, raw values and archive digest obligations come from RFC-395 migration §4, not converter execution or target output.

| Source table                                   | Source phase | Destination / disposition               |
| ---------------------------------------------- | ------------ | --------------------------------------- |
| `capability_bindings`                          | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `capability_frameworks`                        | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `clarify_mindmap_command_receipts`             | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `clarify_mindmap_node_revisions`               | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `clarify_mindmap_nodes`                        | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `clarify_mindmap_sessions`                     | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `clarify_mindmap_snapshots`                    | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `clarify_sessions`                             | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `cross_clarify_sessions`                       | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `dynamic_workflow_spaces`                      | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `memory_distill_execution_receipts`            | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `node_assignments`                             | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_anomaly_history`                  | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_anomaly_states`                   | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_calculation_rows`                 | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_calculation_versions`             | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_invocation_price_audit`           | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_invocation_price_policies`        | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_invocation_price_records`         | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_invocations`                      | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_maintenance_members`              | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_maintenance_operations`           | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_native_fact_pages`                | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_native_fact_roots`                | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_platform_records`                 | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_platform_sources`                 | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_price_heads`                      | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_price_versions`                   | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_bindings`              | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_bootstrap`             | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_changes`               | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_components`            | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_current`               | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_dependencies`          | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_descriptors`           | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_heads`                 | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_history`               | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_indexed_versions`      | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_memberships`           | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_prepared`              | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_query_scope_members`   | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_query_scopes`          | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_versions`              | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_views`                 | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_work`                  | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_projection_work_components`       | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_report_counts`                    | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_report_leases`                    | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_report_pages`                     | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_report_receipts`                  | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_report_retained_revisions`        | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_report_rows`                      | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_reports`                          | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_scope_refs`                       | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_source_revisions`                 | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_storage_samples`                  | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_storage_state`                    | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_usage_captures`                   | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_usage_current`                    | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_usage_events`                     | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_usage_native_records`             | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_usage_sources`                    | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `observation_work_retention`                   | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `onboarding_artifacts`                         | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `onboarding_runs`                              | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `opencode_mcp_test_session_owners`             | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `opencode_session_owners`                      | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `recent_repos`                                 | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `repo_group_members`                           | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `rfc276_legacy_runtime_archive`                | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `skill_sources`                                | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_native_usage_emissions`          | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_native_usage_pass_heads`         | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_native_usage_pass_pages`         | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_native_usage_passes`             | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_native_usage_preparations`       | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_native_usage_revision_heads`     | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_native_usage_root_heads`         | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_native_usage_root_results`       | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_native_usage_root_sets`          | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_native_usage_root_transitions`   | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_native_usage_session_parents`    | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_native_usage_step_members`       | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_native_usage_store_bindings`     | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_observation_groups`              | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_observation_owners`              | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_agent_observation_sources`             | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `system_host_execution_write_contexts`         | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_clarify_channels`                        | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_clarify_consumptions`                    | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_clarify_entries`                         | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_clarify_host_runs`                       | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_clarify_materials`                       | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_execution_native_usage_emissions`        | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_execution_native_usage_pass_heads`       | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_execution_native_usage_pass_pages`       | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_execution_native_usage_passes`           | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_execution_native_usage_preparations`     | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_execution_native_usage_revision_heads`   | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_execution_native_usage_root_heads`       | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_execution_native_usage_root_results`     | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_execution_native_usage_root_sets`        | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_execution_native_usage_root_transitions` | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_execution_native_usage_session_parents`  | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_execution_native_usage_step_members`     | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_execution_native_usage_store_bindings`   | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_execution_observation_sources`           | pre-upgrade  | raw-chunk@1 metadata archive / archived |
| `task_lifecycle_event_outbox`                  | pre-upgrade  | raw-chunk@1 metadata archive / archived |

## Remaining acceptance boundaries

- User review/approval of the 18 exact-build metadata exemptions in [exemptions-draft.md](../exemptions-draft.md). No business or epoch-1 table exemption is proposed.
- Later L1 matrix work must consume the independent oracle and API projections, supply the installed-role v2 pointer and bind hosted `objectId` bodies in its content adapter.
- Converter S1–S3, current HTTP A1, native E1/E2, restart/doctor, PostgreSQL and real-provider acceptance were not executed by this job. This SQL preparation result must not be represented as those acceptance results.
