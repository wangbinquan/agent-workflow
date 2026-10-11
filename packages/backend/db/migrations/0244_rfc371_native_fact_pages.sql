CREATE TABLE `observation_native_fact_pages` (
	`cache_key` text NOT NULL,
	`cursor` text NOT NULL,
	`document` text NOT NULL,
	PRIMARY KEY(`cache_key`, `cursor`),
	FOREIGN KEY (`cache_key`) REFERENCES `observation_native_fact_roots`(`cache_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `observation_native_fact_roots` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`proof_key` text NOT NULL,
	`root_session_id` text NOT NULL,
	`state` text NOT NULL,
	`document` text NOT NULL,
	CONSTRAINT "observation_native_fact_state_ck" CHECK("observation_native_fact_roots"."state" = 'sealed')
);
--> statement-breakpoint
CREATE INDEX `observation_native_fact_epoch_idx` ON `observation_native_fact_roots` (`proof_key`,`cache_key`);