import { createClient } from "npm:@supabase/supabase-js@2";

const WDQS = "https://query.wikidata.org/sparql";
const UA = "BrokenRecordsBot/0.1 (https://brokenrecords.com; world records aggregator)";

type Binding = Record<string, { value: string }>;
type Pick = {
  holder: string;
  qid: string;
  valueNumeric: number;
  valueText: string | null;
  achievedOn: string | null;
  location: string | null;
};
type Def = {
  slug: string;
  categorySlug: string;
  title: string;
  unit: string;
  direction: "higher" | "lower";
  sparql: string;
  pick: (rows: Binding[]) => Pick | null;
};

const LABEL = `SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }`;
const isQidLabel = (s?: string) => !s || /^Q\d+$/.test(s);
const qidOf = (b: Binding) => b.item.value.split("/").pop()!;

// Takes the first row (rows arrive sorted best-first) whose value passes a sanity range.
// lowestPerItem: some items carry several height values (with and without spire).
// Use the lowest one, which matches the architectural height that rankings use.
const simplePick = (min: number, max: number, lowestPerItem = false) =>
  (rows: Binding[]): Pick | null => {
    for (const r of rows) {
      let v = Number(r.value?.value);
      const label = r.itemLabel?.value;
      if (!Number.isFinite(v) || v < min || v > max || isQidLabel(label)) continue;
      if (lowestPerItem) {
        for (const o of rows) {
          if (o.item.value !== r.item.value) continue;
          const ov = Number(o.value?.value);
          if (Number.isFinite(ov) && ov >= min && ov < v) v = ov;
        }
      }
      return {
        holder: label!,
        qid: qidOf(r),
        valueNumeric: v,
        valueText: null,
        achievedOn: r.date?.value ? r.date.value.slice(0, 10) : null,
        location: isQidLabel(r.placeLabel?.value) ? null : r.placeLabel!.value,
      };
    }
    return null;
  };

// Rule for every definition: only add one when a dry run shows Wikidata returns the
// correct answer. Wikidata gaps (no mass on the blue whale, for example) give wrong records.
// Tried and removed: heaviest animal (wrong answer), tallest and oldest person (query timeouts).
const DEFS: Def[] = [
  {
    slug: "tallest-building",
    categorySlug: "architecture",
    title: "Tallest building",
    unit: "m",
    direction: "higher",
    sparql: `SELECT ?item ?itemLabel ?value ?date ?placeLabel WHERE {
  ?item wdt:P31 wd:Q11303 ; wdt:P1619 ?date ; p:P2048 ?s .
  ?s psn:P2048 ?n . ?n wikibase:quantityAmount ?value .
  OPTIONAL { ?item wdt:P131 ?place . }
  ${LABEL}
} ORDER BY DESC(?value) LIMIT 8`,
    pick: simplePick(100, 1100, true),
  },
  {
    slug: "longest-bridge",
    categorySlug: "architecture",
    title: "Longest bridge",
    unit: "m",
    direction: "higher",
    sparql: `SELECT ?item ?itemLabel ?value ?date ?placeLabel WHERE {
  ?item wdt:P31/wdt:P279* wd:Q12280 ; wdt:P1619 ?date ; p:P2043 ?s .
  ?s psn:P2043 ?n . ?n wikibase:quantityAmount ?value .
  OPTIONAL { ?item wdt:P131 ?place . }
  ${LABEL}
} ORDER BY DESC(?value) LIMIT 8`,
    pick: simplePick(1000, 200000),
  },
];

async function runSparql(query: string): Promise<Binding[]> {
  const url = `${WDQS}?format=json&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
    signal: AbortSignal.timeout(58000),
  });
  if (!res.ok) throw new Error(`WDQS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.results.bindings as Binding[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;
  const only: string[] | null = Array.isArray(body?.only) ? body.only : null;

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // The anon key is public, so limit real runs to one per 30 minutes.
  if (!dryRun) {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: recent } = await sb.from("sync_runs").select("id")
      .eq("source", "wikidata").eq("dry_run", false).gt("started_at", since).limit(1);
    if (recent && recent.length) {
      return json({ error: "rate_limited", detail: "A real sync ran in the last 30 minutes." }, 429);
    }
  }

  const { data: run } = await sb.from("sync_runs")
    .insert({ source: "wikidata", dry_run: dryRun }).select("id").single();

  const defs = DEFS.filter((d) => !only || only.includes(d.slug));

  const results = await Promise.all(defs.map(async (def) => {
    try {
      const rows = await runSparql(def.sparql);
      const pick = def.pick(rows);
      if (dryRun) {
        return {
          slug: def.slug,
          rowCount: rows.length,
          pick,
          topRows: rows.slice(0, 5).map((r) =>
            Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.value]))
          ),
        };
      }
      if (!pick) return { slug: def.slug, status: "no_valid_result", rowCount: rows.length };
      return { slug: def.slug, status: await save(sb, def, pick) };
    } catch (e) {
      return { slug: def.slug, status: "error", error: (e as Error).message };
    }
  }));

  if (run?.id) {
    await sb.from("sync_runs")
      .update({ finished_at: new Date().toISOString(), stats: results })
      .eq("id", run.id);
  }
  return json({ dryRun, results });
});

// New records fill an empty slot. A changed top result never overwrites a live record.
// It goes to the candidates queue for the two-source check instead.
async function save(sb: ReturnType<typeof createClient>, def: Def, pick: Pick): Promise<string> {
  const { data: cat, error: catErr } = await sb.from("categories").select("id").eq("slug", def.categorySlug).single();
  if (catErr || !cat) throw new Error(`category ${def.categorySlug} not found`);

  const { data: existing, error: exErr } = await sb.from("records").select("*").eq("slug", def.slug).maybeSingle();
  if (exErr) throw new Error(exErr.message);

  const sourceUrl = `https://www.wikidata.org/wiki/${pick.qid}`;

  if (!existing) {
    const { data: rec, error } = await sb.from("records").insert({
      slug: def.slug,
      category_id: cat.id,
      title: def.title,
      holder: pick.holder,
      value_numeric: pick.valueNumeric,
      value_text: pick.valueText,
      unit: def.unit,
      better_direction: def.direction,
      achieved_on: pick.achievedOn,
      location: pick.location,
      wikidata_id: pick.qid,
      status: "published",
    }).select("id").single();
    if (error) throw new Error(error.message);
    const { error: srcErr } = await sb.from("record_sources").insert({
      record_id: rec.id, url: sourceUrl, publisher: "Wikidata", license: "CC0 1.0",
    });
    if (srcErr) throw new Error(srcErr.message);
    return "created";
  }

  const sameHolder = existing.wikidata_id === pick.qid;
  const sameValue = Math.abs(Number(existing.value_numeric) - pick.valueNumeric) < 1e-6;
  if (sameHolder && sameValue) {
    const { error } = await sb.from("records")
      .update({ last_verified_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    return "unchanged";
  }

  const { data: dup } = await sb.from("candidates").select("id")
    .eq("record_id", existing.id).eq("status", "pending")
    .eq("proposed_holder", pick.holder).eq("proposed_value_numeric", pick.valueNumeric).limit(1);
  if (dup && dup.length) return "already_pending";

  const { error } = await sb.from("candidates").insert({
    record_id: existing.id,
    proposed_holder: pick.holder,
    proposed_value_numeric: pick.valueNumeric,
    proposed_value_text: pick.valueText,
    unit: def.unit,
    category_guess: def.categorySlug,
    source_urls: [sourceUrl],
    checks_passed: { source: "wikidata", structured: true, second_source: false },
    status: "pending",
  });
  if (error) throw new Error(error.message);
  return "change_queued_for_review";
}
