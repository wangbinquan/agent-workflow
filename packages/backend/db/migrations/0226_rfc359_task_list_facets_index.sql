-- RFC-359 W28: cover the existing task-list facet read without changing its SQL.
-- This additive index leaves the existing root/page indexes available.
CREATE INDEX `idx_tasks_list_facets_cover` ON `tasks` (`catalog_visibility`,`source_agent_name`,`workgroup_id`,`status`,`id`);
