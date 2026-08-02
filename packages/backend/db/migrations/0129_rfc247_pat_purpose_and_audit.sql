-- RFC-247 — API token surface.
--
-- user_pats.purpose: a token is issued for exactly one of two uses.
--   'general'  reaches /api/* and /api/mcp
--   'mcp_only' reaches /api/mcp only, and any business route answers 403
-- The DB default exists for schema sanity only. Every pre-RFC-247 row is
-- revoked below, so no live token silently inherits it.
--
-- token_audit deliberately stores NO request body. resource_write payloads
-- carry MCP env values and repo credentials, and an audit table that holds
-- secrets is a new breach surface rather than a control.
--
-- token_delete_snapshot exists because metadata answers "who deleted what" but
-- not "what was it" — and once the row is gone, the second question is the one
-- that matters.
--
-- Existing PATs are revoked. RFC-221 D1 disabled PAT creation globally, so any
-- surviving row predates that and carries the OLD scope vocabulary
-- (agents:write, tasks:launch, the five memory points) which RFC-247 retired.
-- Reinterpreting those scopes under the new catalog would change what a live
-- credential can do without anyone deciding to.
ALTER TABLE user_pats ADD COLUMN purpose TEXT NOT NULL DEFAULT 'general';
--> statement-breakpoint
UPDATE user_pats SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE TABLE token_audit (
  id TEXT PRIMARY KEY,
  pat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  tool_name TEXT,
  method TEXT,
  path TEXT,
  resource_kind TEXT,
  resource_id TEXT,
  status_code INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_token_audit_user_created ON token_audit (user_id, created_at);
--> statement-breakpoint
CREATE INDEX idx_token_audit_pat_created ON token_audit (pat_id, created_at);
--> statement-breakpoint
CREATE INDEX idx_token_audit_created ON token_audit (created_at);
--> statement-breakpoint
CREATE TABLE token_delete_snapshot (
  id TEXT PRIMARY KEY,
  audit_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_token_delete_snapshot_audit ON token_delete_snapshot (audit_id);
--> statement-breakpoint
CREATE INDEX idx_token_delete_snapshot_created ON token_delete_snapshot (created_at);
