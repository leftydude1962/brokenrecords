// Read-only data access for the public site.
// The URL and publishable key are public by design. Row level security in
// Supabase only lets this key read published records, categories and sources.
export const SUPABASE_URL = "https://ccwmynoumrqpvnmpcgch.supabase.co";
export const SUPABASE_KEY = "sb_publishable_XQGLSf28dqucKBAaV4XC4A_znvwj3Z5";

export type Source = { url: string; publisher: string | null; license: string | null };
export type Category = { id: string; slug: string; name: string; count?: number };
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
  updated_at: string | null;
  categories: { slug: string; name: string } | null;
  record_sources: Source[];
};

const RECORD_SELECT =
  "id,slug,title,holder,value_numeric,value_text,unit,better_direction,achieved_on,location,governing_body,status,last_verified_at,updated_at,categories(slug,name),record_sources(url,publisher,license)";

async function rest<T>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function getCategories(): Promise<Category[]> {
  const rows = await rest<Array<Category & { records: { count: number }[] }>>(
    "categories?select=id,slug,name,records(count)&records.status=eq.published&order=name.asc",
  );
  return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, count: r.records?.[0]?.count ?? 0 }));
}

export async function getCategory(slug: string): Promise<Category | null> {
  const rows = await rest<Category[]>(`categories?select=id,slug,name&slug=eq.${encodeURIComponent(slug)}`);
  return rows[0] ?? null;
}

export async function getRecords(opts: { categoryId?: string; limit?: number } = {}): Promise<RecordRow[]> {
  let q = `records?select=${RECORD_SELECT}&status=eq.published&order=updated_at.desc`;
  if (opts.categoryId) q += `&category_id=eq.${opts.categoryId}`;
  if (opts.limit) q += `&limit=${opts.limit}`;
  return rest<RecordRow[]>(q);
}

export async function getRecord(slug: string): Promise<RecordRow | null> {
  const rows = await rest<RecordRow[]>(
    `records?select=${RECORD_SELECT}&slug=eq.${encodeURIComponent(slug)}&status=in.(published,superseded)`,
  );
  return rows[0] ?? null;
}

// Turns the stored number and unit into what a reader expects to see.
export function formatValue(r: Pick<RecordRow, "value_numeric" | "value_text" | "unit">): { value: string; unit: string } {
  if (r.unit === "years") {
    const whole = r.value_text?.match(/^\d+/)?.[0] ?? (r.value_numeric != null ? String(Math.floor(r.value_numeric)) : "");
    return { value: whole, unit: "years" };
  }
  const n = r.value_numeric;
  if (n == null) return { value: r.value_text ?? "", unit: r.unit ?? "" };
  if (r.unit === "m" && n >= 10000) return { value: trim(n / 1000), unit: "km" };
  return { value: trim(n), unit: r.unit ?? "" };
}

// Full detail line, for example "122 years, 164 days" or "8 ft 11.1 in".
export function valueDetail(r: RecordRow): string | null {
  return r.value_text ?? null;
}

function trim(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? iso + "T00:00:00Z" : iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export function cacheFor(seconds: number, response: { headers: Headers }) {
  response.headers.set("Cache-Control", `public, max-age=300, s-maxage=${seconds}`);
}
