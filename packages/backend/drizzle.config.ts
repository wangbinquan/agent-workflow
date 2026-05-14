import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './db/migrations',
  dialect: 'sqlite',
  // Migrations are applied at daemon startup against ~/.agent-workflow/db.sqlite,
  // not via drizzle-kit at build time. This config is only used by `drizzle-kit generate`.
})
