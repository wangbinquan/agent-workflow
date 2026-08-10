-- GitLab 连接可配置多个仓库 URL 前缀。
--
-- 存量连接回填空集合，执行准入行为逐字不变。字段只允许 GitLab 持有非空值；
-- JSON 形状在 DB 层也锁成数组，避免绕过应用层写出无法安全解析的准入配置。
ALTER TABLE `code_host_connections`
ADD COLUMN `repository_url_prefixes_json` text NOT NULL DEFAULT '[]'
CHECK (
  json_valid(`repository_url_prefixes_json`)
  AND json_type(`repository_url_prefixes_json`) = 'array'
  AND (`provider` = 'gitlab' OR `repository_url_prefixes_json` = '[]')
);
