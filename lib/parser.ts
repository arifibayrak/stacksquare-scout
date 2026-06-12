/**
 * Profile extraction. Engine: harvest the Voyager JSON LinkedIn embeds in
 * <code> blocks of the initially loaded page (zero extra requests).
 * Fallback: a slim DOM scrape for SPA-navigated profiles, where the
 * embedded blocks belong to a previous page.
 */

export type Position = {
  title: string;
  company: string;
  start?: string;
  end?: string;
  current: boolean;
};

export type ParsedProfile = {
  linkedinUrl: string;
  name: string;
  role: string | null;
  company: string | null;
  city: string | null;
  headline: string | null;
  relationship: "warm_1st" | "warm_2nd" | "cold" | null;
  payload: Record<string, unknown>;
};

export function profileSlug(href: string): string | null {
  const m = href.match(/linkedin\.com\/in\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function cleanUrl(href: string): string {
  return href.split("?")[0].split("#")[0].replace(/\/$/, "");
}

type Entity = Record<string, any>;

/** Collect every entity from every embedded JSON block on the page. */
function collectEntities(): Entity[] {
  const out: Entity[] = [];
  for (const code of document.querySelectorAll("code")) {
    const text = code.textContent;
    if (!text || text.length < 50 || !text.includes("included")) continue;
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json?.included)) out.push(...json.included);
    } catch {
      // not JSON, skip
    }
  }
  return out;
}

function dateStr(d: any): string | undefined {
  if (!d?.year) return undefined;
  return d.month ? `${d.year}-${String(d.month).padStart(2, "0")}` : `${d.year}`;
}

/** Try to build the profile from embedded Voyager JSON. */
export function parseEmbedded(slug: string): ParsedProfile | null {
  const entities = collectEntities();
  if (!entities.length) return null;

  const profile = entities.find(
    (e) =>
      typeof e?.publicIdentifier === "string" &&
      e.publicIdentifier.toLowerCase() === slug.toLowerCase() &&
      (e.firstName || e.lastName),
  );
  if (!profile) return null;

  const name = [profile.firstName, profile.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!name) return null;

  const profileId: string = profile.entityUrn ?? "";
  const idTail = profileId.split(":").pop() ?? "###none###";

  // Geo entity referenced by the profile.
  let city: string | null = null;
  const geoUrn = profile.geoLocation?.["*geo"] ?? profile.geoLocation?.geoUrn;
  if (geoUrn) {
    const geo = entities.find((e) => e.entityUrn === geoUrn);
    city = geo?.defaultLocalizedName ?? null;
  }

  // Positions owned by this profile (their URNs embed the profile id).
  const positions: Position[] = entities
    .filter(
      (e) =>
        typeof e?.entityUrn === "string" &&
        e.entityUrn.includes("fsd_profilePosition") &&
        e.entityUrn.includes(idTail) &&
        e.title,
    )
    .map((e) => ({
      title: String(e.title),
      company: String(e.companyName ?? ""),
      start: dateStr(e.dateRange?.start),
      end: dateStr(e.dateRange?.end),
      current: Boolean(e.dateRange?.start) && !e.dateRange?.end,
    }));

  positions.sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""));
  const primary = positions.find((p) => p.current) ?? positions[0] ?? null;

  const educations = entities
    .filter(
      (e) =>
        typeof e?.entityUrn === "string" &&
        e.entityUrn.includes("fsd_profileEducation") &&
        e.entityUrn.includes(idTail),
    )
    .map((e) => ({
      school: e.schoolName ?? null,
      degree: e.degreeName ?? null,
      field: e.fieldOfStudy ?? null,
    }));

  return {
    linkedinUrl: cleanUrl(location.href),
    name,
    role: primary?.title ?? null,
    company: primary?.company ?? null,
    city,
    headline: profile.headline ?? null,
    relationship: domRelationship(),
    payload: {
      parser: "embedded@1",
      publicIdentifier: profile.publicIdentifier,
      positions,
      educations,
    },
  };
}

/** Relationship degree only renders in the DOM. */
function domRelationship(): ParsedProfile["relationship"] {
  const deg =
    document
      .querySelector('.dist-value, [class*="dist-value"]')
      ?.textContent?.trim() ?? "";
  if (deg.startsWith("1")) return "warm_1st";
  if (deg.startsWith("2")) return "warm_2nd";
  return deg ? "cold" : null;
}

function firstText(...selectors: string[]): string {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const t = el?.textContent?.trim();
    if (t) return t;
  }
  return "";
}

/** Slim DOM fallback for SPA-navigated profiles. */
export function parseDom(): ParsedProfile | null {
  let name = firstText(
    "h1.text-heading-xlarge",
    'h1[class*="heading-xlarge"]',
    "main h1",
    "h1",
  );
  if (!name) {
    const m = document.title.match(/^\(?\d*\)?\s*(.+?)\s*[|\-–]\s*LinkedIn/i);
    if (m) name = m[1].trim();
  }
  if (!name) return null;

  const headline = firstText(
    ".text-body-medium.break-words",
    '[data-field="headline"]',
    'div[class*="text-body-medium"]',
  );

  let role: string | null = null;
  let company: string | null = null;
  if (headline) {
    const m = headline.match(/^(.+?)\s+at\s+(.+?)(?:\s*[|,]|$)/i);
    if (m) {
      role = m[1].trim();
      company = m[2].trim();
    } else {
      role = headline.split("|")[0].trim();
    }
  }

  const city =
    firstText(
      ".text-body-small.inline.t-black--light.break-words",
      '[data-field="location"]',
      'span[class*="t-black--light"]',
    ) || null;

  return {
    linkedinUrl: cleanUrl(location.href),
    name,
    role,
    company,
    city,
    headline: headline || null,
    relationship: domRelationship(),
    payload: { parser: "dom@1" },
  };
}

/** Embedded JSON when it matches the profile on screen, DOM otherwise. */
export function parseProfile(): ParsedProfile | null {
  const slug = profileSlug(location.href);
  if (!slug) return null;
  return parseEmbedded(slug) ?? parseDom();
}
