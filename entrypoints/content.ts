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
    // Separate, default-OFF toggle for logging DM conversations.
    let dmlogOn = false;
    let lastDmThreadId = "";
    browser.storage.local.get(["scouting", "dmlog"]).then(({ scouting, dmlog }) => {
      scoutingOn = scouting !== false;
      dmlogOn = dmlog === true;
      refreshPanel();
    });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.scouting) {
        scoutingOn = changes.scouting.newValue !== false;
        refreshPanel();
      }
      if (changes.dmlog) {
        dmlogOn = changes.dmlog.newValue === true;
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
    function refreshPanel() {
      if (!alive()) return;
      const slug = profileSlug(location.href);
      panel.setVisible(Boolean(slug) && scoutingOn);
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
          "position:fixed;bottom:20px;right:20px;z-index:2147483647;" +
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

    // On a /messaging/thread/* page, once it settles, read the open thread and
    // send it once per thread view. The server dedups re-sends cheaply, so
    // re-opening a thread is a no-op unless there are new messages.
    async function maybeCaptureDm() {
      if (!alive() || !dmlogOn) return;
      const tid = threadIdFromUrl(location.href);
      if (!tid || tid === lastDmThreadId) return;
      const thread = parseThread();
      if (!thread || thread.transcript.length === 0) return;
      lastDmThreadId = tid;
      const res = await browser.runtime.sendMessage({
        type: "DM_CAPTURE",
        payload: {
          conversationId: thread.conversationId,
          counterpart: thread.counterpart,
          transcript: thread.transcript,
          parser: thread.parser,
        },
      });
      if (!res?.ok) {
        if (res?.error) showChip(`Scout: ${res.error}`);
        return;
      }
      if (res.unchanged) return;
      if (res.skipped) showChip("Scout: DM not logged (filtered)");
      else if (res.matched)
        showChip(`Scout: logged → ${res.contactName ?? "contact"}`);
      else showChip("Scout: logged (unmatched, review in CRM)");
    }

    // The second pass catches the lazy-loaded experience section. The DM pass
    // waits longer, since messaging bubbles stream in after the thread opens.
    function onUrlSettled() {
      setTimeout(refreshPanel, 1200);
      setTimeout(refreshPanel, 4000);
      clearTimeout(dmTimer);
      dmTimer = setTimeout(maybeCaptureDm, 4000);
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
