-- RFC-341 collaboration cutover. All three collaboration families share one
-- request-wake owner, so they become dispatchable in the same migration that
-- activates the continuous continuation worker in the matching binary.
CREATE TABLE `__rfc341_collaboration_cutover_guard` (
	`legacy_family_count` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `__rfc341_collaboration_cutover_precondition`
BEFORE INSERT ON `__rfc341_collaboration_cutover_guard`
WHEN NEW.`legacy_family_count` <> 3
BEGIN
	SELECT RAISE(ABORT, 'rfc341 collaboration cutover precondition failed');
END;
--> statement-breakpoint
INSERT INTO `__rfc341_collaboration_cutover_guard` (`legacy_family_count`)
SELECT COUNT(*)
FROM `committed_event_family_cutovers`
WHERE `producer` = 'collaboration'
	AND `family` IN ('review', 'clarify', 'questions')
	AND `mode` = 'legacy'
	AND `epoch` = 1;
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
