import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle-pg',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://aap:aap@localhost:5432/ai_app_panel',
  },
  strict: true,
  verbose: true,
});
