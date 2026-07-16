-- RFC-200 (T1) — 每 run 信封 nonce。runner 派发时生成（crypto 随机）并持久化到
-- node_runs.envelope_nonce；协议块 emit `<workflow-output nonce="…">`，解析器（T3）
-- 只采信本 run 的 nonce，令被回显/伪造的裸信封无法被采信（关闭 echo-forge + last-wins
-- 向量）。resume / followup 复用同 run 已存 nonce，令 inline 会话早轮的 nonce 仍有效。
-- NULL = RFC-200 之前派发的在途 run（解析回退裸标签匹配，字节兼容）。不 backfill。
ALTER TABLE node_runs ADD COLUMN envelope_nonce TEXT;
