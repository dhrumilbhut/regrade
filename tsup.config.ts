import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig([
  {
    entry: { cli: "src/cli/bin.ts" },
    format: ["esm"],
    target: "node22",
    platform: "node",
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
    define: { __REGRADE_VERSION__: JSON.stringify(pkg.version) },
  },
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node22",
    platform: "node",
    dts: true,
    sourcemap: true,
    define: { __REGRADE_VERSION__: JSON.stringify(pkg.version) },
  },
]);
