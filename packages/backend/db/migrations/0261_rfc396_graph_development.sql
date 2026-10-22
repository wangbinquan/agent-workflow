CREATE TABLE `development_designs` (
  `id` text PRIMARY KEY NOT NULL, `case_id` text NOT NULL, `revision` integer NOT NULL,
  `presentation_json` text DEFAULT '{}' NOT NULL, `presentation_revision` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL, `updated_at` integer NOT NULL,
  CONSTRAINT `development_designs_revision_ck` CHECK (`revision` > 0 AND `presentation_revision` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `development_designs_case_uq` ON `development_designs` (`case_id`);
--> statement-breakpoint
CREATE TABLE `development_design_revisions` (
  `design_id` text NOT NULL, `revision` integer NOT NULL, `artifact_ref` text NOT NULL,
  `digest` text NOT NULL, `request_id` text NOT NULL, `created_at` integer NOT NULL,
  PRIMARY KEY (`design_id`, `revision`),
  CONSTRAINT `development_design_revisions_revision_ck` CHECK (`revision` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `development_design_revisions_request_uq` ON `development_design_revisions` (`design_id`, `request_id`);
--> statement-breakpoint
CREATE TABLE `development_design_proposals` (
  `design_id` text NOT NULL, `id` text NOT NULL, `kind` text NOT NULL,
  `request_digest` text NOT NULL, `status` text NOT NULL, `version` integer NOT NULL,
  `payload_json` text NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL,
  PRIMARY KEY (`design_id`, `id`), CONSTRAINT `development_design_proposals_version_ck` CHECK (`version` > 0)
);
--> statement-breakpoint
CREATE INDEX `development_design_proposals_status_idx` ON `development_design_proposals` (`design_id`, `kind`, `status`);
--> statement-breakpoint
CREATE TABLE `development_design_baselines` (
  `design_id` text NOT NULL, `id` text NOT NULL, `digest` text NOT NULL,
  `artifact_ref` text NOT NULL, `created_at` integer NOT NULL, PRIMARY KEY (`design_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `development_design_baselines_digest_idx` ON `development_design_baselines` (`design_id`, `digest`);
--> statement-breakpoint
CREATE TABLE `development_design_links` (
  `design_id` text NOT NULL, `id` text NOT NULL, `kind` text NOT NULL,
  `payload_json` text NOT NULL, `created_at` integer NOT NULL, PRIMARY KEY (`design_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `development_design_links_kind_idx` ON `development_design_links` (`design_id`, `kind`);
