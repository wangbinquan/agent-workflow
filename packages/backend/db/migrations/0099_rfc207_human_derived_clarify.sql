-- RFC-207 — 工作组反问改由「花名册是否含人工成员」派生
--
-- 1) 删除 RFC-180/181 的 `autonomous` 开关列。它是「这个组要不要人参与」的第二
--    事实源，与花名册天然冲突：两种不一致组合都是 bug（没人却还在问 / 有人却被
--    硬压制）。判据改为 workgroupHasHumanMember(members)，无需存储。
-- 2) 新增 `clarify_budget`：同一提问方（leader / 每张派单 / 每个成员）最多向人
--    反问几次，用满后被要求自行决断。防止「加了人之后反问永不停」。
-- 3) 遣散留痕字面量改名：'wg-autonomous-dismissed' 描述的是已不存在的开关；新值
--    'wg-clarify-disabled' 描述真实原因（组内已无人工成员）。历史行一并回填，避免
--    前端要同时认两个值。
--
-- 注意：各语句之间必须带分隔标记，缺了它只有第一条会被执行，而且是静默的。

ALTER TABLE workgroups DROP COLUMN autonomous;
--> statement-breakpoint
ALTER TABLE workgroups ADD COLUMN clarify_budget integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
UPDATE node_runs SET error_message = 'wg-clarify-disabled'
  WHERE error_message = 'wg-autonomous-dismissed';
