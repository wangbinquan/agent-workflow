-- RFC-221 — singleton authentication policy and one-way bootstrap handoff.
-- A fresh installation has only __system__, therefore completed_at stays NULL
-- and the daemon token may only create the first human administrator. Existing
-- installations are backfilled ready only when an active human admin has a
-- currently usable takeover credential.
CREATE TABLE `auth_login_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`password_login_enabled` integer DEFAULT true NOT NULL,
	`bootstrap_completed_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `auth_login_policy_global_only` CHECK (`id` = 'global')
);
--> statement-breakpoint
INSERT INTO `auth_login_policy` (
	`id`,
	`password_login_enabled`,
	`bootstrap_completed_at`,
	`updated_at`
)
SELECT
	'global',
	1,
	CASE WHEN EXISTS (
		SELECT 1
		FROM `users` AS u
		WHERE u.`id` <> '__system__'
		  AND u.`role` = 'admin'
		  AND u.`status` = 'active'
		  AND (
			u.`password_hash` IS NOT NULL
			OR EXISTS (
				SELECT 1
				FROM `user_identities` AS ui
				JOIN `oidc_providers` AS op ON op.`id` = ui.`provider_id`
				WHERE ui.`user_id` = u.`id` AND op.`enabled` = 1
			)
			OR EXISTS (
				SELECT 1
				FROM `user_sessions` AS s
				WHERE s.`user_id` = u.`id`
				  AND s.`revoked_at` IS NULL
				  AND s.`expires_at` >= (unixepoch() * 1000)
			)
			OR EXISTS (
				SELECT 1
				FROM `user_pats` AS p
				WHERE p.`user_id` = u.`id`
				  AND p.`revoked_at` IS NULL
				  AND (p.`expires_at` IS NULL OR p.`expires_at` >= (unixepoch() * 1000))
			)
		  )
	) THEN 0 ELSE NULL END,
	(unixepoch() * 1000);
