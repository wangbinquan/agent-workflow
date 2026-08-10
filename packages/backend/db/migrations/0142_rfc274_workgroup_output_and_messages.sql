ALTER TABLE `workgroups`
ADD COLUMN `output_contract` text NOT NULL DEFAULT 'files'
CHECK (`output_contract` IN ('files', 'discussion'));
--> statement-breakpoint
ALTER TABLE `workgroup_messages` ADD COLUMN `template_key` text;
--> statement-breakpoint
ALTER TABLE `workgroup_messages` ADD COLUMN `template_params_json` text;
