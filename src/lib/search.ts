// Record search. Pure functions only, so the same code runs in the browser (header box)
// and on the server (/search page). No imports from data.ts here.

/** One entry in /search-index.json. Short keys keep the file small. */
export type IndexItem = {
  s: string; // slug
  t: string; // title
  h: string; // holder
  c: string; // category name
  v: string; // figure as shown, e.g. "3:42.66"
};

// Words people type that don't help find a record.
const SKIP = new Set(["world", "record", "records", "wr", "the", "a", "an", "of", "in", "on", "for", "by", "is", "what", "who", "whats", "ever"]);

// Words that mean the same thing in a record title. "fastest man" should find "Men's ...".
const SAME: Record<string, string[]> = {
  man: ["men", "human"], male: ["men"], guy: ["men"], person: ["human", "people"],
  woman: ["women"], female: ["women"], lady: ["women"],
  biggest: ["largest", "heaviest", "tallest"], largest: ["biggest", "heaviest"], heaviest: ["largest", "biggest"],
  highest: ["tallest"], tallest: ["highest"], quickest: ["fastest"], fastest: ["quickest"],
  smallest: ["shortest", "lightest"], shortest: ["smallest"],
  oldest: ["longest lived"], richest: ["wealthiest"],
  football: ["nfl"], nfl: ["football"], soccer: ["fifa", "football"], baseball: ["mlb"], mlb: ["baseball"],
  basketball: ["nba"], nba: ["basketball"], hockey: ["nhl"], nhl: ["hockey"],
};

// Superlatives help rank results but don't rule a record out: "fastest man" still finds
// "Men's 100 m", whose title doesn't say "fastest".
const SOFT = new Set(["fastest", "quickest", "biggest", "largest", "heaviest", "tallest", "highest", "longest", "oldest", "youngest", "smallest", "shortest", "most", "best", "greatest", "deepest", "richest", "strongest"]);

export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents: "Pelé" -> "pele"
    .replace(/['’]/g, "") // "Rubik's" -> "rubiks"
    .replace(/(\d)([a-z])/g, "$1 $2") // "100m" -> "100 m", to match titles like "Men's 100 m"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokens(q: string): string[] {
  return norm(q).split(" ").filter((w) => w && !SKIP.has(w));
}

// True when some word in `text` starts with `tok` ("goal" matches "goals").
// A plural query word also matches the singular ("pumpkins" finds "pumpkin").
function hasWord(text: string, tok: string): boolean {
  const padded = " " + text;
  if (padded.includes(" " + tok)) return true;
  if (tok.length > 3 && tok.endsWith("s") && padded.includes(" " + tok.slice(0, -1))) return true;
  return false;
}

/** Records matching every search word, best first. */
export function search(items: IndexItem[], q: string, limit = 50): IndexItem[] {
  const toks = tokens(q);
  if (!toks.length) return [];
  const whole = toks.join(" ");
  // If every word is a superlative ("biggest"), treat them all as required.
  const allSoft = toks.every((t) => SOFT.has(t));
  const scored: { it: IndexItem; score: number }[] = [];
  for (const it of items) {
    const t = norm(it.t), h = norm(it.h), c = norm(it.c);
    let score = 0;
    let ok = true;
    for (const tok of toks) {
      const forms = [tok, ...(SAME[tok] ?? [])];
      const inT = forms.some((f) => hasWord(t, f));
      if (inT) score += forms.some((f) => f === tok && hasWord(t, f)) ? 3 : 2;
      else if (forms.some((f) => hasWord(h, f))) score += 2;
      else if (forms.some((f) => hasWord(c, f))) score += 1;
      else if (SOFT.has(tok) && !allSoft) continue; // optional word, not found
      else { ok = false; break; }
    }
    if (!ok || score === 0) continue;
    if (t.startsWith(whole)) score += 5;
    else if (t.includes(whole)) score += 2;
    scored.push({ it, score });
  }
  scored.sort((a, b) => b.score - a.score || a.it.t.length - b.it.t.length);
  return scored.slice(0, limit).map((x) => x.it);
}
