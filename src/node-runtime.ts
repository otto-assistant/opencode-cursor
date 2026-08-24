type Environment = Record<string, string | undefined>;

export function findNodeExecutable(
  environment: Environment,
  which: () => string | undefined,
  loginShell: () => string | undefined,
): string {
  const configured =
    environment.OPENCODE_CURSOR_NODE_PATH?.trim();
  if (configured) return configured;
  const onPath = which();
  if (onPath) return onPath;
  const fromShell = loginShell();
  if (fromShell) return fromShell;
  throw new Error(
    "Node.js executable not found. Set OPENCODE_CURSOR_NODE_PATH to an absolute Node.js path.",
  );
}

let cachedNodeExecutable: string | undefined;

export function resolveNodeExecutable(): string {
  cachedNodeExecutable ??= findNodeExecutable(
    process.env,
    () => Bun.which("node") ?? undefined,
    discoverNodeFromLoginShell,
  );
  return cachedNodeExecutable;
}

function discoverNodeFromLoginShell(): string | undefined {
  if (process.platform === "win32") {
    return runLocator(["where.exe", "node"]);
  }

  const shells = [
    process.env.SHELL,
    "/bin/bash",
    "/bin/zsh",
    "/usr/bin/fish",
    "/bin/sh",
  ].filter(
    (value, index, values): value is string =>
      Boolean(value) && values.indexOf(value) === index,
  );
  for (const shell of shells) {
    const located = runLocator([
      shell,
      "-lc",
      "command -v node",
    ]);
    if (located) return located;
  }
  return undefined;
}

function runLocator(command: string[]): string | undefined {
  try {
    const result = Bun.spawnSync(command, {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return undefined;
    const first = result.stdout
      .toString()
      .split(/\r?\n/, 1)[0]
      ?.trim();
    return first || undefined;
  } catch {
    return undefined;
  }
}
