/**
 * "Log a conversation": a framework-free form to file a pasted chat (WhatsApp,
 * Gmail, anywhere) against a CRM contact via the Scout API. Mounted both inline
 * in the popup (compact) and on the dedicated full page. Reads the API key/URL
 * from storage.sync (same place as the options page) and posts the paste to
 * `/api/outreach/paste`, which summarizes it and files it on the contact's
 * outreach timeline. The raw paste is never stored.
 */

type ContactHit = {
  id: string;
  name: string;
  company: string | null;
  role: string | null;
};

const CHANNELS: { value: string; label: string }[] = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "email", label: "Email / Gmail" },
  { value: "linkedin_dm", label: "LinkedIn DM" },
  { value: "call", label: "Call" },
  { value: "in_person", label: "In person" },
  { value: "intro_ask", label: "Intro ask" },
  { value: "other", label: "Other" },
];

const STYLE = `
  .lc { color: #f0ebdf; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .lc * { box-sizing: border-box; }
  .lc-label { display: block; margin-top: 12px; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: #867e70; }
  .lc input, .lc select, .lc textarea {
    width: 100%; margin-top: 4px; padding: 8px 10px;
    border: 1px solid #2b2823; border-radius: 6px; background: #181511;
    color: #f0ebdf; font-size: 13px; font-family: inherit;
  }
  .lc input:focus, .lc select:focus, .lc textarea:focus { outline: none; border-color: #f0ebdf; }
  .lc textarea { resize: vertical; min-height: 84px; }
  .lc-compact textarea { min-height: 60px; }
  .lc-contact { position: relative; }
  .lc-results {
    position: absolute; left: 0; right: 0; top: 100%; z-index: 5;
    background: #181511; border: 1px solid #2b2823; border-radius: 6px;
    margin-top: 2px; max-height: 180px; overflow-y: auto;
  }
  .lc-results:empty { display: none; }
  .lc-hit {
    display: block; width: 100%; text-align: left; padding: 7px 10px;
    background: none; border: 0; border-bottom: 1px solid #2b2823;
    color: #f0ebdf; font: inherit; font-size: 12.5px; cursor: pointer;
  }
  .lc-hit:last-child { border-bottom: 0; }
  .lc-hit:hover { background: #221e18; }
  .lc-hit .sub { color: #867e70; }
  .lc-selected {
    display: none; align-items: center; gap: 8px; margin-top: 6px;
    padding: 7px 10px; border: 1px solid #1d3fbf; border-radius: 6px; background: #141726;
  }
  .lc-selected.on { display: flex; }
  .lc-selected .x { margin-left: auto; background: none; border: 0; color: #867e70; cursor: pointer; font-size: 14px; }
  .lc-newtoggle {
    margin-top: 6px; padding: 0; background: none; border: 0;
    color: #8ba3f5; font: inherit; font-size: 12px; cursor: pointer; text-decoration: underline;
  }
  .lc-new { display: none; }
  .lc-new.on { display: block; }
  .lc-submit {
    width: 100%; margin-top: 14px; padding: 10px; border: none; border-radius: 6px;
    background: #f0ebdf; color: #0e0d0b; font-weight: 600; font-size: 13px; font-family: inherit; cursor: pointer;
  }
  .lc-submit:disabled { opacity: 0.5; cursor: default; }
  .lc-status { margin-top: 8px; font-size: 12px; min-height: 15px; color: #867e70; }
  .lc-status.ok { color: #6fbf73; }
  .lc-status.err { color: #e0705a; }
`;

async function creds(): Promise<{ base: string; key: string | null }> {
  const { apiUrl, apiKey } = await browser.storage.sync.get([
    "apiUrl",
    "apiKey",
  ]);
  return {
    base: (apiUrl as string) || "https://stacksquare.ai",
    key: (apiKey as string) || null,
  };
}

/** Make a bare handle/URL into a proper URL so the server's zod accepts it. */
function normUrl(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

export function mountLogConversation(
  root: HTMLElement,
  opts: { compact?: boolean } = {},
) {
  if (!document.getElementById("lc-style")) {
    const s = document.createElement("style");
    s.id = "lc-style";
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  root.className = "lc" + (opts.compact ? " lc-compact" : "");
  root.innerHTML = `
    <label class="lc-label">Contact</label>
    <div class="lc-contact">
      <input class="lc-search" type="text" placeholder="Search a contact by name, company, email" autocomplete="off" />
      <div class="lc-results"></div>
    </div>
    <div class="lc-selected"><span class="who"></span><button class="x" type="button" title="Clear">✕</button></div>
    <button class="lc-newtoggle" type="button">+ New contact</button>
    <div class="lc-new">
      <input class="lc-name" type="text" placeholder="Full name *" />
      <input class="lc-company" type="text" placeholder="Company" />
      <input class="lc-linkedin" type="text" placeholder="LinkedIn URL" />
      <input class="lc-email" type="email" placeholder="Email" />
    </div>
    <label class="lc-label">Platform</label>
    <select class="lc-channel">
      ${CHANNELS.map((c) => `<option value="${c.value}">${c.label}</option>`).join("")}
    </select>
    <label class="lc-label">Conversation</label>
    <textarea class="lc-text" rows="${opts.compact ? 3 : 8}" placeholder="Paste the whole conversation. It is summarized by AI; the raw text is discarded."></textarea>
    <button class="lc-submit" type="button">Log it</button>
    <div class="lc-status"></div>
  `;

  const $ = <T extends HTMLElement>(sel: string) =>
    root.querySelector(sel) as T;
  const search = $<HTMLInputElement>(".lc-search");
  const results = $<HTMLDivElement>(".lc-results");
  const selectedBox = $<HTMLDivElement>(".lc-selected");
  const selectedWho = $<HTMLSpanElement>(".lc-selected .who");
  const newToggle = $<HTMLButtonElement>(".lc-newtoggle");
  const newBox = $<HTMLDivElement>(".lc-new");
  const nameEl = $<HTMLInputElement>(".lc-name");
  const companyEl = $<HTMLInputElement>(".lc-company");
  const linkedinEl = $<HTMLInputElement>(".lc-linkedin");
  const emailEl = $<HTMLInputElement>(".lc-email");
  const channelEl = $<HTMLSelectElement>(".lc-channel");
  const textEl = $<HTMLTextAreaElement>(".lc-text");
  const submit = $<HTMLButtonElement>(".lc-submit");
  const status = $<HTMLDivElement>(".lc-status");

  let selected: ContactHit | null = null;
  let mode: "search" | "new" = "search";
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  function setStatus(text: string, kind: "ok" | "err" | "") {
    status.textContent = text;
    status.className = `lc-status ${kind}`;
  }

  function setMode(m: "search" | "new") {
    mode = m;
    newBox.classList.toggle("on", m === "new");
    newToggle.textContent = m === "new" ? "Search existing instead" : "+ New contact";
    if (m === "new") clearSelected();
  }

  function selectContact(hit: ContactHit) {
    selected = hit;
    selectedWho.textContent =
      hit.name + (hit.company ? ` · ${hit.company}` : "");
    selectedBox.classList.add("on");
    results.innerHTML = "";
    search.value = "";
    setStatus("", "");
  }

  function clearSelected() {
    selected = null;
    selectedBox.classList.remove("on");
  }

  selectedBox.querySelector(".x")!.addEventListener("click", clearSelected);

  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = search.value.trim();
    if (q.length < 2) {
      results.innerHTML = "";
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 250);
  });

  async function runSearch(q: string) {
    const { base, key } = await creds();
    if (!key) {
      setStatus("No API key set. Open Scout options.", "err");
      return;
    }
    try {
      const res = await fetch(
        `${base}/api/contacts/search?q=${encodeURIComponent(q)}`,
        { headers: { "X-API-Key": key } },
      );
      if (!res.ok) {
        setStatus(`Search failed (HTTP ${res.status})`, "err");
        return;
      }
      const data = (await res.json()) as { contacts?: ContactHit[] };
      renderResults(data.contacts ?? []);
    } catch {
      setStatus("Search failed (network)", "err");
    }
  }

  function renderResults(hits: ContactHit[]) {
    results.innerHTML = "";
    if (!hits.length) {
      const empty = document.createElement("div");
      empty.className = "lc-hit sub";
      empty.textContent = "No matches. Use + New contact.";
      results.appendChild(empty);
      return;
    }
    for (const h of hits) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "lc-hit";
      row.innerHTML = `${escapeHtml(h.name)}${h.company || h.role ? ` <span class="sub">· ${escapeHtml([h.role, h.company].filter(Boolean).join(", "))}</span>` : ""}`;
      row.addEventListener("click", () => selectContact(h));
      results.appendChild(row);
    }
  }

  newToggle.addEventListener("click", () =>
    setMode(mode === "new" ? "search" : "new"),
  );

  submit.addEventListener("click", onSubmit);

  async function onSubmit() {
    const text = textEl.value.trim();
    if (!text) {
      setStatus("Paste the conversation first.", "err");
      return;
    }
    const payload: Record<string, unknown> = {
      channel: channelEl.value,
      text,
    };
    if (mode === "new") {
      const name = nameEl.value.trim();
      if (!name) {
        setStatus("New contact needs a name.", "err");
        return;
      }
      payload.newContact = {
        name,
        company: companyEl.value.trim() || null,
        linkedinUrl: normUrl(linkedinEl.value),
        email: emailEl.value.trim() || null,
      };
    } else {
      if (!selected) {
        setStatus("Pick a contact or add a new one.", "err");
        return;
      }
      payload.contactId = selected.id;
    }

    const { base, key } = await creds();
    if (!key) {
      setStatus("No API key set. Open Scout options.", "err");
      return;
    }

    submit.disabled = true;
    setStatus("Summarizing and logging…", "");
    try {
      const res = await fetch(`${base}/api/outreach/paste`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": key },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(data.error ?? `HTTP ${res.status}`, "err");
        submit.disabled = false;
        return;
      }
      setStatus(
        `Queued for review → ${data.contactName ?? "contact"}${data.created ? " (new contact)" : ""}. Accept it in the Scout queue.`,
        "ok",
      );
      // Ready for the next log: clear the paste + new-contact fields, keep the
      // selected contact and platform so consecutive logs are quick.
      textEl.value = "";
      nameEl.value = companyEl.value = linkedinEl.value = emailEl.value = "";
      submit.disabled = false;
    } catch {
      setStatus("Network error. Check your connection.", "err");
      submit.disabled = false;
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
