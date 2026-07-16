export default defineBackground(() => {
  // Scouting is ON by default: an unset value counts as on everywhere (content
  // panel, badge, popup) so a fresh install shows the capture panel instead of
  // silently doing nothing. `scouting === false` is the only "off" state.
  const isOn = (v: unknown) => v !== false;

  // Badge mirrors the Scouting switch.
  async function syncBadge() {
    const { scouting } = await browser.storage.local.get("scouting");
    await browser.action.setBadgeBackgroundColor({ color: "#1d3fbf" });
    await browser.action.setBadgeText({ text: isOn(scouting) ? "ON" : "" });
  }
  syncBadge();

  // Persist the ON default on install/update so the popup toggle and the badge
  // agree with the content script from the first profile you open.
  browser.runtime.onInstalled.addListener(async () => {
    const { scouting } = await browser.storage.local.get("scouting");
    if (scouting === undefined) {
      await browser.storage.local.set({ scouting: true });
    }
    syncBadge();
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.scouting) syncBadge();
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CAPTURE") {
      handleCapture(message.payload).then(sendResponse);
      return true; // async response
    }
    if (message?.type === "EXTRACT") {
      handleExtract(message.payload).then(sendResponse);
      return true;
    }
    if (message?.type === "LISTS") {
      handleLists().then(sendResponse);
      return true;
    }
    if (message?.type === "LOOKUP") {
      handleLookup(message.payload).then(sendResponse);
      return true;
    }
    if (message?.type === "DM_CAPTURE") {
      handleDmCapture(message.payload).then(sendResponse);
      return true;
    }
  });

  async function handleDmCapture(payload: unknown) {
    const { apiUrl, apiKey } = await browser.storage.sync.get([
      "apiUrl",
      "apiKey",
    ]);
    const base = (apiUrl as string) || "https://stacksquare.ai";
    if (!apiKey) return { ok: false, error: "No API key set." };
    try {
      const res = await fetch(`${base}/api/outreach/linkedin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey as string,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.error ?? `HTTP ${res.status}` };
      }
      const data = await res.json();
      return { ok: true, ...data };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Network error",
      };
    }
  }

  async function handleLists() {
    const { apiUrl, apiKey } = await browser.storage.sync.get([
      "apiUrl",
      "apiKey",
    ]);
    const base = (apiUrl as string) || "https://stacksquare.ai";
    if (!apiKey) return { ok: false, error: "No API key set." };
    try {
      const res = await fetch(`${base}/api/segments`, {
        headers: { "X-API-Key": apiKey as string },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.error ?? `HTTP ${res.status}` };
      }
      const data = await res.json();
      return { ok: true, lists: data.lists ?? [] };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Network error",
      };
    }
  }

  // Pre-check whether a LinkedIn profile is already in the CRM (a contact, a
  // prospect, which lists, and its Scout-queue status). Read-only; the panel
  // uses it to show a presence badge and block re-filing into a list the person
  // is already in.
  async function handleLookup(payload: {
    linkedinUrl?: string;
    name?: string;
    company?: string;
    email?: string;
  }) {
    const { apiUrl, apiKey } = await browser.storage.sync.get([
      "apiUrl",
      "apiKey",
    ]);
    const base = (apiUrl as string) || "https://stacksquare.ai";
    if (!apiKey) return { ok: false, error: "No API key set." };
    const params = new URLSearchParams();
    for (const k of ["linkedinUrl", "name", "company", "email"] as const) {
      const v = payload?.[k];
      if (v) params.set(k, v);
    }
    try {
      const res = await fetch(`${base}/api/lookup?${params.toString()}`, {
        headers: { "X-API-Key": apiKey as string },
        cache: "no-store",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.error ?? `HTTP ${res.status}` };
      }
      const data = await res.json();
      return { ok: true, ...data };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Network error",
      };
    }
  }

  async function handleExtract(payload: unknown) {
    const { apiUrl, apiKey } = await browser.storage.sync.get([
      "apiUrl",
      "apiKey",
    ]);
    const base = (apiUrl as string) || "https://stacksquare.ai";
    if (!apiKey) return { ok: false, error: "No API key set." };
    try {
      const res = await fetch(`${base}/api/extract`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey as string,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.error ?? `HTTP ${res.status}` };
      }
      const fields = await res.json();
      return { ok: true, fields };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Network error",
      };
    }
  }

  async function handleCapture(payload: unknown) {
    const { apiUrl, apiKey } = await browser.storage.sync.get([
      "apiUrl",
      "apiKey",
    ]);
    const base = (apiUrl as string) || "https://stacksquare.ai";
    if (!apiKey) {
      return { ok: false, error: "No API key set. Open Scout options." };
    }

    try {
      const res = await fetch(`${base}/api/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey as string,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.error ?? `HTTP ${res.status}` };
      }
      const data = await res.json();
      // Brief badge flash so a capture is visible without any page UI.
      await browser.action.setBadgeText({ text: "✓" });
      setTimeout(async () => {
        const { scouting } = await browser.storage.local.get("scouting");
        await browser.action.setBadgeText({ text: isOn(scouting) ? "ON" : "" });
      }, 1800);
      // Pass the whole response through (destination, segment, id, status) so
      // the panel can report which list the profile landed in.
      return { ok: true, ...data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Network error" };
    }
  }
});
