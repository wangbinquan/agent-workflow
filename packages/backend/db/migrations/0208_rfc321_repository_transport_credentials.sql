-- RFC-321: rebuild the existing integration-owned connection table so every
-- logical connection has an opaque generation and typed transport mappings.
-- The token ciphertext is copied byte-for-byte; this migration never unseals it.
CREATE TABLE `__new_code_host_connections` (
  `provider` text PRIMARY KEY NOT NULL CHECK (`provider` IN ('gitlab', 'github')),
  `base_url` text NOT NULL,
  `repository_url_prefixes_json` text NOT NULL DEFAULT '[]' CHECK (json_valid(`repository_url_prefixes_json`)),
  `transport_mappings_json` text NOT NULL DEFAULT '[]' CHECK (json_valid(`transport_mappings_json`)),
  `connection_generation` text NOT NULL DEFAULT (lower(hex(randomblob(16)))) CHECK (length(`connection_generation`) BETWEEN 1 AND 128),
  `reject_unauthorized` integer DEFAULT 1 NOT NULL CHECK (`reject_unauthorized` IN (0, 1)),
  `token_enc` text NOT NULL,
  `token_hint` text NOT NULL,
  `last_test_json` text,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_by` text
);
--> statement-breakpoint
INSERT INTO `__new_code_host_connections` (
  `provider`,
  `base_url`,
  `repository_url_prefixes_json`,
  `transport_mappings_json`,
  `connection_generation`,
  `reject_unauthorized`,
  `token_enc`,
  `token_hint`,
  `last_test_json`,
  `updated_at`,
  `updated_by`
)
SELECT
  `provider`,
  `base_url`,
  `repository_url_prefixes_json`,
  '[]',
  lower(hex(randomblob(16))),
  `reject_unauthorized`,
  `token_enc`,
  `token_hint`,
  `last_test_json`,
  `updated_at`,
  `updated_by`
FROM `code_host_connections`;
--> statement-breakpoint
DROP TABLE `code_host_connections`;
--> statement-breakpoint
ALTER TABLE `__new_code_host_connections` RENAME TO `code_host_connections`;
--> statement-breakpoint

-- Source-control owns this purpose-limited projection. The copied ciphertext
-- uses the same secretBox envelope as the integration row, so no plaintext is
-- materialized during upgrade. Boot reconciliation replaces the initial random
-- 256-bit binding fence with the canonical SHA-256 digest before serving API.
CREATE TABLE `repository_transport_connections` (
  `provider` text PRIMARY KEY NOT NULL CHECK (`provider` IN ('gitlab', 'github')),
  `connection_generation` text NOT NULL CHECK (length(`connection_generation`) BETWEEN 1 AND 128),
  `endpoint_binding_digest` text NOT NULL CHECK (
    length(`endpoint_binding_digest`) = 64
    AND `endpoint_binding_digest` NOT GLOB '*[^0-9a-f]*'
  ),
  `api_base_url` text NOT NULL,
  `reject_unauthorized` integer NOT NULL CHECK (`reject_unauthorized` IN (0, 1)),
  `transport_mappings_json` text NOT NULL CHECK (json_valid(`transport_mappings_json`)),
  `allowed_http_base_urls_json` text NOT NULL CHECK (json_valid(`allowed_http_base_urls_json`)),
  `global_token_enc` text NOT NULL,
  `global_token_hint` text NOT NULL,
  `credential_revision` integer NOT NULL DEFAULT 1 CHECK (`credential_revision` > 0),
  `updated_at` integer NOT NULL,
  `updated_by` text,
  UNIQUE (`provider`, `connection_generation`)
);
--> statement-breakpoint
INSERT INTO `repository_transport_connections` (
  `provider`,
  `connection_generation`,
  `endpoint_binding_digest`,
  `api_base_url`,
  `reject_unauthorized`,
  `transport_mappings_json`,
  `allowed_http_base_urls_json`,
  `global_token_enc`,
  `global_token_hint`,
  `credential_revision`,
  `updated_at`,
  `updated_by`
)
SELECT
  `provider`,
  `connection_generation`,
  lower(hex(randomblob(32))),
  `base_url`,
  `reject_unauthorized`,
  `transport_mappings_json`,
  `repository_url_prefixes_json`,
  `token_enc`,
  `token_hint`,
  1,
  `updated_at`,
  `updated_by`
FROM `code_host_connections`;
--> statement-breakpoint

CREATE TABLE `user_repository_transport_credentials` (
  `user_id` text NOT NULL,
  `provider` text NOT NULL CHECK (`provider` IN ('gitlab', 'github')),
  `connection_generation` text NOT NULL CHECK (length(`connection_generation`) BETWEEN 1 AND 128),
  `endpoint_binding_digest` text NOT NULL CHECK (
    length(`endpoint_binding_digest`) = 64
    AND `endpoint_binding_digest` NOT GLOB '*[^0-9a-f]*'
  ),
  `token_enc` text NOT NULL,
  `token_hint` text NOT NULL CHECK (length(`token_hint`) = 4),
  `credential_revision` integer NOT NULL CHECK (`credential_revision` > 0),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`user_id`, `provider`),
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`provider`, `connection_generation`)
    REFERENCES `repository_transport_connections` (`provider`, `connection_generation`)
    ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_repository_transport_credentials_provider_generation`
ON `user_repository_transport_credentials` (`provider`, `connection_generation`);
