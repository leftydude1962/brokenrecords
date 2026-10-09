// record-correction: public form on each record page ("Spotted something out of date?").
//
// It does NOT change the live record. Each submission becomes a pending row in candidates
// (claude_json.kind = "submission") for a human to review, the same queue used for rechecks.
//
// Body (JSON): { slug, correction, source_url, email?, website? }
//   website is a hidden honeypot field. Real visitors leave it empty. Bots often fill it in.
// Rate limit: at most 5 submissions per IP hash in 10 minutes.
// Public endpoint (verify_jwt = false). Access is checked here: CORS allows only the site origin.
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://brokenrecords.com", "https://www.brokenrecords.com"];
const RATE_LIMIT = 5;
const RATE_WINDOW_MIN = 10;

const corsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
});

const json = (d: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const isHttpUrl = (u: string) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:";
  } catch {
    return false;
  }
};

// Checks the Turnstile token with Cloudflare. Returns true only when Cloudflare says it is valid.
// Secret: TURNSTILE_SECRET_KEY (set in Supabase, never in the site code).
async function verifyTurnstile(token: string, clientIp: string): Promise<{ success: boolean; codes: string[]; raw: unknown }> {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) throw new Error("TURNSTILE_SECRET_KEY is not set");
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (clientIp !== "unknown") form.append("remoteip", clientIp);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const out = await res.json().catch(() => ({ success: false, "error-codes": ["bad-response"] }));
  // error-codes are Cloudflare's reasons (for example "invalid-input-secret"). They are not secrets.
  return { success: out.success === true, codes: out["error-codes"] ?? [], raw: out };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Send JSON." }, 400, origin);

  // Honeypot: pretend success, store nothing.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ ok: true }, 200, origin);
  }

  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const correction = typeof body.correction === "string" ? body.correction.trim() : "";
  const sourceUrl = typeof body.source_url === "string" ? body.source_url.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!slug) return json({ error: "Missing record." }, 400, origin);
  if (correction.length < 10 || correction.length > 1000) {
    return json({ error: "Tell us what is wrong, in 10 to 1,000 characters." }, 400, origin);
  }
  if (!sourceUrl || sourceUrl.length > 500 || !isHttpUrl(sourceUrl)) {
    return json({ error: "Add a link to a source that shows the correct information." }, 400, origin);
  }
  if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return json({ error: "That email address does not look right." }, 400, origin);
  }

  // Bot check. Runs before any database work, so bots cost us nothing.
  const turnstileToken = typeof body.turnstile_token === "string" ? body.turnstile_token : "";
  if (!turnstileToken) return json({ error: "Please complete the check and try again." }, 400, origin);
  const clientIp = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  let check: { success: boolean; codes: string[]; raw: unknown };
  try {
    check = await verifyTurnstile(turnstileToken, clientIp);
  } catch {
    return json({ error: "Something went wrong. Try again later." }, 500, origin);
  }
  if (!check.success) {
    return json({ error: "The check did not pass. Refresh the page and try again." }, 403, origin);
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const { data: record, error: recErr } = await sb
    .from("records")
    .select("id,title")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();
  if (recErr) return json({ error: "Something went wrong. Try again later." }, 500, origin);
  if (!record) return json({ error: "We could not find that record." }, 404, origin);

  // Rate limit by hashed IP. The raw IP is never stored.
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const ipHash = await sha256Hex(ip + "|record-correction");
  const since = new Date(Date.now() - RATE_WINDOW_MIN * 60_000).toISOString();
  const { count } = await sb
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .eq("claude_json->>kind", "submission")
    .eq("claude_json->>ip_hash", ipHash)
    .gte("created_at", since);
  if ((count ?? 0) >= RATE_LIMIT) {
    return json({ error: "Too many submissions. Try again in a few minutes." }, 429, origin);
  }

  const { error } = await sb.from("candidates").insert({
    record_id: record.id,
    proposed_holder: null,
    proposed_value_text: correction.slice(0, 1000),
    unit: null,
    category_guess: null,
    source_urls: [sourceUrl],
    claude_json: {
      kind: "submission",
      correction,
      email: email || null,
      ip_hash: ipHash,
      record_title: record.title,
      model: null,
    },
    checks_passed: { submitted: true },
    status: "pending",
  });
  if (error) return json({ error: "Something went wrong. Try again later." }, 500, origin);

  return json({ ok: true }, 200, origin);
});
