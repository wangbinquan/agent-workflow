-- RFC-277 — GitLab 连接可显式关闭 TLS 证书校验。
--
-- 默认 1 是兼容性与安全边界：所有存量连接升级后行为逐字不变。应用层只允许
-- GitLab 写 0；数据库 CHECK 同时锁住布尔域与 provider 边界，避免绕过应用层
-- 写出一个 GitHub 的伪“不校验证书”配置。
ALTER TABLE `code_host_connections`
ADD COLUMN `reject_unauthorized` integer NOT NULL DEFAULT 1
CHECK (
  `reject_unauthorized` IN (0, 1)
  AND (`provider` = 'gitlab' OR `reject_unauthorized` = 1)
);
