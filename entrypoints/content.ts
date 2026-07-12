import { parseProfile, profileSlug } from "../lib/parser";
import { ScoutPanel } from "../lib/panel";

export default defineContentScript({
  matches: ["https://www.linkedin.com/*"],
  runAt: "document_idle",
  main() {
    let currentUrl = "";
    let lastFilledUrl = "";
    let lastScannedUrl = "";
    let autoScanTimer: ReturnType<typeof setTimeout> | undefined;
    // The popup toggle controls whether the capture panel is shown.
    let scoutingOn = true;
    browser.storage.local.get("scouting").then(({ scouting }) => {
      scoutingOn = scouting !== false;
      refreshPanel();
    });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.scouting) {
        scoutingOn = changes.scouting.newValue !== false;
        refreshPanel();
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

    // The second pass catches the lazy-loaded experience section.
    function onUrlSettled() {
      setTimeout(refreshPanel, 1200);
      setTimeout(refreshPanel, 4000);
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
