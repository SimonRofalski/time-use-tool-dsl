// Loads db/seed/seed.sql into the LOCAL dev database (as the owner). Refuses any non-local host.
//   node db/scripts/seed.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { assertLocal, urls } from "./env.mjs";

assertLocal(urls.owner, "seed");
const sql = readFileSync(resolve(import.meta.dirname, "..", "seed", "seed.sql"), "utf8");
const client = new pg.Client({ connectionString: urls.owner, application_name: "tut-seed" });
client.on("notice", (n) => console.log(n.message));
await client.connect();
try {
  await client.query(sql);
} finally {
  await client.end();
}
