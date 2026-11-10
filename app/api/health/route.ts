// GET /api/health - health check for Docker and monitoring: 200 when the app runs, is fully
// configured AND reaches the database, otherwise 503. Public, no data, no details (those go to the
// server log only).
import { NextResponse } from "next/server";
import { withService } from "@/lib/db";

export const dynamic = "force-dynamic";

// Settings the app needs in production (see DEPLOY.md); without them it would run, but insecurely
// (RESET_DECOY_SECRET falls back to a public constant) or with the wrong cookie/CSRF origin.
const REQUIRED_IN_PRODUCTION = ["APP_ORIGIN", "RESET_DECOY_SECRET"];

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    const missing = REQUIRED_IN_PRODUCTION.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      console.error(`health check: required settings missing: ${missing.join(", ")}`);
      return NextResponse.json({ status: "misconfigured" }, { status: 503, headers: noStore });
    }
  }
  try {
    await withService((db) => db.query("SELECT 1"), { readOnly: true });
    return NextResponse.json({ status: "ok" }, { headers: noStore });
  } catch (error) {
    console.error("health check: database not reachable", error instanceof Error ? error.message : error);
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers: noStore });
  }
}
