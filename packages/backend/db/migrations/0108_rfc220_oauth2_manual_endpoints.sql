-- RFC-220 — pure OAuth 2.0 provider support: manual endpoint fallbacks +
-- identity-shaping knobs on oidc_providers, and the D7 presented-name
-- snapshot on user_identities (NULL on legacy rows is load-bearing: it means
-- "never observed" and blocks first-sight displayName overwrites).
ALTER TABLE oidc_providers ADD COLUMN authorization_endpoint text;
--> statement-breakpoint
ALTER TABLE oidc_providers ADD COLUMN token_endpoint text;
--> statement-breakpoint
ALTER TABLE oidc_providers ADD COLUMN userinfo_endpoint text;
--> statement-breakpoint
ALTER TABLE oidc_providers ADD COLUMN jwks_uri text;
--> statement-breakpoint
ALTER TABLE oidc_providers ADD COLUMN trust_email_verified integer NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE oidc_providers ADD COLUMN username_claim text;
--> statement-breakpoint
ALTER TABLE oidc_providers ADD COLUMN subject_claim text;
--> statement-breakpoint
ALTER TABLE user_identities ADD COLUMN preferred_snapshot text;
