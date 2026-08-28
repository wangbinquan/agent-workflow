ALTER TABLE `users` ADD `git_name` text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE `users` SET `git_name` = `display_name` WHERE `git_name` = '';
--> statement-breakpoint
ALTER TABLE `oidc_providers` ADD `git_name_claim` text;
