-- RFC-145：失败形态结构化——error_message 上寄生的两个机器协议列化。
-- ①failure_code：信封失败 follow-up 分类（shared FAILURE_CODES 7 值，TS 边界
--   强制枚举，rerun_cause 先例）。②superseded_by_review + rolled_back：review
--   supersede 的三事实（是否/决策/回滚）结构化，isReviewSupersededRow
--   （RFC-095 LOAD-BEARING dispatch 契约）改读列。
-- backfill（拍板 D2：单读路径，不留 legacy 前缀回退）：本仓 flock 单实例 +
-- 启动时迁移 ⟹ 迁移后不存在旧代码写库窗口；未匹配前缀的行留 NULL 恰是正确
-- 语义（无机器可读失败）。七个信封前缀互不重叠、顺序无关；LIKE 谓词与今日
-- decide 链 startsWith 逐字对应（clarify-questions-% 有意不吃 clarify-options-*
-- 等码——今日路由对它们不给 follow-up，设计 D8）。
ALTER TABLE node_runs ADD COLUMN failure_code text;
--> statement-breakpoint
ALTER TABLE node_runs ADD COLUMN superseded_by_review text;
--> statement-breakpoint
ALTER TABLE node_runs ADD COLUMN rolled_back integer;
--> statement-breakpoint
UPDATE node_runs SET failure_code = 'envelope-missing'            WHERE failure_code IS NULL AND error_message LIKE 'no <workflow-output> envelope found in stdout%';
--> statement-breakpoint
UPDATE node_runs SET failure_code = 'clarify-and-output-both'     WHERE failure_code IS NULL AND error_message LIKE 'clarify-and-output-both-present%';
--> statement-breakpoint
UPDATE node_runs SET failure_code = 'clarify-questions-malformed' WHERE failure_code IS NULL AND error_message LIKE 'clarify-questions-%';
--> statement-breakpoint
UPDATE node_runs SET failure_code = 'clarify-required'            WHERE failure_code IS NULL AND error_message LIKE 'clarify-required%';
--> statement-breakpoint
UPDATE node_runs SET failure_code = 'clarify-forbidden'           WHERE failure_code IS NULL AND error_message LIKE 'clarify-forbidden%';
--> statement-breakpoint
UPDATE node_runs SET failure_code = 'envelope-port-malformed'     WHERE failure_code IS NULL AND error_message LIKE 'envelope-port-malformed%';
--> statement-breakpoint
UPDATE node_runs SET failure_code = 'port-validation-failed'      WHERE failure_code IS NULL AND error_message LIKE 'port-validation-%';
--> statement-breakpoint
UPDATE node_runs SET superseded_by_review = 'iterated' WHERE superseded_by_review IS NULL AND error_message LIKE 'superseded-by-review-iterated%';
--> statement-breakpoint
UPDATE node_runs SET superseded_by_review = 'rejected' WHERE superseded_by_review IS NULL AND error_message LIKE 'superseded-by-review-rejected%';
--> statement-breakpoint
UPDATE node_runs SET rolled_back = 1 WHERE error_message LIKE 'superseded-by-review-%-rollback:%';
