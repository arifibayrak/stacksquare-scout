/**
 * The Scout panel: a drawer docked to the right edge of LinkedIn profile
 * pages showing the auto-scraped values, with manual fields (email, phone,
 * seniority) and a send button. Auto-scraped fields refresh on navigation;
 * anything the user typed is never overwritten.
 */
import type { ParsedProfile } from "./parser";

const HOST_ID = "ss-scout-host";

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .tab {
    position: fixed; right: 0; top: 40%; z-index: 1000000;
    writing-mode: vertical-rl; padding: 12px 6px;
    background: #0e0d0b; color: #f0ebdf; font-size: 11px; letter-spacing: 0.14em;
    border: 1px solid #2b2823; border-right: none; border-radius: 8px 0 0 8px;
    cursor: pointer; user-select: none;
    transition: right 0.25s ease;
  }
  .tab.open { right: 300px; border-right: 1px solid #2b2823; border-radius: 8px 0 0 8px; }
  .tab .dot { display: inline-block; width: 7px; height: 7px; border-radius: 2px; background: #1d3fbf; margin-bottom: 6px; }
  .panel {
    position: fixed; right: 0; top: 64px; bottom: 16px; width: 300px; z-index: 999999;
    background: #0e0d0b; color: #f0ebdf; border: 1px solid #2b2823; border-right: none;
    border-radius: 10px 0 0 10px; display: flex; flex-direction: column;
    box-shadow: -24px 0 60px rgba(0,0,0,0.5);
  }
  .head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #2b2823; }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; }
  .mark { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; width: 14px; height: 14px; }
  .mark span { background: #f0ebdf; border-radius: 2px; }
  .mark span:last-child { background: #1d3fbf; }
  .close { background: none; border: none; color: #867e70; font-size: 14px; cursor: pointer; }
  .body { flex: 1; overflow-y: auto; padding: 12px 14px; }
  label { display: block; margin-top: 10px; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: #867e70; }
  label:first-child { margin-top: 0; }
  .listlabel { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .listlabel select { flex: 1 1 100%; margin-top: 4px; }
  .listlabel .refresh {
    margin: 0 0 0 auto; padding: 0; width: 20px; height: 18px; line-height: 1;
    border: 1px solid #2b2823; border-radius: 4px; background: #181511;
    color: #867e70; font-size: 12px; cursor: pointer;
  }
  .listlabel .refresh:hover { color: #f0ebdf; border-color: #f0ebdf; }
  input, select {
    width: 100%; margin-top: 4px; padding: 7px 9px;
    border: 1px solid #2b2823; border-radius: 6px; background: #181511;
    color: #f0ebdf; font-size: 12.5px; font-family: inherit;
  }
  input:focus, select:focus { outline: none; border-color: #f0ebdf; }
  .foot { padding: 12px 14px; border-top: 1px solid #2b2823; }
  .scan {
    width: 100%; padding: 9px; margin-bottom: 8px; border: 1px solid #1d3fbf; border-radius: 6px;
    cursor: pointer; background: #181511; color: #8ba3f5; font-weight: 600; font-size: 13px; font-family: inherit;
  }
  .scan:disabled { opacity: 0.5; }
  .send {
    width: 100%; padding: 10px; border: none; border-radius: 6px; cursor: pointer;
    background: #f0ebdf; color: #0e0d0b; font-weight: 600; font-size: 13px; font-family: inherit;
  }
  .send:disabled { opacity: 0.5; }
  .status { margin-top: 8px; font-size: 11px; min-height: 14px; color: #867e70; }
  .status.ok { color: #6fbf73; }
  .status.err { color: #e0705a; }
`;

const FIELDS = [
  ["name", "Name *", "text"],
  ["role", "Role", "text"],
  ["company", "Company", "text"],
  ["city", "City", "text"],
  ["linkedinUrl", "LinkedIn URL", "text"],
  ["email", "Email", "email"],
  ["phone", "Phone", "tel"],
] as const;

export type PanelSend = (values: Record<string, string>) => Promise<{
  ok: boolean;
  error?: string;
  destination?: "queue" | "segment";
  segment?: { name?: string };
  linked?: boolean;
}>;

export type PanelScan = () => Promise<{
  ok: boolean;
  fields?: Partial<Record<string, string>>;
  error?: string;
}>;

export type ScoutList = { id: string; name: string };

export type PanelLoadLists = () => Promise<{
  ok: boolean;
  lists?: ScoutList[];
  error?: string;
}>;


export class ScoutPanel {
  private shadow: ShadowRoot;
  private host: HTMLDivElement;
  private panel: HTMLDivElement;
  private tab: HTMLDivElement;
  private touched = new Set<string>();

  constructor(
    private send: PanelSend,
    private scan: PanelScan,
    private loadLists: PanelLoadLists,
  ) {
    const host = document.createElement("div");
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
    this.host = host;
    this.shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = CSS;
    this.shadow.appendChild(style);

    this.tab = document.createElement("div");
    this.tab.className = "tab";
    this.tab.innerHTML = `<span class="dot"></span>SCOUT`;
    this.tab.addEventListener("click", () => this.setOpen(!this.open));
    this.shadow.appendChild(this.tab);

    this.panel = document.createElement("div");
    this.panel.className = "panel";
    this.panel.innerHTML = `
      <div class="head">
        <span class="brand"><span class="mark"><span></span><span></span><span></span><span></span></span>Scout</span>
        <button class="close" title="Collapse">✕</button>
      </div>
      <div class="body">
        <label class="listlabel">
          List
          <button class="refresh" type="button" title="Refresh lists">↻</button>
          <select name="list">
            <option value="">Scout queue (unsorted)</option>
          </select>
        </label>
        ${FIELDS.map(
          ([name, label, type]) =>
            `<label>${label}<input name="${name}" type="${type}" /></label>`,
        ).join("")}
        <label>Seniority
          <select name="seniority">
            <option value="">·</option>
            <option value="peer">Peer</option>
            <option value="mid">Mid</option>
            <option value="senior">Senior</option>
            <option value="c_suite">C-suite</option>
          </select>
        </label>
      </div>
      <div class="foot">
        <button class="scan">Scan this profile</button>
        <button class="send">Send to queue</button>
        <div class="status"></div>
      </div>
    `;
    this.shadow.appendChild(this.panel);

    this.panel
      .querySelector(".close")!
      .addEventListener("click", () => this.setOpen(false));

    // Track fields the user edited so refills never clobber them.
    for (const el of this.panel.querySelectorAll("input, select")) {
      el.addEventListener("input", () =>
        this.touched.add((el as HTMLInputElement).name),
      );
    }

    this.panel
      .querySelector(".scan")!
      .addEventListener("click", () => this.runScan(false));

    this.panel.querySelector(".send")!.addEventListener("click", async () => {
      const btn = this.panel.querySelector(".send") as HTMLButtonElement;
      btn.disabled = true;
      this.setStatus("Sending…", "");
      const res = await this.send(this.values());
      btn.disabled = false;
      if (res.ok) {
        const where =
          res.destination === "segment" && res.segment?.name
            ? res.linked === false
              ? `Already in ${res.segment.name} ✓`
              : `Added to ${res.segment.name} ✓`
            : "In the queue ✓";
        this.setStatus(where, "ok");
        this.touched.clear();
      } else {
        this.setStatus(res.error ?? "Failed", "err");
      }
    });

    // The chosen list persists globally: pick "Turkish founders in London"
    // once and every profile you Send afterwards files into it.
    const listSel = this.panel.querySelector(
      'select[name="list"]',
    ) as HTMLSelectElement;
    listSel.addEventListener("change", () => {
      const name =
        listSel.options[listSel.selectedIndex]?.textContent ?? "";
      browser.storage.local.set({
        scoutListId: listSel.value || "",
        scoutListName: listSel.value ? name : "",
      });
    });
    this.panel
      .querySelector(".refresh")!
      .addEventListener("click", () => this.populateLists());
    this.populateLists();

    browser.storage.local
      .get("panelOpen")
      .then(({ panelOpen }) => this.applyOpen(panelOpen !== false));
  }

  /** Fetch the CRM lists and rebuild the picker, restoring the saved choice. */
  private async populateLists() {
    const sel = this.shadow.querySelector(
      'select[name="list"]',
    ) as HTMLSelectElement | null;
    if (!sel) return;
    const { scoutListId } = await browser.storage.local.get("scoutListId");
    const res = await this.loadLists();
    // Rebuild: default "unsorted" option plus one per CRM list.
    sel.innerHTML = '<option value="">Scout queue (unsorted)</option>';
    if (res.ok && res.lists && res.lists.length) {
      for (const list of res.lists) {
        const opt = document.createElement("option");
        opt.value = list.id;
        opt.textContent = list.name;
        sel.appendChild(opt);
      }
    } else {
      // Say why the picker is empty instead of failing silently.
      const opt = document.createElement("option");
      opt.disabled = true;
      opt.textContent = res.ok
        ? "No lists yet — create one in Research"
        : `Lists unavailable: ${res.error ?? "error"}`;
      sel.appendChild(opt);
    }
    // Restore the saved list if it still exists.
    sel.value =
      scoutListId &&
      Array.from(sel.options).some((o) => o.value === scoutListId)
        ? (scoutListId as string)
        : "";
  }

  private scanning = false;

  /** True once role, company and city are all filled (local parser succeeded). */
  private hasCoreFields(): boolean {
    const v = this.values();
    return Boolean(v.role && v.company && v.city);
  }

  /**
   * Auto-scan a freshly opened profile: AI-fill only the blanks the local
   * parser missed, and stay quiet on failure (e.g. no API key set). Called by
   * the content script ~1.5s after each new profile settles.
   */
  async autoScan() {
    if (this.scanning || this.hasCoreFields()) return;
    await this.runScan(true);
  }

  /**
   * Run the AI scan. Manual mode overwrites any field the user has not edited;
   * auto mode fills only empty fields so it never clobbers the local parser.
   */
  private async runScan(auto: boolean) {
    if (this.scanning) return;
    this.scanning = true;
    const btn = this.panel.querySelector(".scan") as HTMLButtonElement;
    btn.disabled = true;
    this.setStatus(auto ? "Auto-scanning…" : "Scanning…", "");
    const res = await this.scan();
    btn.disabled = false;
    this.scanning = false;
    if (res.ok && res.fields) {
      for (const [name, value] of Object.entries(res.fields)) {
        if (!value || this.touched.has(name)) continue;
        const el = this.shadow.querySelector(
          `[name="${name}"]`,
        ) as HTMLInputElement | null;
        if (!el || (auto && el.value)) continue;
        el.value = value;
      }
      this.setStatus(
        auto ? "Auto-scanned ✓ review and send" : "Scanned ✓ review and send",
        "ok",
      );
    } else if (!auto) {
      // Auto mode stays silent so a missing key does not flash a red error on
      // every profile; the manual Scan button still surfaces the reason.
      this.setStatus(res.error ?? "Scan failed", "err");
    }
  }

  private open = true;

  /** Panel only belongs on profile pages. */
  setVisible(visible: boolean) {
    this.host.style.display = visible ? "" : "none";
  }

  /** Remove all UI (used when the extension context is invalidated). */
  destroy() {
    this.host.remove();
  }

  // The SCOUT handle stays visible either way and toggles the drawer:
  // it rides the drawer's left edge when open, docks to the screen edge
  // when closed.
  private applyOpen(open: boolean) {
    this.open = open;
    this.panel.style.display = open ? "flex" : "none";
    this.tab.classList.toggle("open", open);
  }

  private setOpen(open: boolean) {
    this.applyOpen(open);
    browser.storage.local.set({ panelOpen: open });
  }

  setStatus(text: string, kind: "ok" | "err" | "") {
    const el = this.panel.querySelector(".status") as HTMLElement;
    el.textContent = text;
    el.className = `status ${kind}`;
  }

  /** Fill auto-scraped values, preserving anything the user typed. */
  fill(profile: ParsedProfile, fresh: boolean) {
    if (fresh) this.touched.clear();
    const set = (name: string, value: string | null) => {
      const el = this.shadow.querySelector(
        `[name="${name}"]`,
      ) as HTMLInputElement | null;
      if (!el || this.touched.has(name)) return;
      if (fresh || !el.value) el.value = value ?? "";
    };
    set("name", profile.name);
    set("role", profile.role);
    set("company", profile.company);
    set("city", profile.city);
    set("linkedinUrl", profile.linkedinUrl);
    if (fresh) {
      set("email", "");
      set("phone", "");
      set("seniority", "");
      this.setStatus("", "");
    }
  }

  values(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const el of this.shadow.querySelectorAll("input, select")) {
      const input = el as HTMLInputElement;
      if (input.name) out[input.name] = input.value.trim();
    }
    return out;
  }
}
