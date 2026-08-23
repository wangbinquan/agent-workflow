-- RFC-317 T8 —— employee_definitions 成为第 13 类 ACL 资源。
--
-- 无 schema 改动：三列（owner_user_id / visibility / acl_revision）与 owner×name
-- 唯一索引自建表起就在，只是 'employee_definition' 从未进 ACL_RESOURCE_TYPES，于是
-- 它们完全惰性、列表只按 archived_at 过滤、全员可见全部员工定义。
--
-- 存量行**不回填**（用户裁决 D2(a)）：当前写路径恒把 owner_user_id 置为创建者、
-- visibility 恒为 'private'，所以入网后每个用户只看得见自己的员工定义——这正是被
-- 接受的能力收缩 C2。
--
-- 唯一的补丁是下面这条：owner 为 NULL 的历史孤儿行显式置 'public'。当前写路径产不
-- 出这种行（composition.ts 恒传 actorUserId），但列可空且唯一索引用了
-- COALESCE(owner_user_id,'')，说明 schema 预期过它。若真有这种行而保持 'private'，
-- 入网后它对**所有人**都不可见——包括管理员之外无人能修复。沿用 RFC-231
-- 「框架 built-in 显式保持 public」的口径，让它们可达。
UPDATE `employee_definitions`
SET `visibility` = 'public'
WHERE `owner_user_id` IS NULL;
