-- RFC-371: append-only CNY tariffs, separate from runtime launch configuration.
CREATE TABLE `observation_price_heads` (
  `registration_id` text PRIMARY KEY NOT NULL,
  `revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `observation_price_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `registration_id` text NOT NULL,
  `revision` integer NOT NULL,
  `request_key` text NOT NULL,
  `fingerprint` text NOT NULL,
  `configuration_revision` integer NOT NULL,
  `protocol` text NOT NULL,
  `provider` text NOT NULL,
  `model` text NOT NULL,
  `condition` text,
  `effective_from` integer NOT NULL,
  `document` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observation_price_revision_idx` ON `observation_price_versions` (`registration_id`,`revision`);
--> statement-breakpoint
CREATE UNIQUE INDEX `observation_price_request_idx` ON `observation_price_versions` (`registration_id`,`request_key`);
--> statement-breakpoint
CREATE INDEX `observation_price_match_idx` ON `observation_price_versions` (`registration_id`,`configuration_revision`,`protocol`,`provider`,`model`,`condition`,`effective_from`);
