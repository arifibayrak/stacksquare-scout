import { parseProfile, profileSlug } from "../lib/parser";
import { ScoutPanel } from "../lib/panel";

export default defineContentScript({
  matches: ["https://www.linkedin.com/*"],
  runAt: "document_idle",
  main() {
    // Re-capture cooldown per profile URL, so SPA re-renders and quick
    // back-and-forth navigation don't hammer the endpoint.
    const COOLDOWN_MS = 10 * 60 * 1000;
    const lastSent = new Map<string, number>();
    let currentUrl = "";
    let lastFilledUrl = "";

    function cleanUrl(): string {
      return location.href.split("?")[0].split("#")[0].replace(/\/$/, "");
    }

    // The right-edge drawer. Its send button submits whatever is in the
    // fields, including manual email/phone/seniority.
    const panel = new ScoutPanel(async (values) => {
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
        lastSent.set(values.linkedinUrl || cleanUrl(), Date.now());
      }
      return res ?? { ok: false, error: "No response from background" };
    });

    function refreshPanel() {
      const slug = profileSlug(location.href);
      panel.setVisible(Boolean(slug));
      if (!slug) return;

      const profile = parseProfile();
      if (!profile) return;

      const url = cleanUrl();
      const fresh = url !== lastFilledUrl;
      panel.fill(profile, fresh);
      if (fresh) lastFilledUrl = url;
    }

    async function maybeAutoCapture() {
      const slug = profileSlug(location.href);
      if (!slug) return;

      const { scouting } = await browser.storage.local.get("scouting");
      if (!scouting) return;

      const url = cleanUrl();
      const last = lastSent.get(url) ?? 0;
      if (Date.now() - last < COOLDOWN_MS) return;

      const profile = parseProfile();
      if (!profile || !profile.name) return;

      lastSent.set(url, Date.now());
      const res = await browser.runtime.sendMessage({
        type: "CAPTURE",
        payload: profile,
      });
      if (res?.ok) {
        await browser.storage.local.set({
          lastCapture: { name: profile.name, at: Date.now() },
        });
        panel.setStatus("Auto-captured ✓", "ok");
      } else {
        lastSent.delete(url); // allow retry on next settle
        if (res?.error) console.warn("[scout] capture failed:", res.error);
      }
    }

    // LinkedIn is an SPA: watch for URL changes, let the new page settle,
    // then refill the panel and capture. The second timer catches
    // lazy-loaded sections.
    function onUrlSettled() {
      setTimeout(() => {
        refreshPanel();
        maybeAutoCapture();
      }, 1200);
      setTimeout(() => {
        refreshPanel();
        maybeAutoCapture();
      }, 4000);
    }

    setInterval(() => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        onUrlSettled();
      }
    }, 700);

    currentUrl = location.href;
    onUrlSettled();
  },
});
