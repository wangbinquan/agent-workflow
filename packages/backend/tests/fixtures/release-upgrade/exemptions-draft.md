# RFC-398 T8 proposed coverage exemptions

Status: **PROPOSED — user approval is pending**. No entry is approved by this job.

Exactly 18 entries, all migration metadata tables, all limited to the v0.19.3 build `sha256:2b14ddbad88413869775142c9a0d8eefd48c4d0c19639086e2badaf5dae8ac28`. No epoch-1 exemption and no business/retired-table exemption is proposed. Each business table is populated even when normally used only by hosted installations.

A native epoch-2 installation creates these empty metadata tables. Filling them would invent conversion/recovery evidence. The installation does have real fixture rows for `aw_meta_schema_history`, `aw_meta_generations`, `aw_meta_first_write`, the epoch sentinel and SQLite allocator high water; those are covered rather than exempt.

| Table                                    | Reason                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aw_meta_activation_receipts`            | No epoch conversion or activation switch has run in this installed-role epoch-2 fixture. An activation receipt would claim an event that did not occur. |
| `aw_meta_migration_approvals`            | No operator approved an epoch conversion plan in this installation.                                                                                     |
| `aw_meta_migration_archives`             | No conversion run archived source chunks; explicitly imported business history is in code_history_archives, not migration evidence.                     |
| `aw_meta_migration_artifact_receipts`    | No converter published or verified source artifacts in this installation.                                                                               |
| `aw_meta_migration_blocks`               | No conversion run exists and no migration blocker was observed.                                                                                         |
| `aw_meta_migration_history_restrictions` | Native executable history has no migration-imposed retry restrictions.                                                                                  |
| `aw_meta_migration_identity_high_water`  | Native SQLite AUTOINCREMENT state supplies the allocator high water; no imported conversion high-water receipt exists.                                  |
| `aw_meta_migration_operations`           | No epoch-conversion operation was requested; E2 must assert that upgrade creates none.                                                                  |
| `aw_meta_migration_operator_inputs`      | No operator conversion decision or acknowledgement was submitted.                                                                                       |
| `aw_meta_migration_receipt_exports`      | No conversion receipt export was requested.                                                                                                             |
| `aw_meta_migration_records`              | No converter diagnostics, source-journal records, or row decisions exist for this native installation.                                                  |
| `aw_meta_migration_row_dispositions`     | No source rows underwent epoch conversion; fabricating dispositions would make S2 evidence false.                                                       |
| `aw_meta_migration_runs`                 | No epoch conversion or old-epoch restore run has executed.                                                                                              |
| `aw_meta_migration_table_receipts`       | No conversion table unit was sealed or verified.                                                                                                        |
| `aw_meta_migration_unit_sources`         | No conversion unit consumed source rows.                                                                                                                |
| `aw_meta_migration_units`                | No conversion plan units were executed.                                                                                                                 |
| `aw_meta_schema_transform_receipts`      | v0.19.3 installs history 0000 directly; no data-transform edge has been applied. E1 explicitly excludes prior/installation edges.                       |
| `aw_meta_switch_receipts`                | No generation switch or rollback transition has executed.                                                                                               |

Authority: RFC-398 design §7.4 E1/E2 and §7.5; immutable epoch-2 catalog; `schema/history/apply.ts:164` native install path; `schema/history/meta.ts` and `migrationMetaTables.ts` declarations. SQL preparation creates the declared tables without calling any of these production functions.

`coverage.json` repeats each exact table, buildKey, reason, category and proposed status. `seed-ledger check` reports proposed exemptions explicitly; `--require-approved-exemptions` exits nonzero until approved. Approval must change the status of the approved entries only; do not approve a prefix or an entire metadata namespace. Future builds require their own applicability review.
