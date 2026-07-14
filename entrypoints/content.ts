import { parseProfile, profileSlug } from "../lib/parser";
import { parseThread, threadIdFromUrl } from "../lib/messaging-parser";
import { ScoutPanel } from "../lib/panel";

export default defineContentScript({
  matches: ["https://www.linkedin.com/*"],
  runAt: "document_idle",
  main() {
    let currentUrl = "";
    let lastFilledUrl = "";
    let lastScannedUrl = "";
    let autoScanTimer: ReturnType<typeof setTimeout> | undefined;
    let dmTimer: ReturnType<typeof setTimeout> | undefined;
    // The popup toggle controls whether the capture panel is shown.
    let scoutingOn = true;
    // DM logging mode (default OFF). "auto" = capture when a thread opens;
    // "manual" = show a button on the thread that captures on click.
    type DmMode = "off" | "manual" | "auto";
    let dmMode: DmMode = "off";
    let lastDmThreadId = "";
    let dmButton: HTMLButtonElement | undefined;
    browser.storage.local
      .get(["scouting", "dmMode", "dmlog"])
      .then(({ scouting, dmMode: m, dmlog }) => {
        scoutingOn = scouting !== false;
        // Migrate the old boolean toggle: dmlog === true -> auto.
        dmMode = (m as DmMode) ?? (dmlog === true ? "auto" : "off");
        refreshPanel();
        updateDmButton();
      });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.scouting) {
        scoutingOn = changes.scouting.newValue !== false;
        refreshPanel();
      }
      if (changes.dmMode) {
        dmMode = (changes.dmMode.newValue as DmMode) ?? "off";
        updateDmButton();
        scheduleAutoDm();
      }
    });

    function cleanUrl(): string {
      return location.href.split("?")[0].split("#")[0].replace(/\/$/, "");
    }

    // Visible page text; the server extracts any fields the local parser
    // missed using AI, which survives LinkedIn DOM changes entirely.
    function pageText(): string {
      const root = document.querySelector("main") ?? document.body;
      return ((root as HTMLElement).innerText ?? "")
        .replace(/\n{3,}/g, "\n\n")
        .slice(0, 15000);
    }

    // When the extension is reloaded, content scripts in already-open tabs
    // are orphaned and every runtime/storage call fails forever. Detect it
    // and shut down cleanly instead of spamming the console.
    let dead = false;
    function alive(): boolean {
      if (dead) return false;
      if (!browser.runtime?.id) {
        shutdown();
        return false;
      }
      return true;
    }
    function shutdown() {
      if (dead) return;
      dead = true;
      clearInterval(urlTimer);
      clearTimeout(autoScanTimer);
      clearTimeout(dmTimer);
      dmButton?.remove();
      try {
        panel.destroy();
      } catch {
        // host already gone
      }
      console.info("[scout] extension reloaded; refresh this tab to resume");
    }

    // The right-edge drawer. Its send button submits whatever is in the
    // fields, including manual email/phone/seniority.
    const panel = new ScoutPanel(async (values) => {
      if (!alive()) return { ok: false, error: "Refresh the tab" };
      if (!values.name) return { ok: false, error: "Name is required" };
      const scraped = parseProfile();
      const res = await browser.runtime.sendMessage({
        type: "CAPTURE",
        payload: {
          linkedinUrl: values.linkedinUrl || cleanUrl(),
          name: values.name,
          role: values.role || null,
          company: values.company || null,
          city: values.city || null,
          headline: scraped?.headline ?? null,
          relationship: scraped?.relationship ?? null,
          email: values.email || null,
          phone: values.phone || null,
          seniority: values.seniority || null,
          // Chosen List: null routes to the generic Scout queue, an id files
          // the profile straight into that CRM list (Research segment).
          segmentId: values.list || null,
          pageText: pageText(),
          payload: {
            ...(scraped?.payload ?? { parser: "manual@1" }),
            manual: true,
          },
        },
      });
      if (res?.ok) {
        await browser.storage.local.set({
          lastCapture: { name: values.name, at: Date.now() },
        });
      }
      return res ?? { ok: false, error: "No response from background" };
    }, async () => {
      // "Scan this profile": AI-extract role/company/city from page text.
      if (!alive()) return { ok: false, error: "Refresh the tab" };
      const text = pageText();
      if (!text) return { ok: false, error: "No page text" };
      const res = await browser.runtime.sendMessage({
        type: "EXTRACT",
        payload: { pageText: text },
      });
      return res ?? { ok: false, error: "No response from background" };
    }, async () => {
      // Populate the List picker from the CRM's Research segments.
      if (!alive()) return { ok: false, error: "Refresh the tab" };
      const res = await browser.runtime.sendMessage({ type: "LISTS" });
      return res ?? { ok: false, error: "No response from background" };
    });

    // Nothing is recorded automatically. The panel fills its fields from the
    // page; capturing happens only when the user clicks Send (or Scan).
    let lastVisible: boolean | undefined;
    function refreshPanel() {
      if (!alive()) return;
      const slug = profileSlug(location.href);
      const visible = Boolean(slug) && scoutingOn;
      panel.setVisible(visible);
      // Log only on change: makes "panel never shows" self-diagnosing.
      // profile=false -> not a /in/ page; scouting=false -> switch is off.
      if (visible !== lastVisible) {
        console.info(
          `[scout] panel ${visible ? "shown" : "hidden"} (profile=${Boolean(
            slug,
          )}, scouting=${scoutingOn})`,
        );
        lastVisible = visible;
      }
      if (!slug || !scoutingOn) return;

      const profile = parseProfile();
      if (!profile) return;

      const url = cleanUrl();
      const fresh = url !== lastFilledUrl;
      panel.fill(profile, fresh);
      if (fresh) lastFilledUrl = url;
      scheduleAutoScan(url);
    }

    // Open a profile and, once it settles (~1.5s), auto-run the AI scan to fill
    // anything the local parser missed. Fires once per profile; skips when the
    // core fields are already present (checked inside panel.autoScan).
    function scheduleAutoScan(url: string) {
      if (!scoutingOn || url === lastScannedUrl) return;
      lastScannedUrl = url;
      clearTimeout(autoScanTimer);
      autoScanTimer = setTimeout(() => {
        if (!alive() || cleanUrl() !== url) return;
        panel.autoScan();
      }, 1500);
    }

    // Brief, unobtrusive status toast for DM logging (no persistent UI).
    let chip: HTMLDivElement | undefined;
    let chipTimer: ReturnType<typeof setTimeout> | undefined;
    function showChip(text: string) {
      if (!chip) {
        chip = document.createElement("div");
        chip.style.cssText =
          "position:fixed;bottom:64px;right:20px;z-index:2147483647;" +
          "background:#0e0d0b;color:#f0ebdf;font:12px ui-monospace,Menlo,monospace;" +
          "padding:8px 12px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);" +
          "max-width:260px;opacity:0;transition:opacity .2s;pointer-events:none;";
        document.body.appendChild(chip);
      }
      chip.textContent = text;
      chip.style.opacity = "1";
      clearTimeout(chipTimer);
      chipTimer = setTimeout(() => {
        if (chip) chip.style.opacity = "0";
      }, 3200);
    }

    const DM_BTN_LABEL = "Log this chat → Scout";

    // Semi-auto: show a button on the open thread; capture on click.
    function updateDmButton() {
      if (!alive()) return;
      const show =
        dmMode === "manual" && Boolean(threadIdFromUrl(location.href));
      if (show) {
        if (!dmButton) {
          dmButton = document.createElement("button");
          dmButton.type = "button";
          dmButton.textContent = DM_BTN_LABEL;
          dmButton.style.cssText =
            "position:fixed;bottom:20px;right:20px;z-index:2147483647;" +
            "background:#1d3fbf;color:#f0ebdf;font:12px ui-monospace,Menlo,monospace;" +
            "padding:9px 14px;border:0;border-radius:8px;cursor:pointer;" +
            "box-shadow:0 4px 16px rgba(0,0,0,.3);";
          dmButton.addEventListener("click", () => captureDm({ manual: true }));
          document.body.appendChild(dmButton);
        }
        dmButton.style.display = "";
      } else if (dmButton) {
        dmButton.style.display = "none";
      }
    }

    // Auto: once a thread settles, capture it once per view. The server dedups
    // re-sends, so re-opening a thread is a cheap no-op.
    function scheduleAutoDm() {
      clearTimeout(dmTimer);
      if (dmMode !== "auto") return;
      dmTimer = setTimeout(() => captureDm({ manual: false }), 4000);
    }

    // Read the open thread and send it. Manual capture is forced (ignores the
    // per-view guard) and gives explicit feedback; auto capture is deduped.
    async function captureDm({ manual }: { manual: boolean }) {
      if (!alive() || dmMode === "off") return;
      const tid = threadIdFromUrl(location.href);
      if (!tid) {
        if (manual) showChip("Scout: open a message thread first");
        return;
      }
      if (!manual && tid === lastDmThreadId) return;
      const thread = parseThread();
      if (!thread || thread.transcript.length === 0) {
        if (manual) showChip("Scout: no messages found in this thread");
        return;
      }
      lastDmThreadId = tid;
      if (manual && dmButton) {
        dmButton.disabled = true;
        dmButton.textContent = "Logging…";
      }
      const res = await browser.runtime.sendMessage({
        type: "DM_CAPTURE",
        payload: {
          conversationId: thread.conversationId,
          counterpart: thread.counterpart,
          transcript: thread.transcript,
          parser: thread.parser,
        },
      });
      if (manual && dmButton) {
        dmButton.disabled = false;
        dmButton.textContent = DM_BTN_LABEL;
      }
      if (!res?.ok) {
        showChip(`Scout: ${res?.error ?? "failed"}`);
        return;
      }
      if (res.unchanged) {
        if (manual) showChip("Scout: already up to date");
        return;
      }
      if (res.skipped) showChip("Scout: not logged (filtered)");
      else if (res.matched)
        showChip(`Scout: logged → ${res.contactName ?? "contact"}`);
      else showChip("Scout: logged (unmatched, review in CRM)");
    }

    // The second pass catches the lazy-loaded experience section. Auto DM
    // capture waits longer, since messaging bubbles stream in after open.
    function onUrlSettled() {
      setTimeout(refreshPanel, 1200);
      setTimeout(refreshPanel, 4000);
      updateDmButton();
      scheduleAutoDm();
    }

    const urlTimer = setInterval(() => {
      if (!alive()) return;
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        onUrlSettled();
      }
    }, 700);

    currentUrl = location.href;
    onUrlSettled();
  },
});
