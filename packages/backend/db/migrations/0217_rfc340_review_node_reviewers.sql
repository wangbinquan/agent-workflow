CREATE TABLE `review_node_reviewers` (
	`task_id` text NOT NULL,
	`review_node_id` text NOT NULL,
	`reviewer_user_id` text NOT NULL,
	`assigned_by_user_id` text NOT NULL,
	`assigned_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `review_node_id`, `reviewer_user_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assigned_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_review_node_reviewers_actor` ON `review_node_reviewers` (`reviewer_user_id`,`task_id`,`review_node_id`);
--> statement-breakpoint
CREATE INDEX `idx_review_node_reviewers_node` ON `review_node_reviewers` (`task_id`,`review_node_id`);
