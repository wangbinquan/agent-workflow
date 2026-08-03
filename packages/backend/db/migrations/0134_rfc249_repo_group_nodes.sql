-- RFC-249 — 仓库组从「成员 + mount_path」迁移为显式目录节点。
-- 每个组固定有 root ('')；repo/group 是节点上的可选 attachment，纯目录没有挂载。
CREATE TEMP TABLE `__rfc249_assert` (`ok` integer NOT NULL CHECK (`ok` = 1));--> statement-breakpoint
CREATE TABLE `repo_group_nodes` (
	`group_id` text NOT NULL,
	`path` text NOT NULL,
	`attachment_kind` text,
	`cached_repo_id` text,
	`ref` text DEFAULT '' NOT NULL,
	`subdir` text DEFAULT '' NOT NULL,
	`child_group_id` text,
	`readonly` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY (`group_id`, `path`),
	CHECK (`attachment_kind` IS NULL OR `attachment_kind` IN ('repo','group')),
	CHECK (
		(`attachment_kind` IS NULL AND `cached_repo_id` IS NULL AND `child_group_id` IS NULL
			AND `ref` = '' AND `subdir` = '' AND `readonly` = 0) OR
		(`attachment_kind` = 'repo' AND `cached_repo_id` IS NOT NULL AND `child_group_id` IS NULL) OR
		(`attachment_kind` = 'group' AND `child_group_id` IS NOT NULL AND `cached_repo_id` IS NULL
			AND `ref` = '' AND `subdir` = '')
	),
	FOREIGN KEY (`group_id`) REFERENCES `repo_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cached_repo_id`) REFERENCES `cached_repos`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_group_id`) REFERENCES `repo_groups`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint

-- 每个组先建显式 root。
INSERT INTO `repo_group_nodes` (`group_id`, `path`)
SELECT `id`, '' FROM `repo_groups`;--> statement-breakpoint

-- 把每个旧 mount_path 拆成全部祖先；`a/b/c` 产生 a、a/b、a/b/c。
WITH RECURSIVE `prefixes` (`group_id`, `rest`, `prefix`) AS (
	SELECT `group_id`, `mount_path`, ''
	FROM `repo_group_members`
	WHERE `mount_path` <> ''
	UNION ALL
	SELECT
		`group_id`,
		CASE WHEN instr(`rest`, '/') = 0 THEN '' ELSE substr(`rest`, instr(`rest`, '/') + 1) END,
		CASE
			WHEN `prefix` = '' THEN CASE WHEN instr(`rest`, '/') = 0 THEN `rest` ELSE substr(`rest`, 1, instr(`rest`, '/') - 1) END
			ELSE `prefix` || '/' || CASE WHEN instr(`rest`, '/') = 0 THEN `rest` ELSE substr(`rest`, 1, instr(`rest`, '/') - 1) END
		END
	FROM `prefixes`
	WHERE `rest` <> ''
)
INSERT OR IGNORE INTO `repo_group_nodes` (`group_id`, `path`)
SELECT `group_id`, `prefix` FROM `prefixes` WHERE `prefix` <> '';--> statement-breakpoint

-- 终点节点挂回原 repo/group；祖先保持纯目录。
UPDATE `repo_group_nodes`
SET
	`attachment_kind` = (SELECT `kind` FROM `repo_group_members` m WHERE m.`group_id` = `repo_group_nodes`.`group_id` AND m.`mount_path` = `repo_group_nodes`.`path` LIMIT 1),
	`cached_repo_id` = (SELECT `cached_repo_id` FROM `repo_group_members` m WHERE m.`group_id` = `repo_group_nodes`.`group_id` AND m.`mount_path` = `repo_group_nodes`.`path` LIMIT 1),
	`ref` = COALESCE((SELECT `ref` FROM `repo_group_members` m WHERE m.`group_id` = `repo_group_nodes`.`group_id` AND m.`mount_path` = `repo_group_nodes`.`path` LIMIT 1), ''),
	`subdir` = COALESCE((SELECT `subdir` FROM `repo_group_members` m WHERE m.`group_id` = `repo_group_nodes`.`group_id` AND m.`mount_path` = `repo_group_nodes`.`path` LIMIT 1), ''),
	`child_group_id` = (SELECT `child_group_id` FROM `repo_group_members` m WHERE m.`group_id` = `repo_group_nodes`.`group_id` AND m.`mount_path` = `repo_group_nodes`.`path` LIMIT 1),
	`readonly` = COALESCE((SELECT `readonly` FROM `repo_group_members` m WHERE m.`group_id` = `repo_group_nodes`.`group_id` AND m.`mount_path` = `repo_group_nodes`.`path` LIMIT 1), 0)
WHERE EXISTS (
	SELECT 1 FROM `repo_group_members` m
	WHERE m.`group_id` = `repo_group_nodes`.`group_id` AND m.`mount_path` = `repo_group_nodes`.`path`
);--> statement-breakpoint

-- 旧 member 必须逐条有唯一等价 attachment；否则 migration 整体回滚。
INSERT INTO `__rfc249_assert` (`ok`)
SELECT CASE WHEN
	(SELECT COUNT(*) FROM `repo_group_members`) =
	(SELECT COUNT(*) FROM `repo_group_nodes` WHERE `attachment_kind` IS NOT NULL)
	AND NOT EXISTS (
		SELECT 1 FROM `repo_group_members` m
		WHERE NOT EXISTS (
			SELECT 1 FROM `repo_group_nodes` n
			WHERE n.`group_id` = m.`group_id`
				AND n.`path` = m.`mount_path`
				AND n.`attachment_kind` = m.`kind`
				AND n.`cached_repo_id` IS m.`cached_repo_id`
				AND n.`ref` = m.`ref`
				AND n.`subdir` = m.`subdir`
				AND n.`child_group_id` IS m.`child_group_id`
				AND n.`readonly` = m.`readonly`
		)
	)
	THEN 1 ELSE 0 END;--> statement-breakpoint

-- 每组恰有一个 root。
INSERT INTO `__rfc249_assert` (`ok`)
SELECT CASE WHEN NOT EXISTS (
	SELECT g.`id` FROM `repo_groups` g
	LEFT JOIN `repo_group_nodes` n ON n.`group_id` = g.`id` AND n.`path` = ''
	GROUP BY g.`id` HAVING COUNT(n.`path`) <> 1
) THEN 1 ELSE 0 END;--> statement-breakpoint

CREATE UNIQUE INDEX `idx_rgn_path_ci` ON `repo_group_nodes` (`group_id`, lower(`path`));--> statement-breakpoint
CREATE INDEX `idx_rgn_cached_repo` ON `repo_group_nodes` (`cached_repo_id`);--> statement-breakpoint
CREATE INDEX `idx_rgn_child_group` ON `repo_group_nodes` (`child_group_id`);--> statement-breakpoint
UPDATE `repo_groups` SET `schema_version` = 2;--> statement-breakpoint
DROP TABLE `repo_group_members`;--> statement-breakpoint
INSERT INTO `__rfc249_assert` (`ok`)
SELECT CASE WHEN (SELECT COUNT(*) FROM pragma_foreign_key_check('repo_group_nodes')) = 0
	THEN 1 ELSE 0 END;--> statement-breakpoint
DROP TABLE `__rfc249_assert`;
