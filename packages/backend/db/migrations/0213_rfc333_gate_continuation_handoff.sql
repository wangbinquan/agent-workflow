DROP INDEX `idx_task_execution_intents_active_task`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_execution_intents_pending_task`
  ON `task_execution_intents` (`task_id`)
  WHERE `state` = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_execution_intents_claimed_task`
  ON `task_execution_intents` (`task_id`)
  WHERE `state` = 'claimed';
