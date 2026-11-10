// drizzle-kit is only used to READ the schema (npm run db:pull -> lib/db/schema.ts).
// Migrations are plain SQL in db/migrations, applied by db/scripts/migrate.mjs; policies, triggers and
// functions stay SQL. Never run drizzle-kit push/generate/migrate against any database.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  out: "./db/.pull",
  schemaFilter: ["public"],
  dbCredentials: {
    // owner login: the app login cannot see every table
    url: process.env.DATABASE_OWNER_URL ?? "postgresql://tut_local_owner:tut_local_owner_pw@127.0.0.1:15432/tut_local",
  },
});
