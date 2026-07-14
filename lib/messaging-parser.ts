/**
 * LinkedIn DM thread extraction. Same philosophy as lib/parser.ts: read only
 * what LinkedIn already rendered in the founder's own browser. No LinkedIn API
 * calls, no automated actions (see the stacksquare repo docs/adr/0002 + 0004).
 *
 * Two tiers:
 *  - msg-embedded@1: best-effort scan of embedded Voyager JSON for message
 *    events. Messaging is an XHR-driven SPA, so this is often empty; treated as
 *    a bonus, not the primary path.
 *  - msg-dom@1: read the rendered conversation. The workhorse. Sender
 *    attribution ("me" vs "them") is best-effort; the server summarizer
 *    tolerates a lossy transcript.
 */

export type DmMessage = {
  from: "me" | "them";
  at?: string | null;
  text: string;
};

export type ParsedThread = {
  conversationId: string;
  counterpart: {
    name: string | null;
    linkedinUrl: string | null;
    headline: string | null;
  };
  transcript: DmMessage[];
  parser: string;
};

/** The stable conversation id from a /messaging/thread/<id>/ URL. */
export function threadIdFromUrl(href: string): string | null {
  const m = href.match(/messaging\/thread\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function cleanLinkedin(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = href.match(/linkedin\.com\/in\/([^/?#]+)/);
  if (!m) return null;
  return `https://www.linkedin.com/in/${m[1]}`;
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The logged-in user's own name, the reliable "me" signal. */
function ownName(): string | null {
  const alt =
    document.querySelector(".global-nav__me-photo")?.getAttribute("alt") ||
    document
      .querySelector("img.global-nav__me-photo, .global-nav__me img")
      ?.getAttribute("alt");
  return alt ? alt.trim() : null;
}

/** Counterpart profile link from the thread header (often a member-id URL). */
function counterpartLink(): string | null {
  const a = document.querySelector(
    "a.msg-thread__link-to-profile, " +
      ".msg-title-bar a[href*='/in/'], " +
      ".msg-thread a[href*='/in/'], " +
      ".msg-s-message-group__profile-link",
  ) as HTMLAnchorElement | null;
  return cleanLinkedin(a?.href);
}

/** Fallback counterpart name from the header title, stripped of a11y noise. */
function titleName(): string | null {
  const t = textOf(
    document.querySelector(
      ".msg-entity-lockup__entity-title, #thread-detail-jump-target",
    ),
  );
  if (!t) return null;
  const cut = t
    .split(/\s+Status is (?:offline|online)|\s+Open the options/i)[0]
    .trim();
  return cut || null;
}

type RawDm = DmMessage & { sender: string | null };

/**
 * The rendered message bubbles. Each `.msg-s-event-listitem` div carries a
 * `--other` class for the counterpart's messages; self messages lack it. We
 * iterate ONLY those divs (not the <li> wrappers, which lack the class and
 * would double-count), and fall back to sender-vs-own-name for continuations.
 */
function readMessages(own: string | null): RawDm[] {
  const items = Array.from(document.querySelectorAll(".msg-s-event-listitem"));
  const out: RawDm[] = [];
  let currentSender: string | null = null;
  let currentAt: string | null = null;
  let lastFrom: "me" | "them" = "me";
  const seen = new Set<string>();

  for (const item of items) {
    // A group re-declares sender + timestamp for its first bubble; later
    // bubbles inherit them.
    const nameEl = item.querySelector(".msg-s-message-group__name");
    if (nameEl) currentSender = textOf(nameEl) || currentSender;
    const timeEl = item.querySelector(
      "time.msg-s-message-group__timestamp, .msg-s-message-group__timestamp, time",
    );
    if (timeEl)
      currentAt =
        (timeEl as HTMLTimeElement).dateTime || textOf(timeEl) || currentAt;

    const text = textOf(item.querySelector(".msg-s-event-listitem__body"));
    if (!text) continue;

    const key = `${currentSender ?? ""}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const cls = item.className;
    let from: "me" | "them";
    if (/--other\b/.test(cls)) from = "them";
    else if (/--self\b/.test(cls)) from = "me";
    else if (currentSender && own && currentSender === own) from = "me";
    else if (currentSender && own && currentSender !== own) from = "them";
    else from = lastFrom;
    lastFrom = from;

    out.push({
      from,
      at: currentAt,
      text: text.slice(0, 8000),
      sender: currentSender,
    });
  }

  return out;
}

/** DOM tier. */
export function parseThreadDom(): ParsedThread | null {
  const conversationId = threadIdFromUrl(location.href);
  if (!conversationId) return null;
  const own = ownName();
  const raw = readMessages(own);
  if (raw.length === 0) return null;
  const counterpartName =
    raw.find((m) => m.from === "them")?.sender ?? titleName();
  const transcript: DmMessage[] = raw.map(({ from, at, text }) => ({
    from,
    at,
    text,
  }));
  return {
    conversationId,
    counterpart: {
      name: counterpartName,
      linkedinUrl: counterpartLink(),
      headline: null,
    },
    transcript,
    parser: "msg-dom@1",
  };
}

/**
 * Embedded tier. Best-effort: scan <code> blocks for messaging events. Returns
 * null when the page has not embedded the thread (the common case).
 */
export function parseThreadEmbedded(): ParsedThread | null {
  const conversationId = threadIdFromUrl(location.href);
  if (!conversationId) return null;

  const events: { at: string | null; text: string; senderUrn: string | null }[] =
    [];
  for (const code of document.querySelectorAll("code")) {
    const t = code.textContent;
    if (!t || t.length < 50 || !t.includes("included")) continue;
    let json: unknown;
    try {
      json = JSON.parse(t);
    } catch {
      continue;
    }
    const included = (json as { included?: unknown })?.included;
    if (!Array.isArray(included)) continue;
    for (const e of included) {
      const urn: string = e?.entityUrn ?? "";
      const type: string = e?.$type ?? "";
      const isMsg =
        /msg_message|messaging\.event|messaging\.Message/i.test(urn) ||
        /messaging/i.test(type);
      if (!isMsg) continue;
      const text: string =
        e?.body?.text ??
        e?.attributedBody?.text ??
        e?.messageBodyRenderFormat ??
        "";
      if (!text || typeof text !== "string") continue;
      const at =
        typeof e?.deliveredAt === "number" ? String(e.deliveredAt) : null;
      const senderUrn: string | null =
        e?.["*sender"] ?? e?.sender ?? e?.["*from"] ?? null;
      events.push({ at, text, senderUrn });
    }
  }

  if (events.length === 0) return null;

  // Without a reliable self-urn we cannot classify direction from embedded
  // data alone; prefer DOM classification when the DOM has the thread.
  const dom = parseThreadDom();
  if (dom && dom.transcript.length >= events.length) return dom;

  const transcript: DmMessage[] = events.map((ev) => ({
    from: "them",
    at: ev.at,
    text: ev.text.slice(0, 8000),
  }));
  return {
    conversationId,
    counterpart: {
      name: titleName(),
      linkedinUrl: counterpartLink(),
      headline: null,
    },
    transcript,
    parser: "msg-embedded@1",
  };
}

/** Embedded when it clearly has the thread, DOM otherwise. */
export function parseThread(): ParsedThread | null {
  return parseThreadDom() ?? parseThreadEmbedded();
}
