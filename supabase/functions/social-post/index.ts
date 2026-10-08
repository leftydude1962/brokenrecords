// social-post: posts one world record a day to the Broken Records Facebook Page at 6 AM Central.
//
// A cron job calls this at 11:00 and 12:00 UTC. Only the call that lands at 6 AM in Chicago posts,
// so the time stays right through daylight saving changes. It posts at most once per day.
//
// Which record:
//   1. A record the news watcher added or updated in the last 2 days and not yet posted ("New record").
//   2. Otherwise a record never posted before, from the section posted least recently, so the feed
//      rotates through sports, nature, space, music and the rest.
// The post is the record's image with a short caption and a link to its page.
//
// Secrets: FB_PAGE_ID and FB_PAGE_TOKEN (a Page access token with pages_manage_posts).
// Body options: {"dryRun": true} shows the caption without posting; {"force": true} skips the 6 AM check.
import { createClient } from "npm:@supabase/supabase-js@2";
import { formatValue } from "./format.ts";

const GRAPH = "https://graph.facebook.com/v23.0";
const SITE = "https://brokenrecords.com";

type Row = {
  id: string; slug: string; title: string; holder: string | null; value_numeric: number | null; value_text: string | null;
  unit: string | null; achieved_on: string | null; location: string | null; poster_url: string | null; updated_at: string | null;
  created_at: string | null; category_id: string;
};

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;
  const force = body?.force === true;
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // Post only at 6 AM Chicago time, once a day.
  const now = new Date();
  const chicagoHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(now));
  if (!force && !dryRun && chicagoHour !== 6) return json({ skipped: `not 6 AM in Chicago (hour ${chicagoHour})` });
  const { data: today } = await sb.from("social_posts").select("id").eq("platform", "facebook").is("error", null)
    .gt("posted_at", new Date(now.getTime() - 20 * 3600 * 1000).toISOString()).limit(1);
  if (!dryRun && today?.length) return json({ skipped: "already posted today" });

  // Categories and sections, to label the post and rotate through sections.
  const { data: cats } = await sb.from("categories").select("id,slug,name,parent_id");
  const byId = new Map((cats ?? []).map((c) => [c.id, c]));
  const sectionOf = (catId: string) => {
    const c = byId.get(catId);
    return c?.parent_id ? byId.get(c.parent_id) ?? c : c;
  };

  const { data: posted } = await sb.from("social_posts").select("record_id,posted_at").eq("platform", "facebook").is("error", null);
  const lastPost = new Map<string, string>();
  for (const p of posted ?? []) if (p.record_id) lastPost.set(p.record_id, p.posted_at);

  const cols = "id,slug,title,holder,value_numeric,value_text,unit,achieved_on,location,poster_url,updated_at,created_at,category_id";
  const { data: recs } = await sb.from("records").select(cols).eq("status", "published").not("poster_url", "is", null);
  const all = (recs ?? []) as Row[];

  // 1. Fresh news: a record the news watcher published or updated in the last 2 days, not posted since.
  //    The watcher logs each change in the candidates table (new records match by title).
  const { data: news } = await sb.from("candidates").select("record_id,created_at,claude_json")
    .in("status", ["auto_published", "approved"]).gt("created_at", new Date(Date.now() - 48 * 3600 * 1000).toISOString())
    .order("created_at", { ascending: false });
  let pick: Row | undefined;
  for (const n of news ?? []) {
    const title = (n.claude_json as { title?: string } | null)?.title?.trim().toLowerCase();
    const r = all.find((x) => (n.record_id && x.id === n.record_id) || (!n.record_id && title && x.title.toLowerCase() === title));
    if (r && !(Date.parse(lastPost.get(r.id) ?? "") > Date.parse(n.created_at))) { pick = r; break; }
  }
  const isNews = !!pick;

  // 2. Rotation: never-posted records from the section posted least recently.
  if (!pick) {
    const sectionLast = new Map<string, number>();
    for (const r of all) {
      const s = sectionOf(r.category_id)?.id ?? "";
      const t = Date.parse(lastPost.get(r.id) ?? "") || 0;
      sectionLast.set(s, Math.max(sectionLast.get(s) ?? 0, t));
    }
    const unposted = all.filter((r) => !lastPost.has(r.id));
    const pool = unposted.length ? unposted : all;
    pool.sort((a, b) => (sectionLast.get(sectionOf(a.category_id)?.id ?? "") ?? 0) - (sectionLast.get(sectionOf(b.category_id)?.id ?? "") ?? 0) || Math.random() - 0.5);
    pick = pool[0];
  }
  if (!pick) return json({ error: "no record with an image to post" }, 500);

  const v = formatValue({ ...pick, title: pick.title });
  const figure = `${v.value}${v.unit ? " " + v.unit : ""}`;
  const section = sectionOf(pick.category_id)?.name ?? "World records";
  const year = pick.achieved_on ? pick.achieved_on.slice(0, 4) : null;
  const where = [pick.location, year].filter(Boolean).join(", ");
  const tag = "#" + section.split(/[^A-Za-z]+/).filter((w) => w && w !== "and").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  const message = [
    isNews ? `NEW RECORD: ${pick.title}` : pick.title,
    "",
    `${figure}${pick.holder ? ` · ${pick.holder}` : ""}`,
    where || null,
    "",
    `Sources and the full record: ${SITE}/records/${pick.slug}`,
    "",
    `#WorldRecord ${tag}`,
  ].filter((l) => l !== null).join("\n");

  if (dryRun) return json({ dryRun: true, record: pick.slug, isNews, image: pick.poster_url, message });

  const pageId = Deno.env.get("FB_PAGE_ID");
  const token = Deno.env.get("FB_PAGE_TOKEN");
  if (!pageId || !token) return json({ error: "FB_PAGE_ID or FB_PAGE_TOKEN secret is not set" }, 500);

  const form = new URLSearchParams({ url: pick.poster_url!.split("?")[0], caption: message, published: "true", access_token: token });
  const res = await fetch(`${GRAPH}/${pageId}/photos`, { method: "POST", body: form });
  const out = await res.json().catch(() => ({}));
  const ok = res.ok && (out.post_id || out.id);
  await sb.from("social_posts").insert({
    record_id: pick.id, platform: "facebook", kind: isNews ? "news" : "daily", message,
    external_id: ok ? out.post_id ?? out.id : null, error: ok ? null : JSON.stringify(out.error ?? out).slice(0, 500),
  });
  return json(ok ? { posted: pick.slug, post_id: out.post_id ?? out.id } : { error: out.error ?? out }, ok ? 200 : 502);
});

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });
