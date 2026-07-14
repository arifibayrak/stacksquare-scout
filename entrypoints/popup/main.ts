import { mountLogConversation } from "../../lib/log-conversation";

const toggle = document.getElementById("toggle") as HTMLInputElement;
const seg = document.getElementById("dmmode")!;
const statusEl = document.getElementById("status")!;
const target = document.getElementById("target")!;

type DmMode = "off" | "manual" | "auto";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function render() {
  const { scouting, dmMode, dmlog, lastCapture, scoutListName } =
    await browser.storage.local.get([
      "scouting",
      "dmMode",
      "dmlog",
      "lastCapture",
      "scoutListName",
    ]);
  // Scouting is ON by default: an unset value is on (matches the content
  // script and badge). Only an explicit `false` is off.
  const scoutingOn = scouting !== false;
  // Self-heal a fresh/unset install so the persisted state matches what every
  // surface shows, in case onInstalled did not run for this install.
  if (scouting === undefined) await browser.storage.local.set({ scouting: true });
  // Migrate the old boolean toggle: dmlog === true -> auto.
  const mode: DmMode = (dmMode as DmMode) ?? (dmlog === true ? "auto" : "off");
  toggle.checked = scoutingOn;
  for (const b of seg.querySelectorAll("button")) {
    b.classList.toggle(
      "active",
      (b as HTMLButtonElement).dataset.mode === mode,
    );
  }
  // Which CRM list captures are filed into. Set from the on-page Scout panel.
  target.innerHTML = scoutListName
    ? `Filing to <b>${escapeHtml(scoutListName as string)}</b>`
    : "Filing to the Scout queue";
  const cap = lastCapture as { name?: string; at?: number } | undefined;
  if (cap?.name) {
    const mins = Math.round((Date.now() - (cap.at ?? Date.now())) / 60000);
    statusEl.textContent = `Last capture: ${cap.name} (${
      mins < 1 ? "just now" : `${mins}m ago`
    })`;
  } else {
    const base = scoutingOn
      ? "Panel shows on profiles. Click Send to capture."
      : "Off. The capture panel is hidden.";
    const dmNote =
      mode === "auto"
        ? " DMs: auto-log on open."
        : mode === "manual"
          ? " DMs: click the button on a chat."
          : "";
    statusEl.textContent = base + dmNote;
  }
}

toggle.addEventListener("change", async () => {
  await browser.storage.local.set({ scouting: toggle.checked });
  render();
});

seg.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest("button");
  if (!btn) return;
  const mode = (btn as HTMLButtonElement).dataset.mode;
  if (!mode) return;
  await browser.storage.local.set({ dmMode: mode });
  render();
});

document.getElementById("open-options")!.addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
});

// Open the roomy full-page logger in its own tab for long conversations.
document.getElementById("open-log")!.addEventListener("click", (e) => {
  e.preventDefault();
  browser.tabs.create({ url: browser.runtime.getURL("/log.html") });
});

// Compact inline logger for quick pastes without leaving the popup.
mountLogConversation(document.getElementById("log-root")!, { compact: true });

render();
