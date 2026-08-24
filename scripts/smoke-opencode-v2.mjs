import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "opencode-cursor-v2-"),
);
const projectRoot = join(temporaryRoot, "project");
const configRoot = join(projectRoot, ".opencode");
const pluginPath =
  process.env.OPENCODE_CURSOR_PLUGIN_PATH ??
  join(root, "dist", "index.js");
await mkdir(configRoot, { recursive: true });
await writeFile(
  join(configRoot, "opencode.json"),
  `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [pluginPath],
  }, null, 2)}\n`,
);
const port = await reservePort();
const password = "opencode-cursor-v2-smoke";
const baseURL = `http://127.0.0.1:${port}`;
const authorization = `Basic ${Buffer.from(
  `opencode:${password}`,
).toString("base64")}`;
let output = "";

const child = spawn(
  "opencode2",
  ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: password,
      XDG_CONFIG_HOME: join(temporaryRoot, "config"),
      XDG_DATA_HOME: join(temporaryRoot, "data"),
      XDG_CACHE_HOME: join(temporaryRoot, "cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

try {
  const plugins = await pollJson(
    "/api/plugin",
    (body) =>
      body.data?.some(
      (plugin) =>
        plugin.id === "opencode.provider.cursor" &&
        plugin.status === "active",
      ),
  );

  const integrations = await pollJson(
    "/api/integration",
    (body) =>
      body.data?.some(
        (integration) => integration.id === "cursor",
      ),
  );
  const cursor = integrations.data?.find(
    (integration) => integration.id === "cursor",
  );
  if (
    !cursor?.methods?.some(
      (method) =>
        method.type === "oauth" && method.id === "browser",
    )
  ) {
    throw new Error("Cursor OAuth integration was not registered");
  }

  const providers = await pollJson(
    "/api/provider",
    (body) => body.data?.some((provider) => provider.id === "cursor"),
  );
  const provider = providers.data?.find((item) => item.id === "cursor");
  if (
    !provider?.package?.startsWith("aisdk:file://") ||
    !provider.package.endsWith("/opencode/provider.js") ||
    provider.settings?.baseURL !== undefined
  ) {
    throw new Error(
      `Cursor provider is not using the native adapter: ${JSON.stringify({
        package: provider?.package,
        settings: provider?.settings,
      })}`,
    );
  }

  console.log(
    "[test] OpenCode V2 loaded the native Cursor provider and OAuth integration",
  );
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function pollJson(path, ready = () => true) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `OpenCode V2 exited before startup (${child.exitCode}): ${output.slice(-2_000)}`,
      );
    }
    try {
      const response = await fetch(`${baseURL}${path}`, {
        headers: { Authorization: authorization },
      });
      if (response.ok) {
        const body = await response.json();
        if (ready(body)) return body;
      }
      lastError = new Error(`${path} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `OpenCode V2 did not become ready: ${String(lastError)} ${output.slice(-2_000)}`,
  );
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve a TCP port"));
        return;
      }
      const { port: reserved } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(reserved);
      });
    });
  });
}
