-- RFC-305 — OAuth/OIDC self-provisioning starts read-only by default, while
-- administrators may deliberately opt new identities into the regular-user
-- preset. Existing and fresh installations both receive the safer guest
-- default; invited accounts keep their explicitly assigned role.
ALTER TABLE `auth_login_policy`
ADD COLUMN `oidc_default_role` text NOT NULL DEFAULT 'guest'
CHECK (`oidc_default_role` IN ('guest', 'user'));
