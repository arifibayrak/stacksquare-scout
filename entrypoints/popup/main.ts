const toggle = document.getElementById("toggle") as HTMLInputElement;
const status = document.getElementById("status")!;

async function render() {
  const { scouting, lastCapture } = await browser.storage.local.get([
    "scouting",
    "lastCapture",
  ]);
  toggle.checked = Boolean(scouting);
  if (lastCapture?.name) {
    const mins = Math.round((Date.now() - lastCapture.at) / 60000);
    status.textContent = `Last capture: ${lastCapture.name} (${
      mins < 1 ? "just now" : `${mins}m ago`
    })`;
  } else {
    status.textContent = scouting
      ? "Open LinkedIn profiles to capture them."
      : "Off. Nothing is captured.";
  }
}

toggle.addEventListener("change", async () => {
  await browser.storage.local.set({ scouting: toggle.checked });
  render();
});

document.getElementById("open-options")!.addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
});

render();
