import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const runtimeFiles = ["h2-bridge.mjs"];

mkdirSync("dist", { recursive: true });

for (const file of runtimeFiles) {
  cpSync(join("src", file), join("dist", file), { force: true });
}
