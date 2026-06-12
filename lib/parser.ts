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

export function isContactOverlay(href: string): boolean {
  return /\/overlay\/contact-info/.test(href);
}

export function contactOverlayUrl(slug: string): string {
  return `https://www.linkedin.com/in/${encodeURIComponent(
    slug,
  )}/overlay/contact-info/`;
}

export type ContactInfo = {
  email: string | null;
  phone: string | null;
  websites: string[];
  twitter: string | null;
};

/**
 * Harvest the "Contact info" overlay. Reads semantic hrefs (mailto:, tel:)
 * and the modal's links/text, so it survives class-name churn.
 */
export function parseContactInfo(): ContactInfo | null {
  const modal =
    document.querySelector(
      '.artdeco-modal, [role="dialog"], section.pv-contact-info',
    ) ?? null;
  if (!modal && !isContactOverlay(location.href)) return null;
  const scope: ParentNode = modal ?? document.body;

  const email =
    scope
      .querySelector('a[href^="mailto:"]')
      ?.getAttribute("href")
      ?.replace(/^mailto:/, "")
      .split("?")[0]
      .trim() || null;

  let phone =
    scope
      .querySelector('a[href^="tel:"]')
      ?.getAttribute("href")
      ?.replace(/^tel:/, "")
      .trim() || null;
  if (!phone) {
    const text = (modal as HTMLElement | null)?.innerText ?? "";
    const m = text.match(/(\+?\d[\d\s().-]{7,}\d)/);
    if (m && /phone/i.test(text)) phone = m[1].trim();
  }

  const websites = [...scope.querySelectorAll('a[href^="http"]')]
    .map((a) => (a as HTMLAnchorElement).href)
    .filter(
      (h) =>
        !/linkedin\.com|licdn\.com/.test(h) && !h.startsWith("mailto:"),
    );
  const uniqueSites = [...new Set(websites)];

  const twitter =
    uniqueSites.find((w) => /twitter\.com|x\.com/.test(w)) ?? null;

  if (!email && !phone && uniqueSites.length === 0) return null;
  return {
    email,
    phone,
    websites: uniqueSites.filter((w) => w !== twitter),
    twitter,
  };
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

/** Locate the Experience card regardless of LinkedIn's class shuffle. */
function findExperienceSection(): Element | null {
  const anchor = document.getElementById("experience");
  if (anchor) {
    let el: Element | null = anchor;
    while (el && el !== document.body) {
      if (el.tagName === "SECTION") return el;
      if (el.classList?.contains("artdeco-card") && el.querySelector("ul"))
        return el;
      el = el.parentElement;
    }
    if (anchor.parentElement?.querySelector("ul")) return anchor.parentElement;
  }
  for (const h2 of document.querySelectorAll("h2")) {
    if (/^experience$/i.test(h2.textContent?.trim() ?? "")) {
      const sec =
        h2.closest("section") ??
        h2.closest('[class*="artdeco-card"]') ??
        h2.parentElement;
      if (sec?.querySelector("ul")) return sec;
    }
  }
  return null;
}

function liSpans(li: Element): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const span of li.querySelectorAll('span[aria-hidden="true"]')) {
    const t = span.textContent?.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function entryFromSpans(
  spans: string[],
  overrideCompany: string,
): Position | null {
  if (!spans.length) return null;
  const title = spans[0];
  if (!title) return null;
  const company =
    overrideCompany || (spans[1] ?? "").split("·")[0].trim();
  const startIdx = overrideCompany ? 1 : 2;
  const dateText =
    spans.slice(startIdx).find((s) => /\d{4}|present/i.test(s)) ?? "";
  return {
    title,
    company,
    start: dateText.split(/[-–]/)[0]?.trim() || undefined,
    end: undefined,
    current: /present/i.test(dateText),
  };
}

/** Scrape the visible Experience list (covers SPA-navigated pages). */
function scrapeExperienceDom(): Position[] {
  const container = findExperienceSection();
  if (!container) return [];
  const ul = container.querySelector(
    'ul.pvs-list, ul[class*="pvs-list"], ul',
  );
  if (!ul) return [];

  const entries: Position[] = [];
  for (const li of ul.children) {
    if (li.tagName !== "LI") continue;
    // Grouped entry: several roles at one company via a nested list.
    const subUl = li.querySelector('ul.pvs-list, ul[class*="pvs-list"]');
    if (subUl && subUl.children.length > 0) {
      const company = liSpans(li)[0] ?? "";
      for (const subLi of subUl.children) {
        if (subLi.tagName !== "LI") continue;
        const e = entryFromSpans(liSpans(subLi), company);
        if (e) entries.push(e);
      }
    } else {
      const e = entryFromSpans(liSpans(li), "");
      if (e) entries.push(e);
    }
  }
  return entries;
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

  // Best source: the Experience section itself.
  const positions = scrapeExperienceDom();
  const primary = positions.find((p) => p.current) ?? positions[0] ?? null;
  let role: string | null = primary?.title ?? null;
  let company: string | null = primary?.company || null;

  // Headline heuristic only when the experience list is not on screen yet.
  if (!role && headline) {
    const m = headline.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[|,·]|$)/i);
    if (m) {
      role = m[1].trim();
      company = company ?? m[2].trim();
    } else {
      role = headline.split(/[|·]/)[0].trim();
    }
  }

  let city =
    firstText(
      ".text-body-small.inline.t-black--light.break-words",
      '[data-field="location"]',
      ".pv-text-details__left-panel span[class*='t-black--light']",
      "main section span[class*='t-black--light']",
    ) || null;
  if (!city) {
    for (const s of document.querySelectorAll(
      'script[type="application/ld+json"]',
    )) {
      try {
        const d = JSON.parse(s.textContent ?? "");
        const graph = Array.isArray(d?.["@graph"]) ? d["@graph"] : [d];
        for (const node of graph) {
          const loc =
            node?.address?.addressLocality ??
            node?.homeLocation?.address?.addressLocality;
          if (loc) {
            city = String(loc);
            break;
          }
        }
        if (city) break;
      } catch {
        // not JSON-LD we understand
      }
    }
  }

  return {
    linkedinUrl: cleanUrl(location.href),
    name,
    role,
    company,
    city,
    headline: headline || null,
    relationship: domRelationship(),
    payload: { parser: "dom@2", positions },
  };
}

/** Embedded JSON when it matches the profile on screen, DOM otherwise. */
export function parseProfile(): ParsedProfile | null {
  const slug = profileSlug(location.href);
  if (!slug) return null;
  return parseEmbedded(slug) ?? parseDom();
}
