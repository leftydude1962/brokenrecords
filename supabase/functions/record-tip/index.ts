// record-tip: public "Tip us off to a record" form (/tip).
//
// A visitor tells us about a record that was set or broken, with a link to where it was
// reported. The tip does NOT publish anything. It becomes a research draft in candidates
// (claude_json.kind = "draft", source = "tip", state = "todo"). The record-draft job then
// researches it, and the owner approves or rejects it on /admin.
//
// Body (JSON): { what, details?, source_url, category?, name?, email?, website?, turnstile_token }
//   what      the record in the visitor's words, 5 to 200 characters
//   name      optional, shown as "Tipped by <name>" if the tip is published
//   website   hidden honeypot field. Real visitors leave it empty. Bots often fill it in.
//   subscribe true when the visitor ticked "Also send me the weekly email". With an email, the
//             address is added to subscribers as pending; mail-jobs sends the confirm email.
// Rate limit: at most 5 tips per IP hash in 10 minutes. The raw IP is never stored.
// Public endpoint (verify_jwt = false). CORS allows only the site origin.
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
  new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } });

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

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// Checks the Turnstile token with Cloudflare. Secret: TURNSTILE_SECRET_KEY (set in Supabase only).
async function verifyTurnstile(token: string, clientIp: string): Promise<boolean> {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) throw new Error("TURNSTILE_SECRET_KEY is not set");
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (clientIp !== "unknown") form.append("remoteip", clientIp);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const out = await res.json().catch(() => ({ success: false }));
  return out.success === true;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Send JSON." }, 400, origin);

  // Honeypot: pretend success, store nothing.
  if (str(body.website)) return json({ ok: true }, 200, origin);

  const what = str(body.what);
  const details = str(body.details);
  const sourceUrl = str(body.source_url);
  const category = str(body.category);
  const name = str(body.name).replace(/\s+/g, " ");
  const email = str(body.email);

  if (what.length < 5 || what.length > 200) return json({ error: "Tell us the record in 5 to 200 characters." }, 400, origin);
  if (details.length > 1000) return json({ error: "Keep the details under 1,000 characters." }, 400, origin);
  if (!sourceUrl || sourceUrl.length > 500 || !isHttpUrl(sourceUrl)) {
    return json({ error: "Add a link to a news story or official page that reports the record." }, 400, origin);
  }
  if (name.length > 60 || /https?:|www\.|[<>]/i.test(name)) return json({ error: "Use a plain name, 60 characters or less." }, 400, origin);
  if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return json({ error: "That email address does not look right." }, 400, origin);
  }
  if (category && !/^[a-z0-9-]{2,60}$/.test(category)) return json({ error: "Pick a category from the list." }, 400, origin);

  // Bot check before any database work.
  const token = str(body.turnstile_token);
  if (!token) return json({ error: "Please complete the check and try again." }, 400, origin);
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  try {
    if (!(await verifyTurnstile(token, ip))) {
      return json({ error: "The check did not pass. Refresh the page and try again." }, 403, origin);
    }
  } catch {
    return json({ error: "Something went wrong. Try again later." }, 500, origin);
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const ipHash = await sha256Hex(ip + "|record-tip");
  const since = new Date(Date.now() - RATE_WINDOW_MIN * 60_000).toISOString();
  const { count } = await sb
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .eq("claude_json->>source", "tip")
    .eq("claude_json->>ip_hash", ipHash)
    .gte("created_at", since);
  if ((count ?? 0) >= RATE_LIMIT) return json({ error: "Too many tips at once. Try again in a few minutes." }, 429, origin);

  // Keep the category only if it is a real one.
  let categoryGuess: string | null = null;
  if (category) {
    const { data: cat } = await sb.from("categories").select("slug").eq("slug", category).maybeSingle();
    categoryGuess = cat?.slug ?? null;
  }

  const { error } = await sb.from("candidates").insert({
    record_id: null,
    proposed_holder: null,
    proposed_value_text: null,
    unit: null,
    category_guess: categoryGuess,
    source_urls: [sourceUrl],
    claude_json: {
      kind: "draft",
      source: "tip",
      state: "todo",
      title: what,
      better_direction: "higher",
      tip: { what, details: details || null, url: sourceUrl, name: name || null, email: email || null },
      ip_hash: ipHash,
    },
    checks_passed: { submitted: true },
    status: "pending",
  });
  if (error) return json({ error: "Something went wrong. Try again later." }, 500, origin);

  // Optional signup for the weekly email. Double opt-in still applies: they must click the confirm link.
  if (body.subscribe === true && email) {
    const lower = email.toLowerCase();
    const { data: sub } = await sb.from("subscribers").select("id,status").eq("email", lower).maybeSingle();
    if (!sub) await sb.from("subscribers").insert({ email: lower, source: "tip", ip_hash: ipHash });
    else if (sub.status === "unsubscribed") {
      await sb.from("subscribers").update({ status: "pending", token: crypto.randomUUID(), unsubscribed_at: null, confirm_sent_at: null, source: "tip" }).eq("id", sub.id);
    }
  }

  return json({ ok: true }, 200, origin);
});
