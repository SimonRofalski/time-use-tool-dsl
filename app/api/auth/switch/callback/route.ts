import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  getPublicAppOrigin,
  getSwitchOidcConfig,
  getSwitchRedirectUri,
  oidc,
} from "@/lib/oidc/client";
import { withService } from "@/lib/db";
import { createSession } from "@/lib/auth/session";
import {
  OidcAccountConflictError,
  resolveOrProvisionProfile,
} from "@/lib/oidc/provision";

// GET /api/auth/switch/callback - second half of the SWITCH edu-ID login
// (OIDC authorization code flow with PKCE, started by ../initiate). Exchanges
// the code, reads the claims, finds or creates the account
// (lib/oidc/provision.ts) and starts an app session. Errors redirect to the
// login page with ?error=<code>.

const PKCE_COOKIE_NAMES = [
  "switch_oidc_code_verifier",
  "switch_oidc_state",
  "switch_oidc_nonce",
] as const;

// Redirects use the public origin, not request.url (internal behind a proxy)
function errorRedirect(code: string) {
  const url = new URL("/", getPublicAppOrigin());
  url.searchParams.set("error", code);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const codeVerifier = cookieStore.get("switch_oidc_code_verifier")?.value;
  const expectedState = cookieStore.get("switch_oidc_state")?.value;
  const expectedNonce = cookieStore.get("switch_oidc_nonce")?.value;

  // One-time values: cleared right away, whatever the outcome
  for (const name of PKCE_COOKIE_NAMES) {
    cookieStore.delete(name);
  }

  if (!codeVerifier || !expectedState || !expectedNonce) {
    return errorRedirect("oidc_missing_session");
  }

  let claims: Record<string, unknown>;
  try {
    const config = await getSwitchOidcConfig();
    // openid-client sends this URL (minus its query) as redirect_uri, so it
    // must be the registered public callback URL plus the IdP's parameters
    const callbackUrl = new URL(getSwitchRedirectUri());
    callbackUrl.search = request.nextUrl.search;
    const tokens = await oidc.authorizationCodeGrant(
      config,
      callbackUrl,
      { pkceCodeVerifier: codeVerifier, expectedState, expectedNonce },
    );
    const idTokenClaims = tokens.claims();
    if (!idTokenClaims) {
      return errorRedirect("oidc_missing_claims");
    }
    // SWITCH (like the mock) releases email/name by default only via the
    // UserInfo endpoint; the ID token carries little more than `sub`.
    // fetchUserInfo also checks that UserInfo's sub matches the ID token's.
    const userInfo = await oidc.fetchUserInfo(
      config,
      tokens.access_token,
      idTokenClaims.sub,
    );
    claims = { ...idTokenClaims, ...userInfo };
  } catch (error) {
    console.error("SWITCH OIDC code exchange failed", error);
    return errorRedirect("oidc_exchange_failed");
  }

  const sub = typeof claims.sub === "string" ? claims.sub : undefined;
  const email = typeof claims.email === "string" ? claims.email : undefined;
  const firstName =
    typeof claims.given_name === "string" ? claims.given_name : undefined;
  const lastName =
    typeof claims.family_name === "string" ? claims.family_name : undefined;
  // Only an explicit false counts as unverified (claim may be absent)
  const emailVerified = claims.email_verified !== false;

  if (!sub || !email) {
    return errorRedirect("oidc_incomplete_identity");
  }

  let userId: string;
  try {
    ({ userId } = await withService((db) =>
      resolveOrProvisionProfile(db, {
        sub,
        email,
        firstName,
        lastName,
        emailVerified,
      }),
    ));
  } catch (error) {
    if (error instanceof OidcAccountConflictError) {
      return errorRedirect("oidc_account_conflict");
    }
    console.error("SWITCH edu-ID provisioning failed", error);
    return errorRedirect("oidc_provisioning_failed");
  }

  // The session is created for the account resolved above (by `sub` or by the
  // linked e-mail), never for the e-mail in the current claims: a returning
  // user may have changed their edu-ID e-mail since.
  try {
    await createSession(userId);
  } catch (error) {
    console.error("SWITCH edu-ID: session creation failed", error);
    return errorRedirect("oidc_session_failed");
  }

  return NextResponse.redirect(new URL("/erfasste-zeit", getPublicAppOrigin()));
}
