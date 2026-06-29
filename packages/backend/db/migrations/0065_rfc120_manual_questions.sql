-- RFC-120 §15 — manual questions (自主新增/复制). Hand-written; additive; registered
-- in meta/_journal.json. Three ALTER statements → each needs the breakpoint separator
-- (RFC-108 0052/0053 incident: without it only the first statement applies, silently).
-- The marker literal is written on its own line below, NEVER inside a comment (or the
-- migrator splits the comment off as an empty statement).
--
-- A manual question = a human authors a title + instruction and assigns an agent node;
-- dispatching it reruns that node with the instruction injected as External Feedback
-- (NO human-answer step). It is a source_kind='manual' task_questions row whose injected
-- content is manual_body instead of a cross-clarify round's Q&A.
--
-- manual_title : the human-authored question/instruction title (DTO questionTitle).
-- manual_body  : the human-authored instruction body — the content injected as External
--   Feedback when the assigned node reruns (DTO answerSummary).
-- manual_created_by : audit-only id of the task member who authored it. UI/audit ONLY —
--   NEVER enters an agent prompt (RFC-099 prompt-isolation).
--
-- NO nullability/index change: a manual row keeps origin_node_run_id NOT NULL by storing
-- its OWN fresh ULID there (a non-null synthetic identity — RFC-120 §16 H4's sanctioned
-- alternative to "nullable + partial unique index"). Synthetic origins are unique, so the
-- existing uniq_task_questions_identity(origin_node_run_id,question_id,role_kind) never
-- collides and stays byte-for-byte for clarify rows (golden-lock). source_kind gains the
-- value 'manual' at the app layer only (the column has no DB CHECK), so it needs no DDL.
-- All three columns are nullable + additive; default null = today's behavior for every
-- existing (clarify) row.
ALTER TABLE `task_questions` ADD COLUMN `manual_title` text;
--> statement-breakpoint
ALTER TABLE `task_questions` ADD COLUMN `manual_body` text;
--> statement-breakpoint
ALTER TABLE `task_questions` ADD COLUMN `manual_created_by` text;
