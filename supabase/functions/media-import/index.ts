// media-import: copies a real photo into the "media" storage bucket and makes it a record's poster.
//
// Why: generated posters come from KIE. A real news photo (used with permission and a credit) is
// committed to the site under public/photos/, deployed by Cloudflare, then copied here so it gets the
// same Storage URL and the 4:5 Instagram crop as every other poster.
//
// Locked like the scheduled jobs: the request needs the x-job-secret header.
// Body: { slug: "heaviest-pumpkin", url: "https://brokenrecords.com/photos/heaviest-pumpkin.jpg", credit: "Travis's Pumpkins (Facebook)" }
// Only brokenrecords.com URLs are accepted.
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (!(await jobSecretOk(req))) return json({ error: "Not allowed" }, 401);
  const body = await req.json().catch(() => ({}));
  const slug = String(body.slug ?? "");
  const credit = typeof body.credit === "string" && body.credit.trim() ? body.credit.trim().slice(0, 120) : null;
  let url: URL;
  try { url = new URL(String(body.url ?? "")); } catch { return json({ error: "Bad url" }, 400); }
  if (!/^(www\.)?brokenrecords\.com$/.test(url.hostname) || url.protocol !== "https:") return json({ error: "Only brokenrecords.com photos" }, 400);
  if (!/^[a-z0-9-]+$/.test(slug)) return json({ error: "Bad slug" }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: rec } = await sb.from("records").select("id").eq("slug", slug).eq("status", "published").maybeSingle();
  if (!rec) return json({ error: "Record not found" }, 404);

  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !/^image\/(jpeg|png|webp)/.test(type)) return json({ error: `Fetch failed: ${res.status} ${type}` }, 502);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > 5_000_000) return json({ error: "Photo is over 5 MB" }, 400);

  const path = `posters/${slug}-photo.${type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg"}`;
  const { error: upErr } = await sb.storage.from("media").upload(path, bytes, { contentType: type, upsert: true, cacheControl: "31536000" });
  if (upErr) return json({ error: upErr.message }, 500);
  const poster = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/media/${path}?v=${Date.now()}`;

  // A real photo replaces the generated poster and any generated clip, and media-gen leaves it alone (status done).
  const { error } = await sb.from("records").update({
    poster_url: poster, video_url: null, photo_credit: credit, media_status: "done", media_error: null,
  }).eq("id", rec.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, slug, poster, bytes: bytes.byteLength });
});

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });

// Same check as the scheduled jobs: compares the x-job-secret header with the job_secrets table.
async function jobSecretOk(req: Request): Promise<boolean> {
  const got = req.headers.get("x-job-secret");
  if (!got) return false;
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data } = await admin.from("job_secrets").select("value").eq("key", "jobs").maybeSingle();
  return !!data?.value && data.value === got;
}
