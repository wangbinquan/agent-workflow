-- RFC-050: per-job output language for the memory distiller. Recorded at
-- enqueue time so retries / merged siblings stay consistent even if the
-- admin flips `config.memoryDistillLang` mid-batch. Old rows (pre-RFC-050)
-- carry NULL; the distiller layer treats NULL as 'en-US' (RFC-041 baseline,
-- byte-level identical to before this RFC).
ALTER TABLE `memory_distill_jobs` ADD COLUMN `output_lang` text;
