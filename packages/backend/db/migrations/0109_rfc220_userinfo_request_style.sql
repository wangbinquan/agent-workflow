-- RFC-220 D8 — non-standard userinfo invocation style: 'get_bearer' (standard
-- OIDC GET + Authorization: Bearer, the default) or 'post_json' (POST with a
-- JSON body of exactly { client_id, access_token, scope }, no auth header).
ALTER TABLE oidc_providers ADD COLUMN userinfo_request_style text NOT NULL DEFAULT 'get_bearer';
