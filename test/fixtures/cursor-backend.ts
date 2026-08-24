import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  GetUsableModelsResponseSchema,
  McpArgsSchema,
  ModelDetailsSchema,
} from "../../src/proto/agent_pb";
import {
  frameConnectUnaryMessage,
  frameHeartbeatServerMessage,
  frameTextThenEndServerMessages,
} from "../helpers/frames";
import { makeJwt } from "../helpers/jwt";

export type DiscoveryMode = "success" | "empty" | "auth-error";
export type RunMode =
  | "immediate-close"
  | "stall-once-then-close"
  | "heartbeat-only-stall"
  | "text-then-hang"
  | "tool-call-then-hang"
  | "tool-call-then-silent-hang"
  | "resume-text-then-hang";

export interface TestCursorBackend {
  apiUrl: string;
  refreshUrl: string;
  setDiscoveryMode: (mode: DiscoveryMode) => void;
  setDiscoveredModels: (
    models: Array<{ id: string; name: string; reasoning?: boolean }>,
  ) => void;
  setAvailableModels: (models: unknown[] | undefined) => void;
  resetObservations: () => void;
  getDiscoveryAuthHeaders: () => string[];
  getRefreshAuthHeaders: () => string[];
  /**
   * Override the value the refresh server places in `refreshToken` of a
   * successful (200) response. Pass `null` to omit the field entirely.
   * `undefined` (the default) restores the canonical `"valid-refresh"` echo.
   */
  setRefreshResponseRefreshToken: (
    value: string | null | undefined,
  ) => void;
  setRunMode: (mode: RunMode) => void;
  getRunRequestCount: () => number;
  getRunUserTexts: () => string[];
  getRunModelIds: () => string[];
  getRunSelections: () => Array<{
    publicId?: string;
    displayName?: string;
    modelDetailsMaxMode?: boolean;
    modelId?: string;
    maxMode?: boolean;
    parameters: Record<string, string>;
  }>;
  close: () => Promise<void>;
}

export async function startTestCursorBackend(): Promise<TestCursorBackend> {
  let discoveryMode: DiscoveryMode = "success";
  let runMode: RunMode = "immediate-close";
  let runRequestCount = 0;
  const runModelIds: string[] = [];
  const runUserTexts: string[] = [];
  let runStallConsumed = false;
  let discoveredModels: Array<{
    id: string;
    name: string;
    reasoning?: boolean;
  }> = [
    { id: "composer-2", name: "Composer 2", reasoning: true },
  ];
  let availableModels: unknown[] | undefined;
  const runSelections: Array<{
    publicId?: string;
    displayName?: string;
    modelDetailsMaxMode?: boolean;
    modelId?: string;
    maxMode?: boolean;
    parameters: Record<string, string>;
  }> = [];
  const discoveryAuthHeaders: string[] = [];
  const refreshAuthHeaders: string[] = [];

  let refreshResponseRefreshTokenOverride: string | null | undefined;
  const refreshServer = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/auth/exchange_user_api_key") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    refreshAuthHeaders.push(authHeader);

    if (authHeader !== "Bearer valid-refresh") {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("bad refresh token");
      return;
    }

    const body: Record<string, string> = {
      accessToken: makeJwt(Math.floor(Date.now() / 1000) + 3600),
    };
    if (refreshResponseRefreshTokenOverride === undefined) {
      body.refreshToken = "valid-refresh";
    } else if (refreshResponseRefreshTokenOverride !== null) {
      body.refreshToken = refreshResponseRefreshTokenOverride;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) =>
    refreshServer.listen(0, "127.0.0.1", resolve),
  );
  const refreshPort = (refreshServer.address() as AddressInfo).port;

  const apiServer = http2.createServer();
  apiServer.on("stream", (stream, headers) => {
    const path = String(headers[":path"] ?? "");
    const authHeader = String(headers.authorization ?? "");
    if (path === "/agent.v1.AgentService/Run") {
      runRequestCount++;
      let pending = Buffer.alloc(0);
      stream.on("data", (chunk) => {
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        while (pending.length >= 5) {
          const messageLength = pending.readUInt32BE(1);
          if (pending.length < 5 + messageLength) break;
          const payload = pending.subarray(5, 5 + messageLength);
          pending = pending.subarray(5 + messageLength);
          try {
            const message = fromBinary(AgentClientMessageSchema, payload);
            if (message.message.case === "runRequest") {
              const runRequest = message.message.value;
              const modelId = runRequest.modelDetails?.modelId;
              if (modelId) runModelIds.push(modelId);
              const action = runRequest.action?.action;
              if (action?.case === "userMessageAction") {
                const text = action.value.userMessage?.text;
                if (typeof text === "string") runUserTexts.push(text);
              }
              runSelections.push({
                publicId: modelId,
                displayName: runRequest.modelDetails?.displayName,
                modelDetailsMaxMode: runRequest.modelDetails?.maxMode,
                modelId: runRequest.requestedModel?.modelId,
                maxMode: runRequest.requestedModel?.maxMode,
                parameters: Object.fromEntries(
                  (runRequest.requestedModel?.parameters ?? []).map(
                    (parameter) => [parameter.id, parameter.value],
                  ),
                ),
              });
            } else if (message.message.case === "execClientMessage") {
              // The proxy delivered an mcpResult (tool-result resume). In the
              // tool-call modes, respond with visible text and then hang —
              // simulating a model that starts answering and stalls.
              if (
                runMode === "tool-call-then-hang" ||
                runMode === "resume-text-then-hang"
              ) {
                try {
                  stream.write(
                    frameTextThenEndServerMessages("partial...")[0]!,
                  );
                } catch {
                  // ignore
                }
              }
              // "tool-call-then-silent-hang": stay completely silent after the
              // tool result so the post-tool PRE-OUTPUT stall budget is hit.
            }
          } catch {
            // Other Connect frames are not relevant to model-routing assertions.
          }
        }
      });
      stream.respond({
        ":status": 200,
        "content-type": "application/connect+proto",
      });
      if (runMode === "stall-once-then-close" && !runStallConsumed) {
        runStallConsumed = true;
        // Intentionally keep stream open with no data to simulate a reset/hang.
        // Auto-close later so the test process can shut down cleanly.
        setTimeout(() => {
          try {
            stream.end();
          } catch {
            // ignore
          }
        }, 3_000);
        return;
      }
      if (runMode === "heartbeat-only-stall" && !runStallConsumed) {
        runStallConsumed = true;
        // Simulate Grok "weighing options": periodic heartbeats, zero content.
        // Without the keepalive exclusion these would falsely reset the stall timer.
        const heartbeatTimer = setInterval(() => {
          try {
            stream.write(frameHeartbeatServerMessage());
          } catch {
            clearInterval(heartbeatTimer);
          }
        }, 200);
        setTimeout(() => {
          clearInterval(heartbeatTimer);
          try {
            stream.end();
          } catch {
            // ignore
          }
        }, 8_000);
        return;
      }
      if (
        runMode === "text-then-hang" ||
        runMode === "resume-text-then-hang"
      ) {
        try {
          stream.write(frameTextThenEndServerMessages("partial...")[0]!);
        } catch {
          // ignore
        }
        // Keep the Run open (no turn_ended / end) until the client aborts.
        setTimeout(() => {
          try {
            stream.end();
          } catch {
            // ignore
          }
        }, 8_000);
        return;
      }
      if (runMode === "tool-call-then-hang") {
        // Emit an MCP tool call (bash) so the proxy streams tool_calls SSE and
        // parks the bridge; then keep the Run open until the proxy sends the
        // mcpResult (handled in the data listener above).
        try {
          const execMsg = create(ExecServerMessageSchema, {
            id: 1,
            execId: "exec-1",
            message: {
              case: "mcpArgs",
              value: create(McpArgsSchema, {
                name: "bash",
                toolName: "bash",
                toolCallId: "cursor-call-1",
                providerIdentifier: "opencode",
                args: {},
              }),
            },
          });
          stream.write(
            frameConnectUnaryMessage(
              toBinary(
                AgentServerMessageSchema,
                create(AgentServerMessageSchema, {
                  message: { case: "execServerMessage", value: execMsg },
                }),
              ),
            ),
          );
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            stream.end();
          } catch {
            // ignore
          }
        }, 12_000);
        return;
      }
      if (runMode === "tool-call-then-silent-hang") {
        // Same as tool-call-then-hang: emit a tool call so the proxy parks the
        // bridge. On the mcpResult resume the data listener stays silent, so
        // the post-tool PRE-OUTPUT stall budget must fire. (Recovery spawns a
        // fresh stream which emits another tool call, letting the test end.)
        try {
          const execMsg = create(ExecServerMessageSchema, {
            id: 1,
            execId: "exec-1",
            message: {
              case: "mcpArgs",
              value: create(McpArgsSchema, {
                name: "bash",
                toolName: "bash",
                toolCallId: "cursor-call-1",
                providerIdentifier: "opencode",
                args: {},
              }),
            },
          });
          stream.write(
            frameConnectUnaryMessage(
              toBinary(
                AgentServerMessageSchema,
                create(AgentServerMessageSchema, {
                  message: { case: "execServerMessage", value: execMsg },
                }),
              ),
            ),
          );
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            stream.end();
          } catch {
            // ignore
          }
        }, 12_000);
        return;
      }
      for (const frame of frameTextThenEndServerMessages("ok")) {
        try {
          stream.write(frame);
        } catch {
          // ignore
        }
      }
      stream.end();
      return;
    }

    const chunks: Buffer[] = [];

    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => {
      if (path === "/aiserver.v1.AiService/AvailableModels") {
        if (!availableModels) {
          stream.respond({
            ":status": 404,
            "content-type": "application/json",
          });
          stream.end(JSON.stringify({ error: "not configured" }));
          return;
        }
        stream.respond({
          ":status": 200,
          "content-type": "application/json",
        });
        stream.end(JSON.stringify({ models: availableModels }));
        return;
      }

      if (path === "/agent.v1.AgentService/GetUsableModels") {
        discoveryAuthHeaders.push(authHeader);

        if (discoveryMode === "auth-error") {
          stream.respond({
            ":status": 401,
            "content-type": "application/json",
          });
          stream.end(
            JSON.stringify({
              code: "unauthenticated",
              message: "expired token",
            }),
          );
          return;
        }

        const responseBody =
          discoveryMode === "empty"
            ? frameConnectUnaryMessage(new Uint8Array())
            : frameConnectUnaryMessage(
                toBinary(
                  GetUsableModelsResponseSchema,
                  create(GetUsableModelsResponseSchema, {
                    models: discoveredModels.map((model) =>
                      create(ModelDetailsSchema, {
                        modelId: model.id,
                        displayModelId: model.id,
                        displayName: model.name,
                        displayNameShort: model.name,
                        aliases: [],
                      }),
                    ),
                  }),
                ),
              );
        stream.respond({
          ":status": 200,
          "content-type": "application/connect+proto",
        });
        stream.end(responseBody);
        return;
      }

      stream.respond({ ":status": 404 });
      stream.end();
    });
  });
  await new Promise<void>((resolve) =>
    apiServer.listen(0, "127.0.0.1", resolve),
  );
  const apiPort = (apiServer.address() as AddressInfo).port;

  return {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    refreshUrl: `http://127.0.0.1:${refreshPort}/auth/exchange_user_api_key`,
    setDiscoveryMode(mode) {
      discoveryMode = mode;
    },
    setDiscoveredModels(models) {
      discoveredModels = models;
    },
    setAvailableModels(models) {
      availableModels = models;
    },
    resetObservations() {
      discoveryAuthHeaders.length = 0;
      refreshAuthHeaders.length = 0;
    },
    getDiscoveryAuthHeaders() {
      return [...discoveryAuthHeaders];
    },
    getRefreshAuthHeaders() {
      return [...refreshAuthHeaders];
    },
    setRefreshResponseRefreshToken(value) {
      refreshResponseRefreshTokenOverride = value;
    },
    setRunMode(mode) {
      runMode = mode;
      runStallConsumed = false;
      runRequestCount = 0;
      runModelIds.length = 0;
      runUserTexts.length = 0;
      runSelections.length = 0;
    },
    getRunRequestCount() {
      return runRequestCount;
    },
    getRunUserTexts() {
      return [...runUserTexts];
    },
    getRunModelIds() {
      return [...runModelIds];
    },
    getRunSelections() {
      return runSelections.map((selection) => ({
        ...selection,
        parameters: { ...selection.parameters },
      }));
    },
    async close() {
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          apiServer.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          refreshServer.close((error) =>
            error ? reject(error) : resolve(),
          ),
        ),
      ]);
    },
  };
}
