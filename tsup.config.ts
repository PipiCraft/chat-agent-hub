import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/bin/cli.ts",
    bridge: "src/bridge.ts",
    "mcp-server": "src/mcp-server.ts",
    notify: "src/notify.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "node18",
  shims: true,
});
