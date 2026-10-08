// Read-only data access for the public site.
// The URL and publishable key are public by design. Row level security in
// Supabase only lets this key read published records, categories and sources.
export const SUPABASE_URL = "https://ccwmynoumrqpvnmpcgch.supabase.co";
export const SUPABASE_KEY = "sb_publishable_XQGLSf28dqucKBAaV4XC4A_znvwj3Z5";

export type Source = { url: string; publisher: string | null; license: string | null; title?: string | null; published_on?: string | null; quote?: string | null };
/** Original write-up for a record page, made by the record-story job. */
export type Story = { sections: { heading: string; body: string }[]; quote: { text: string; url: string } | null; conflict?: string | null; issues?: string[] };
export type Category = { id: string; slug: string; name: string; parent_id?: string | null; sort_order?: number | null; count?: number };
/** A top-level section (Sports, Nature and Earth...) with the categories inside it. */
export type Section = Category & { children: Category[] };
export type RecordRow = {
  id: string;
  slug: string;
  title: string;
  holder: string | null;
  value_numeric: number | null;
  value_text: string | null;
  unit: string | null;
  better_direction: "higher" | "lower" | null;
  achieved_on: string | null;
  location: string | null;
  governing_body: string | null;
  status: string;
  last_verified_at: string | null;
  /** Set only when a check has confirmed the record against its sources. Null means never checked. */
  last_checked_at?: string | null;
  updated_at: string | null;
  poster_url: string | null;
  video_url: string | null;
  featured: boolean;
  categories: { slug: string; name: string } | null;
  record_sources: Source[];
  story?: Story | null;
  story_at?: string | null;
};

const RECORD_SELECT =
  "id,slug,title,holder,value_numeric,value_text,unit,better_direction,achieved_on,location,governing_body,status,last_verified_at,last_checked_at,updated_at,poster_url,video_url,featured,categories(slug,name),record_sources(url,publisher,license)";

async function rest<T>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// Old category addresses that were folded into another category. Their pages redirect,
// and they are left out of category lists.
export const MERGED_CATEGORIES: Record<string, string> = {
  buildings: "architecture",
  bridges: "architecture",
  structures: "architecture",
};

// Every category with its published record count. Merged (empty) categories are left out.
export async function getCategories(): Promise<Category[]> {
  const rows = await rest<Array<Category & { records: { count: number }[] }>>(
    "categories?select=id,slug,name,parent_id,sort_order,records(count)&records.status=eq.published&order=name.asc",
  );
  return rows
    .filter((r) => !(r.slug in MERGED_CATEGORIES))
    .map((r) => ({ id: r.id, slug: r.slug, name: r.name, parent_id: r.parent_id ?? null, sort_order: r.sort_order ?? null, count: r.records?.[0]?.count ?? 0 }));
}

// The two-level structure: 10 sections, each holding categories. A section's count is the
// total of its categories. sectionOf maps any category slug (or section slug) to its section.
export async function getTaxonomy() {
  const cats = await getCategories();
  const sections: Section[] = cats
    .filter((c) => !c.parent_id)
    .map((s) => {
      const children = cats.filter((c) => c.parent_id === s.id).sort((a, b) => a.name.localeCompare(b.name));
      return { ...s, children, count: (s.count ?? 0) + children.reduce((n, c) => n + (c.count ?? 0), 0) };
    })
    .filter((s) => s.children.length > 0 || (s.count ?? 0) > 0)
    .sort((a, b) => (a.sort_order ?? 99) - (b.sort_order ?? 99) || a.name.localeCompare(b.name));
  const sectionOf: Record<string, Section> = {};
  for (const s of sections) {
    sectionOf[s.slug] = s;
    for (const c of s.children) sectionOf[c.slug] = s;
  }
  return { sections, sectionOf, categories: cats };
}

export async function getCategory(slug: string): Promise<Category | null> {
  const rows = await rest<Category[]>(`categories?select=id,slug,name&slug=eq.${encodeURIComponent(slug)}`);
  return rows[0] ?? null;
}

export async function getRecords(opts: { categoryId?: string; categoryIds?: string[]; limit?: number } = {}): Promise<RecordRow[]> {
  let q = `records?select=${RECORD_SELECT}&status=eq.published&order=updated_at.desc`;
  if (opts.categoryId) q += `&category_id=eq.${opts.categoryId}`;
  if (opts.categoryIds?.length) q += `&category_id=in.(${opts.categoryIds.join(",")})`;
  if (opts.limit) q += `&limit=${opts.limit}`;
  return rest<RecordRow[]>(q);
}

export async function getRecord(slug: string): Promise<RecordRow | null> {
  // The record page also needs the story and the source details; card lists don't.
  const select = RECORD_SELECT.replace("record_sources(url,publisher,license)", "record_sources(url,publisher,license,title,published_on,quote)") + ",story,story_at";
  const rows = await rest<RecordRow[]>(
    `records?select=${select}&slug=eq.${encodeURIComponent(slug)}&status=in.(published,superseded)`,
  );
  return rows[0] ?? null;
}

// US display. This is the main value on every page. The database stays metric because sources publish
// in metric; conversion happens only here. Heights and depths read in feet, distances in miles.
type Displayable = Pick<RecordRow, "value_numeric" | "value_text" | "unit"> & { title?: string };
const FT = 0.3048, MI = 1609.344, SQMI = 2.589988110336, LB = 0.45359237;

export function formatValue(r: Displayable): { value: string; unit: string } {
  const n = r.value_numeric == null ? null : Number(r.value_numeric);
  if (n == null || Number.isNaN(n)) return formatMetric(r);
  const vertical = /tall|high|deep|height|depth|vault|jump/i.test(r.title ?? "");
  switch (r.unit) {
    case "m":
      if (vertical || n < 10) return lengthUS(n, true);
      return lengthUS(n, false);
    case "km": {
      const mi = n * 1000 / MI;
      return { value: trim(mi, mi >= 100 ? 0 : 1), unit: "miles" };
    }
    case "mm":
    case "cm": {
      // Rain, snow and hail read in inches; very deep totals switch to feet.
      const inches = n / (r.unit === "mm" ? 25.4 : 2.54);
      if (inches >= 240 && /snow/i.test(r.title ?? "")) return { value: trim(inches / 12, 0), unit: "ft" };
      if (inches >= 100) return { value: trim(inches, 0), unit: "in" };
      return { value: trim(inches, 1), unit: "in" };
    }
    case "hPa":
      return { value: trim(n * 0.0295300, 2), unit: "inHg" };
    case "m2":
      return { value: trim(n * 10.7639104, 0), unit: "sq ft" };
    case "m3":
      return { value: trim(n * 35.3146667, 0), unit: "cu ft" };
    case "km2": {
      const sq = n / SQMI;
      if (sq >= 1_000_000) return { value: trim(sq / 1_000_000, 2), unit: "million sq mi" };
      return { value: trim(sq, 0), unit: "sq mi" };
    }
    case "kg": {
      const lb = n / LB;
      if (lb >= 4000) return { value: trim(lb / 2000, lb / 2000 >= 100 ? 0 : 1), unit: "tons" };
      return { value: trim(lb, lb < 10 ? 2 : 0), unit: "lb" };
    }
    case "km/h": {
      const mph = n / 1.609344;
      return { value: trim(mph, mph >= 1000 ? 0 : 1), unit: "mph" };
    }
    case "°C":
      return { value: trim(n * 9 / 5 + 32, 1).replace("-", "−"), unit: "°F" };
    default:
      return formatMetric(r);
  }
}

// Metres to US units. Short things get feet and inches (8′ 11.1″), tall things get feet,
// and long horizontal distances get miles once they pass one mile.
export function lengthUS(m: number, vertical: boolean): { value: string; unit: string } {
  const inches = m / 0.0254;
  if (inches < 36) return { value: trim(inches, 1), unit: "in" };
  if (m < 10) {
    let ft = Math.floor(inches / 12);
    let inch = Math.round((inches - ft * 12) * 10) / 10;
    if (inch >= 12) { ft += 1; inch = 0; }
    return { value: `${ft}′ ${trim(inch, 1)}″`, unit: "" };
  }
  if (vertical || m < 3 * MI) return { value: trim(m / FT, 0), unit: "ft" };
  return { value: trim(m / MI, m / MI >= 1000 ? 0 : 1), unit: "miles" };
}

// Metric display, shown as the second line on record pages.
export function formatMetric(r: Pick<RecordRow, "value_numeric" | "value_text" | "unit">): { value: string; unit: string } {
  if (r.unit === "years") {
    const whole = r.value_text?.match(/^\d+/)?.[0] ?? (r.value_numeric != null ? String(Math.floor(r.value_numeric)) : "");
    return { value: whole, unit: "years" };
  }
  const n = r.value_numeric == null ? null : Number(r.value_numeric);
  if (n == null || Number.isNaN(n)) return { value: r.value_text ?? "", unit: r.unit ?? "" };
  // The leading number in value_text keeps meaningful zeros, like "2.10 m" or "47.60 s".
  const lead = r.value_text?.match(/^[−-]?[\d,]+(\.\d+)?/)?.[0];
  switch (r.unit) {
    case "s":
      // Under a minute: "9.58 s". A minute or more: "1:40.91" or "1:59:30", with no unit.
      if (n < 60) return { value: lead ?? n.toFixed(2), unit: "s" };
      return { value: r.value_text?.replace(/\s*s$/, "") ?? clock(n), unit: "" };
    case "m":
      if (n < 1) return { value: trim(n * 100, 1), unit: "cm" };
      if (n >= 10000) return { value: trim(n / 1000, 2), unit: "km" };
      return { value: lead && /\sm\b/.test(r.value_text ?? "") ? lead : trim(n, 2), unit: "m" };
    case "m2":
      return { value: trim(n, 0), unit: "m²" };
    case "m3":
      return { value: trim(n, 0), unit: "m³" };
    case "km2":
      if (n >= 1_000_000) return { value: trim(n / 1_000_000, 2), unit: "million km²" };
      return { value: trim(n, 0), unit: "km²" };
    case "kg":
      if (n >= 1000) return { value: trim(n / 1000, 1), unit: "tonnes" };
      return { value: trim(n, 1), unit: "kg" };
    case "km/h":
      return { value: trim(n, n >= 1000 ? 0 : 1), unit: "km/h" };
    case "days":
      return { value: trim(Math.floor(n), 0), unit: "days" };
    case "°C":
      return { value: trim(n, 1).replace("-", "−"), unit: "°C" };
    case "avg":
      // Batting average, written the baseball way: .372
      return { value: n.toFixed(3).replace(/^0/, ""), unit: "" };
    case "USD":
      if (n >= 1e12) return { value: "$" + trim(n / 1e12, 2), unit: "trillion" };
      if (n >= 1e9) return { value: "$" + trim(n / 1e9, 2), unit: "billion" };
      if (n >= 1e6) return { value: "$" + trim(n / 1e6, 0), unit: "million" };
      return { value: "$" + trim(n, 0), unit: "" };
    case "magnitude":
      return { value: trim(n, 1), unit: "magnitude" };
    case "VEI":
      return { value: trim(n, 0), unit: "on the VEI scale" };
    default: {
      // Counts. Large ones read as "5.62 billion streams" so they fit on the board.
      const u = r.unit ?? "";
      if (n >= 1e9) return { value: trim(n / 1e9, 2), unit: `billion ${u}`.trim() };
      if (n >= 1e6) return { value: trim(n / 1e6, n / 1e6 >= 100 ? 0 : 1), unit: `million ${u}`.trim() };
      return { value: trim(n, 2), unit: u };
    }
  }
}

function clock(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = s.toFixed(2).padStart(5, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// Full detail line, for example "122 years, 164 days" or "8 ft 11.1 in".
export function valueDetail(r: RecordRow): string | null {
  return r.value_text ?? null;
}

function trim(n: number, digits = 2): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? iso + "T00:00:00Z" : iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export function cacheFor(seconds: number, response: { headers: Headers }) {
  response.headers.set("Cache-Control", `public, max-age=300, s-maxage=${seconds}`);
}
