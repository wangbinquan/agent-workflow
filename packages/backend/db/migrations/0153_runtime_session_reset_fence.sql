ALTER TABLE `runtime_session_leases`
ADD COLUMN `reset_pending` integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE TRIGGER `runtime_session_leases_reset_pending_insert`
BEFORE INSERT ON `runtime_session_leases`
WHEN NEW.`reset_pending` NOT IN (0, 1)
  OR (NEW.`reset_pending` = 1 AND NEW.`lease_node_run_id` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'runtime_session_leases_reset_pending_invalid');
END;--> statement-breakpoint

CREATE TRIGGER `runtime_session_leases_reset_pending_update`
BEFORE UPDATE ON `runtime_session_leases`
WHEN NEW.`reset_pending` NOT IN (0, 1)
  OR (NEW.`reset_pending` = 1 AND NEW.`lease_node_run_id` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'runtime_session_leases_reset_pending_invalid');
END;
