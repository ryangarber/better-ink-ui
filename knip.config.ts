import type { KnipConfig } from "knip";

export default {
  // Demos run against `dist` by hand.
  ignore: ["examples/**"],
  tags: ["-lintignore"]
} satisfies KnipConfig;
