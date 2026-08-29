-- RFC-341 collaboration cutover. All three collaboration families share one
-- request-wake owner, so they become dispatchable in the same migration that
-- activates the continuous continuation worker in the matching binary.
CREATE TABLE `__rfc341_collaboration_cutover_guard` (
	`singleton` integer PRIMARY KEY
);
--> statement-breakpoint
INSERT INTO `__rfc341_collaboration_cutover_guard` (`singleton`) VALUES (1);
--> statement-breakpoint
INSERT INTO `__rfc341_collaboration_cutover_guard` (`singleton`)
SELECT 1
WHERE (
	SELECT COUNT(*)
	FROM `committed_event_family_cutovers`
	WHERE `producer` = 'collaboration'
		AND `family` IN ('review', 'clarify', 'questions')
		AND `mode` = 'legacy'
		AND `epoch` = 1
) <> 3;
--> statement-breakpoint
DROP TABLE `__rfc341_collaboration_cutover_guard`;
--> statement-breakpoint
UPDATE `committed_event_family_cutovers`
SET `mode` = 'dispatchable',
	`epoch` = 2,
	`changed_at` = 1789833612066,
	`change_ref` = 'rfc341:collaboration-cutover'
WHERE `producer` = 'collaboration'
	AND `family` IN ('review', 'clarify', 'questions')
	AND `mode` = 'legacy'
	AND `epoch` = 1;
