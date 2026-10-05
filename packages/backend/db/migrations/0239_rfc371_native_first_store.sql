CREATE TABLE `task_execution_native_usage_store_bindings` (
	`invocation_id` text PRIMARY KEY NOT NULL,
	`before_owner_receipt_id` text NOT NULL,
	`source_generation` text NOT NULL,
	FOREIGN KEY (`invocation_id`) REFERENCES `task_execution_native_usage_preparations`(`invocation_id`) ON UPDATE no action ON DELETE cascade
);
