import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Stacksquare Scout",
    description:
      "Flip the switch and every LinkedIn profile you open lands in the Stacksquare CRM scout queue.",
    permissions: ["storage"],
    host_permissions: ["https://stacksquare.ai/*"],
    action: {
      default_title: "Stacksquare Scout",
    },
  },
});
