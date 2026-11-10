"use client";
// Browser-side auth client for client components (talks to app/api/auth/*). It keeps the method
// names and { data, error } result shapes of the former auth library, so the components' logic is
// unchanged. The session itself is an HttpOnly cookie the browser sends automatically; nothing is
// stored in JS.

export type AuthUser = { id: string; email: string; last_sign_in_at: string | null; created_at: string };
export type AuthError = { message: string; status: number };
type AuthEvent = "SIGNED_IN" | "SIGNED_OUT";
type Listener = (event: AuthEvent, session: { user: AuthUser } | null) => void;

// onAuthStateChange listeners of this tab; the BroadcastChannel forwards
// sign-in/sign-out to the other open tabs
const listeners = new Set<Listener>();
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("tut-auth") : null;

async function fetchUser(): Promise<AuthUser | null> {
  const res = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) return null;
  return ((await res.json()) as { user: AuthUser | null }).user;
}

async function emit(event: AuthEvent, broadcast = true) {
  const user = event === "SIGNED_IN" ? await fetchUser() : null;
  for (const l of listeners) l(event, user ? { user } : null);
  if (broadcast) channel?.postMessage(event);
}
channel?.addEventListener("message", (e) => {
  if (e.data === "SIGNED_IN" || e.data === "SIGNED_OUT") void emit(e.data, false); // other tabs
});

async function post(url: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

function toError(r: { status: number; json: Record<string, unknown> }): AuthError {
  return { message: typeof r.json.error === "string" ? r.json.error : "Request failed", status: r.status };
}

export const auth = {
  async getUser(): Promise<{ data: { user: AuthUser | null }; error: AuthError | null }> {
    const user = await fetchUser();
    return { data: { user }, error: null };
  },

  /** Same shape as getUser, wrapped as a session; there is no access token (the session is a cookie). */
  async getSession(): Promise<{ data: { session: { user: AuthUser } | null }; error: AuthError | null }> {
    const user = await fetchUser();
    return { data: { session: user ? { user } : null }, error: null };
  },

  async signInWithPassword(credentials: { email: string; password: string }) {
    const r = await post("/api/auth/login", credentials);
    if (!r.ok) return { data: { user: null, session: null }, error: toError(r) };
    await emit("SIGNED_IN");
    const user = await fetchUser();
    return { data: { user, session: user ? { user } : null }, error: null };
  },

  async signUp(credentials: { email: string; password: string }) {
    const r = await post("/api/auth/signup", credentials);
    if (!r.ok) return { data: { user: null, session: null }, error: toError(r) };
    await emit("SIGNED_IN");
    const user = await fetchUser();
    return { data: { user, session: user ? { user } : null }, error: null };
  },

  async signOut(): Promise<{ error: AuthError | null }> {
    const r = await post("/api/auth/logout");
    await emit("SIGNED_OUT");
    return { error: r.ok ? null : toError(r) };
  },

  onAuthStateChange(listener: Listener) {
    listeners.add(listener);
    return {
      data: {
        subscription: {
          unsubscribe: (): void => {
            listeners.delete(listener);
          },
        },
      },
    };
  },
};
