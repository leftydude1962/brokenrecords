// Copied from the site (src/lib/data.ts) so posts show the same US units as the website.
export type Rec = { value_numeric: number | null; value_text: string | null; unit: string | null };

// US display. This is the main value on every page. The database stays metric because sources publish
// in metric; conversion happens only here. Heights and depths read in feet, distances in miles.
type Displayable = Rec & { title?: string };
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
export function formatMetric(r: Rec): { value: string; unit: string } {
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


function trim(n: number, digits = 2): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

