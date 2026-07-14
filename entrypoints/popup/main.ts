const toggle = document.getElementById("toggle") as HTMLInputElement;
const dmtoggle = document.getElementById("dmtoggle") as HTMLInputElement;
const status = document.getElementById("status")!;
const target = document.getElementById("target")!;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function render() {
  const { scouting, dmlog, lastCapture, scoutListName } =
    await browser.storage.local.get([
      "scouting",
      "dmlog",
      "lastCapture",
      "scoutListName",
    ]);
  toggle.checked = Boolean(scouting);
  dmtoggle.checked = dmlog === true;
  // Which CRM list captures are filed into. Set from the on-page Scout panel.
  target.innerHTML = scoutListName
    ? `Filing to <b>${escapeHtml(scoutListName as string)}</b>`
    : "Filing to the Scout queue";
  if (lastCapture?.name) {
    const mins = Math.round((Date.now() - lastCapture.at) / 60000);
    status.textContent = `Last capture: ${lastCapture.name} (${
      mins < 1 ? "just now" : `${mins}m ago`
    })`;
  } else {
    const base = scouting
      ? "Panel shows on profiles. Click Send to capture."
      : "Off. The capture panel is hidden.";
    status.textContent =
      dmlog === true ? `${base} DM logging is ON.` : base;
  }
}

toggle.addEventListener("change", async () => {
  await browser.storage.local.set({ scouting: toggle.checked });
  render();
});

dmtoggle.addEventListener("change", async () => {
  await browser.storage.local.set({ dmlog: dmtoggle.checked });
  render();
});

document.getElementById("open-options")!.addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
});

render();
