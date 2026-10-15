CREATE TABLE `application_configuration` (
	`id` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "application_configuration_id_fixed" CHECK("application_configuration"."id" = 'global')
);
--> statement-breakpoint
CREATE TABLE `external_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` text NOT NULL,
	`linked_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_external_identities_user` ON `external_identities` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `external_identities_issuer_subject_unique` ON `external_identities` (`issuer`,`subject`);--> statement-breakpoint
CREATE TABLE `skill_content_entries` (
	`skill_id` text NOT NULL,
	`tree` text NOT NULL,
	`path` text NOT NULL,
	`encoding` text NOT NULL,
	`content` text NOT NULL,
	`size` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`skill_id`, `tree`, `path`),
	CONSTRAINT "skill_content_entries_encoding_enum" CHECK("skill_content_entries"."encoding" IN ('utf8', 'base64'))
);
