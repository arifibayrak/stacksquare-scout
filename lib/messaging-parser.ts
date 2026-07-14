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

/** Counterpart name + profile link from the open thread's header. */
function readCounterpart(): ParsedThread["counterpart"] {
  const name =
    textOf(
      document.querySelector(
        ".msg-thread__link-to-profile .msg-entity-lockup__entity-title, " +
          ".msg-entity-lockup__entity-title, " +
          "#thread-detail-jump-target, " +
          ".msg-thread h2",
      ),
    ) || null;

  const profileLink =
    (document.querySelector(
      "a.msg-thread__link-to-profile, " +
        ".msg-title-bar a[href*='/in/'], " +
        ".msg-thread a[href*='/in/']",
    ) as HTMLAnchorElement | null)?.href ?? null;

  return {
    name,
    linkedinUrl: cleanLinkedin(profileLink),
    headline: null,
  };
}

/** The rendered message bubbles of the open conversation. */
function readMessages(counterpartName: string | null): DmMessage[] {
  const items = Array.from(
    document.querySelectorAll(
      "li.msg-s-message-list__event, .msg-s-message-list__event, .msg-s-event-listitem",
    ),
  );
  const out: DmMessage[] = [];
  let currentSender: string | null = null;
  let currentAt: string | null = null;
  const seen = new Set<string>();

  for (const item of items) {
    // A message group re-declares the sender + timestamp for its first bubble;
    // later bubbles in the group inherit them.
    const nameEl = item.querySelector(".msg-s-message-group__name");
    if (nameEl) currentSender = textOf(nameEl) || currentSender;
    const timeEl = item.querySelector(
      "time.msg-s-message-group__timestamp, .msg-s-message-group__timestamp, time",
    );
    if (timeEl) {
      currentAt =
        (timeEl as HTMLTimeElement).dateTime || textOf(timeEl) || currentAt;
    }

    const bodyEl = item.querySelector(".msg-s-event-listitem__body");
    const text = textOf(bodyEl);
    if (!text) continue;

    // Dedup identical consecutive bodies (virtualized re-reads).
    const key = `${currentSender ?? ""}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const isOther =
      /--other\b/.test(item.className) ||
      (Boolean(counterpartName) && currentSender === counterpartName);

    out.push({
      from: isOther ? "them" : "me",
      at: currentAt,
      text: text.slice(0, 8000),
    });
  }

  return out;
}

/** DOM tier. */
export function parseThreadDom(): ParsedThread | null {
  const conversationId = threadIdFromUrl(location.href);
  if (!conversationId) return null;
  const counterpart = readCounterpart();
  const transcript = readMessages(counterpart.name);
  if (transcript.length === 0) return null;
  return { conversationId, counterpart, transcript, parser: "msg-dom@1" };
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

  const counterpart = readCounterpart();
  // Without a reliable self-urn we cannot classify direction from embedded
  // data alone; fall back to DOM classification if the DOM has the thread.
  const dom = parseThreadDom();
  if (dom && dom.transcript.length >= events.length) return dom;

  const transcript: DmMessage[] = events.map((ev) => ({
    from: "them",
    at: ev.at,
    text: ev.text.slice(0, 8000),
  }));
  return { conversationId, counterpart, transcript, parser: "msg-embedded@1" };
}

/** Embedded when it clearly has the thread, DOM otherwise. */
export function parseThread(): ParsedThread | null {
  return parseThreadDom() ?? parseThreadEmbedded();
}
