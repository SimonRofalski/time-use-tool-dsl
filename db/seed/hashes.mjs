// Prints the fixed hashes used in db/seed/seed.sql (run once; output is pasted into the seed).
//   node db/seed/hashes.mjs
// Dev password of every seed account: "Seed-Passwort-1". Security answers: "seed".
// Password hashes use the $2a$ prefix on purpose: accounts imported from the former auth service carry
// such hashes, so the seed also tests that bcryptjs verifies them.
import { scryptSync } from "node:crypto";
import bcrypt from "bcryptjs";

const pw = bcrypt.hashSync("Seed-Passwort-1", 10).replace(/^\$2b\$/, "$2a$");
if (!bcrypt.compareSync("Seed-Passwort-1", pw)) throw new Error("bcrypt self-check failed");
const salt = "5eed5eed5eed5eed5eed5eed5eed5eed";
const answer = `${salt}:${scryptSync("seed", salt, 64).toString("hex")}`;
console.log(JSON.stringify({ password_hash: pw, answer_hash: answer }, null, 1));
