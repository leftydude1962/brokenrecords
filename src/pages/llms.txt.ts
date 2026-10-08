import type { APIRoute } from "astro";
import { getCategories } from "../lib/data";

// llms.txt: a plain-text guide for AI assistants and crawlers. Lists the sections and
// categories with live records, so the file stays current without manual edits.
export const GET: APIRoute = async () => {
  const categories = await getCategories();
  const base = "https://brokenrecords.com";
  const sections = categories.filter((c) => !c.parent_id);
  const children = (parent: string) => categories.filter((c) => c.parent_id === parent && (c.count ?? 0) > 0);

  const lines: string[] = [
    "# Broken Records",
    "",
    "> Broken Records is a world records website. It shows the current holder of each record, the figure, the date it was set, and the date we last checked it against its sources. When a record is broken, the page is updated and the old holder is kept as history.",
    "",
    "Each record page gives the current record in one answer, followed by the story, the source list, and a comparison chart where one is useful. Records are drawn from official record bodies, Wikidata, and news reports. Sources are listed on every page.",
    "",
    "## Sections",
    "",
  ];
  for (const s of sections) {
    lines.push(`- [${s.name}](${base}/category/${s.slug})`);
    for (const c of children(s.id)) {
      lines.push(`  - [${c.name}](${base}/category/${c.slug})`);
    }
  }
  lines.push(
    "",
    "## Other pages",
    "",
    `- [All categories](${base}/category)`,
    `- [Privacy policy](${base}/privacy)`,
    `- [Terms of use](${base}/terms)`,
    "",
    "## Contact",
    "",
    "info@brokenrecords.com",
    "",
  );

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
};
