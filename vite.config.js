import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built output works when hosted under a subpath
  // (e.g. a GitHub Pages project site at username.github.io/Optimizer/)
  // as well as at a domain root.
  base: "./",
});
