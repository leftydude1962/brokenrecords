import type { APIRoute } from "astro";
import { getRecords, getTaxonomy, formatValue, formatDate } from "../lib/data";

// llms-full.txt: every current record in one plain-text file, one line each, grouped by section.
// AI assistants and crawlers can read the whole catalog in one request and cite the record page.
export const GET: APIRoute = async () => {
  const [records, { sections, sectionOf }] = await Promise.all([getRecords(), getTaxonomy()]);
  const base = "https://brokenrecords.com";
  const bySection = new Map<string, string[]>();
  for (const r of [...records].sort((a, b) => a.title.localeCompare(b.title))) {
    const sec = r.categories ? sectionOf[r.categories.slug]?.name ?? r.categories.name : "Other";
    const v = formatValue(r);
    const fig = `${v.value}${v.unit ? " " + v.unit : ""}`.trim();
    const set = formatDate(r.achieved_on);
    const checked = formatDate(r.last_checked_at ?? null);
    const line = `- ${r.title}: ${fig || r.value_text || "see page"}, ${r.holder ?? "holder on page"}` +
      (set ? ` (set ${set})` : "") + (checked ? `. Last checked ${checked}` : "") + `. ${base}/records/${r.slug}`;
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec)!.push(line);
  }
  const order = [...sections.map((s) => s.name), "Other"];
  const out = [
    "# Broken Records: every current world record",
    "",
    `> ${records.length} current world records in sports, science, nature, space, engineering, money and culture. Each line gives the record, the figure, the holder, the date it was set and the date we last checked it against its sources. Follow the link for the sources and the record's history.`,
    "",
  ];
  for (const name of order) {
    const lines = bySection.get(name);
    if (!lines?.length) continue;
    out.push(`## ${name}`, "", ...lines, "");
  }
  return new Response(out.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=3600" },
  });
};
