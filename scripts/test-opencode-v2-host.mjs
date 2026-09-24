// Entirely offline: isolated beta host, synthetic tools and a loopback AgentService.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import http2 from "node:http2";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { create, fromBinary, fromJson, toBinary } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import * as p from "../dist/proto/agent_pb.js";
import { TurnUsageSchema } from "../dist/cursor-agent-usage.js";

const root = await mkdtemp(join(tmpdir(), "cursor-v2-host-test-"));
const project = join(root, "project");
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
const backend = http2.createServer();
const sessions = new Set();
backend.on("session", (session) => {
  sessions.add(session);
  session.on("error", () => {});
  session.on("close", () => sessions.delete(session));
});
const observations = [];
let backendFailure;
let phase = "tools";
let usageStage;
const aggregateUsage = {
  inputTokens: 1_356_511n,
  outputTokens: 185n,
  cacheReadTokens: 904_220n,
  cacheWriteTokens: 452_286n,
  reasoningTokens: 0n,
};
const endFrame = Buffer.from([2, 0, 0, 0, 2, 123, 125]);
const packet = (message) => {
  const bytes = toBinary(
    p.AgentServerMessageSchema,
    create(p.AgentServerMessageSchema, { message }),
  );
  const header = Buffer.alloc(5);
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
};
backend.on("stream", (stream, headers) => {
  stream.on("error", () => {});
  stream.respond({
    ":status": 200,
    "content-type": "application/connect+proto",
  });
  let pending = Buffer.alloc(0);
  let observation;
  stream.on("close", () => {
    if (observation) observation.closed = true;
  });
  const reads = new Map();
  const send = (message) => stream.write(packet(message));
  const finish = (text, contextTokens = 350, terminalUsage) => {
    if (contextTokens > 0)
      send({
        case: "conversationCheckpointUpdate",
        value: create(p.ConversationStateStructureSchema, {
          tokenDetails: create(p.ConversationTokenDetailsSchema, {
            usedTokens: contextTokens,
          }),
        }),
      });
    if (text === "COLD_REPLAY_OK")
      send({
        case: "interactionUpdate",
        value: create(p.InteractionUpdateSchema, {
          message: {
            case: "thinkingDelta",
            value: create(p.ThinkingDeltaUpdateSchema, {
              text: "Synthetic signed reasoning.",
            }),
          },
        }),
      });
    send({
      case: "interactionUpdate",
      value: create(p.InteractionUpdateSchema, {
        message: {
          case: "textDelta",
          value: create(p.TextDeltaUpdateSchema, { text }),
        },
      }),
    });
    send({
      case: "interactionUpdate",
      value: create(p.InteractionUpdateSchema, {
        message: {
          case: "tokenDelta",
          value: create(p.TokenDeltaUpdateSchema, { tokens: 40 }),
        },
      }),
    });
    send({
      case: "interactionUpdate",
      value: create(p.InteractionUpdateSchema, {
        message: {
          case: "turnEnded",
          value: fromBinary(
            p.TurnEndedUpdateSchema,
            toBinary(
              TurnUsageSchema,
              create(
                TurnUsageSchema,
                terminalUsage ?? {
                  inputTokens: BigInt(contextTokens),
                  outputTokens: 40n,
                  cacheReadTokens: 200n,
                  cacheWriteTokens: 50n,
                  reasoningTokens: 15n,
                },
              ),
            ),
          ),
        },
      }),
    });
    if (text === "COLD_REPLAY_OK") {
      send({
        case: "kvServerMessage",
        value: create(p.KvServerMessageSchema, {
          id: 9000,
          message: {
            case: "setBlobArgs",
            value: create(p.SetBlobArgsSchema, {
              blobId: new Uint8Array([9, 8, 7]),
              blobData: Buffer.from(
                JSON.stringify({
                  role: "assistant",
                  content: [
                    {
                      type: "redacted-reasoning",
                      data: "synthetic-opaque-before",
                    },
                    {
                      type: "reasoning",
                      text: "Synthetic signed reasoning.",
                      signature: "synthetic-signature",
                      providerOptions: {
                        cursor: { modelName: "fixture-composer-max" },
                      },
                    },
                    {
                      type: "redacted-reasoning",
                      data: "synthetic-opaque-after",
                    },
                    { type: "text", text: "COLD_REPLAY_OK" },
                  ],
                }),
              ),
            }),
          },
        }),
      });
    } else stream.end(endFrame);
  };
  const call = (id, name, args = {}) =>
    send({
      case: "execServerMessage",
      value: create(p.ExecServerMessageSchema, {
        id,
        execId: `exec-${id}`,
        message: {
          case: "mcpArgs",
          value: create(p.McpArgsSchema, {
            name,
            toolName: name,
            toolCallId: `upstream-${id}`,
            providerIdentifier: "opencode",
            args: Object.fromEntries(
              Object.entries(args).map(([key, value]) => [
                key,
                toBinary(ValueSchema, fromJson(ValueSchema, value)),
              ]),
            ),
          }),
        },
      }),
    });
  const afterRoots = () => {
    try {
      const transcript = JSON.stringify(observation.roots);
      if (transcript.includes("CURSOR_FIXTURE_COMPACTION"))
        observation.primary = false;
      if (observation.text?.startsWith("USAGE_SCOPE_ARCHIVE\n")) {
        observation.scenario = "usage-scope";
        return call(1, "boundary_a");
      }
      if (usageStage === "continue") {
        assert.equal(
          observation.primary,
          true,
          "Aggregate turn usage must not force compaction of a 452k context in a 1M model",
        );
        assert.match(observation.text, /Continue usage-scope session/);
        assert.match(transcript, /USAGE_SCOPE_ARCHIVE/);
        assert.match(transcript, /nonce-a-from-real-host-tool/);
        assert.match(transcript, /nonce-b-from-real-host-tool/);
        observation.usageContinuation = true;
        usageStage = undefined;
        return finish("USAGE_SCOPE_CONTINUED");
      }
      if (observation.text === "Seed automatic compaction.")
        return finish(
          `AUTO_COMPACTION_SEED\n${"Synthetic retained-history fixture. ".repeat(4000)}`,
        );
      if (observation.text === "Advance the compaction boundary.") {
        phase = "auto-compact-next";
        return finish("AUTO_COMPACTION_SPACER", 190_000);
      }
      if (phase === "auto-compact-next") {
        assert.equal(
          observation.primary,
          false,
          "Host must compact before dispatching the next primary request",
        );
        assert.match(transcript, /AUTO_COMPACTION_SEED/);
        observation.automaticCompaction = true;
        phase = "auto-compacted";
        return finish(
          "## Objective\nAUTO_COMPACTED_SUMMARY: the synthetic history was summarized by the host.",
        );
      }
      if (phase === "auto-compacted" && observation.primary) {
        assert.match(
          `${transcript}\n${observation.text}`,
          /AUTO_COMPACTED_SUMMARY/,
        );
        assert.match(
          observation.text,
          /Continue automatically compacted history/,
        );
        return finish("AUTO_COMPACTION_OK");
      }
      if (observation.text === "Steer while a tool runs.") {
        observation.scenario = "steer";
        return call(1, "shell", {
          command:
            "printf ready > steering-ready.txt\nsleep 2\nprintf checkpoint-nonce",
          workdir: project,
        });
      }
      if (observation.text === "New steering before model checkpoint.") {
        const outcome = observation.roots.find(
          (entry) => entry.role === "tool",
        );
        assert.match(JSON.stringify(outcome), /checkpoint-nonce/);
        assert.equal(outcome.content[0].isError, false);
        return finish("CHECKPOINT_STEERING_OK");
      }
      if (observation.text?.startsWith("Inspect attached image.")) {
        assert.equal(observation.images.length, 1);
        assert.equal(observation.images[0].mimeType, "image/png");
        assert.deepEqual(
          Buffer.from(observation.images[0].dataOrBlobId.value.data),
          image,
        );
        return finish("IMAGE_ATTACHMENT_OK");
      }
      if (observation.text === "Recall attached image.") {
        assert.equal(observation.images.length, 0);
        const previous = observation.roots.find(
          (entry) =>
            entry.role === "user" &&
            entry.content.some((part) => part.type === "image"),
        );
        assert.ok(
          previous.content.some((part) =>
            part.text?.startsWith("Inspect attached image."),
          ),
        );
        assert.equal(
          previous.content.find((part) => part.type === "image").image,
          `data:image/png;base64,${image.toString("base64")}`,
        );
        return finish("IMAGE_HISTORY_OK");
      }
      if (observation.text === "Read a tool image.") {
        observation.scenario = "tool-image";
        return call(1, "read", { path: join(project, "image.png") });
      }
      if (observation.images.length && /Read a tool image/.test(transcript)) {
        assert.equal(observation.images.length, 1);
        assert.ok(
          observation.roots.some(
            (entry) =>
              entry.role === "tool" &&
              entry.content.some(
                (part) =>
                  part.type === "tool-result" && part.toolName === "read",
              ),
          ),
        );
        assert.deepEqual(
          Buffer.from(observation.images[0].dataOrBlobId.value.data),
          image,
        );
        observation.toolImageReplay = true;
        return finish("TOOL_IMAGE_OK");
      }
      if (observation.text?.startsWith("Wait for permission")) {
        observation.scenario = "permission";
        return call(1, "read", { path: join(project, "ask.txt") });
      }
      if (observation.text === "Cancel the question.") {
        observation.scenario = "question";
        return call(1, "question", {
          questions: [
            {
              question: "Synthetic question",
              header: "Fixture",
              options: [{ label: "Continue", description: "Synthetic choice" }],
            },
          ],
        });
      }
      if (observation.text === "Interrupt a running side effect.") {
        observation.scenario = "interrupt";
        return call(1, "shell", {
          command:
            "printf started > interrupted-effect.txt\nsleep 30\nprintf finished >> interrupted-effect.txt",
          workdir: project,
        });
      }
      if (observation.text === "Replay interrupted side effect.") {
        assert.match(transcript, /"isError":true/);
        assert.match(transcript, /interrupted-effect/);
        assert.match(transcript, /\\"outcome\\":\\"error\\"/);
        return finish("INTERRUPTED_REPLAY_OK");
      }
      if (observation.text === "Reject invalid tool input.") {
        observation.scenario = "invalid-input";
        return call(1, "read", { path: 42 });
      }
      if (observation.text === "Forked steering.") {
        assert.match(transcript, /"signature":"synthetic-signature"/);
        const opaqueRoot = observation.roots.find(
          (entry) =>
            entry.role === "assistant" &&
            entry.content.some((part) => part.type === "redacted-reasoning"),
        );
        assert.ok(opaqueRoot);
        assert.deepEqual(
          opaqueRoot.content.map((part) => part.type),
          ["redacted-reasoning", "reasoning", "redacted-reasoning", "text"],
        );
        assert.equal(opaqueRoot.content[0].data, "synthetic-opaque-before");
        assert.equal(opaqueRoot.content[2].data, "synthetic-opaque-after");
        assert.doesNotMatch(transcript, /opaqueReasoning/);
        assert.match(transcript, /COLD_REPLAY_OK/);
        assert.match(transcript, /nonce-a-from-real-host-tool/);
        observation.reasoningReplay = true;
        return finish("FORK_REPLAY_OK");
      }
      if (phase === "compacting") {
        // Compaction now receives structured history and the host's summary prompt.
        assert.equal(observation.primary, false);
        assert.match(transcript, /nonce-a-from-real-host-tool/);
        assert.match(transcript, /Permission denied: read/);
        assert.match(transcript, /"isError":true/);
        observation.compaction = true;
        phase = "compacted";
        return finish(
          "## Objective\nCOMPACTED_FIXTURE_SUMMARY: two successful tools, a failed read, and confirmed cold replay.",
        );
      }
      if (phase === "compacted" && observation.primary) {
        assert.match(transcript, /COMPACTED_FIXTURE_SUMMARY/);
        return finish("AFTER_COMPACTION_OK");
      }
      if (!observation.primary) return finish("Synthetic title");
      if (phase === "tools") {
        phase = "waiting";
        call(1, "boundary_a");
        // Beyond the old one-second window: A cannot finish until B starts.
        setTimeout(() => {
          if (!stream.destroyed) call(2, "boundary_b");
        }, 1500);
      } else if (phase === "replay") {
        assert.match(transcript, /nonce-a-from-real-host-tool/);
        assert.match(transcript, /nonce-b-from-real-host-tool/);
        assert.match(transcript, /tool-result/);
        assert.match(transcript, /"isError":true/);
        assert.equal(
          observation.text,
          "Steering after lease loss: confirm the real outcomes.",
        );
        finish("COLD_REPLAY_OK");
      } else throw new Error(`Unexpected fresh primary Run in phase ${phase}`);
    } catch (error) {
      backendFailure = error;
      stream.close();
    }
  };
  stream.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const size = pending.readUInt32BE(1);
      if (pending.length < 5 + size) break;
      const bytes = pending.subarray(5, 5 + size);
      pending = pending.subarray(5 + size);
      try {
        const { message } = fromBinary(p.AgentClientMessageSchema, bytes);
        if (message.case === "runRequest") {
          const request = message.value;
          const action = request.action?.action;
          const names =
            request.mcpTools?.mcpTools.map((tool) => tool.name) ?? [];
          observation = {
            primary: names.includes("boundary_a"),
            tools: names,
            roots: [],
            results: [],
            images:
              action?.case === "userMessageAction"
                ? (action.value.userMessage?.selectedContext?.selectedImages ??
                  [])
                : [],
            text:
              action?.case === "userMessageAction"
                ? action.value.userMessage?.text
                : undefined,
          };
          observations.push(observation);
          assert.equal(headers.authorization, "Bearer synthetic-cursor-token");
          assert.equal(
            headers["x-cursor-agent-allowed-tools"],
            names.length
              ? "mcp_tool_call,get_mcp_tools_tool_call,list_mcp_resources_tool_call,read_mcp_resource_tool_call,mcp_auth_tool_call"
              : "",
          );
          assert.equal(request.modelDetails?.modelId, "fixture-composer-max");
          assert.equal(request.requestedModel?.modelId, "fixture-composer");
          assert.equal(request.requestedModel?.maxMode, true);
          assert.deepEqual(
            request.requestedModel?.parameters.map(({ id, value }) => ({
              id,
              value,
            })),
            [{ id: "effort", value: "max" }],
          );
          const roots = request.conversationState?.rootPromptMessagesJson ?? [];
          roots.forEach((blobId, index) => {
            reads.set(index + 1000, index);
            send({
              case: "kvServerMessage",
              value: create(p.KvServerMessageSchema, {
                id: index + 1000,
                message: {
                  case: "getBlobArgs",
                  value: create(p.GetBlobArgsSchema, { blobId }),
                },
              }),
            });
          });
          if (!reads.size) afterRoots();
        } else if (message.case === "kvClientMessage") {
          const reply = message.value;
          if (reply.id === 9000) {
            assert.equal(reply.message.case, "setBlobResult");
            send({
              case: "conversationCheckpointUpdate",
              value: create(p.ConversationStateStructureSchema, {
                rootPromptMessagesJson: [new Uint8Array([9, 8, 7])],
              }),
            });
            stream.end(endFrame);
            continue;
          }
          assert.equal(reply.message.case, "getBlobResult");
          const index = reads.get(reply.id);
          assert.notEqual(index, undefined);
          observation.roots[index] = JSON.parse(
            Buffer.from(reply.message.value.blobData).toString(),
          );
          reads.delete(reply.id);
          if (!reads.size) afterRoots();
        } else if (
          message.case === "execClientMessage" &&
          message.value.message.case === "mcpResult"
        ) {
          const result = message.value.message.value.result;
          assert.equal(result.case, "success");
          const text = result.value.content
            .map((item) =>
              item.content.case === "text" ? item.content.value.text : "",
            )
            .join("");
          observation.results.push({
            id: message.value.id,
            error: result.value.isError,
            body: JSON.parse(text),
          });
          if (observation.scenario === "usage-scope") {
            assert.equal(result.value.isError, false);
            if (observation.results.length === 1) call(2, "boundary_b");
            else {
              assert.deepEqual(
                observation.results.map((item) => item.body.output),
                ["nonce-a-from-real-host-tool", "nonce-b-from-real-host-tool"],
              );
              send({
                case: "conversationCheckpointUpdate",
                value: create(p.ConversationStateStructureSchema, {
                  tokenDetails: create(p.ConversationTokenDetailsSchema, {
                    usedTokens: 452_300,
                  }),
                }),
              });
              usageStage = "continue";
              finish("USAGE_SCOPE_DONE", 0, aggregateUsage);
            }
            continue;
          }
          if (observation.scenario === "invalid-input") {
            assert.equal(result.value.isError, true);
            assert.equal(JSON.parse(text).outcome, "error");
            finish("INVALID_INPUT_OK");
            continue;
          }
          assert.equal(
            observation.scenario,
            undefined,
            "Cancelled work must not be forwarded as a result",
          );
          if (observation.results.length === 2) {
            assert.deepEqual(
              observation.results.map((item) => item.body.output).sort(),
              ["nonce-a-from-real-host-tool", "nonce-b-from-real-host-tool"],
            );
            assert.ok(observation.tools.includes("read"));
            call(3, "read", { path: join(project, "denied.txt") });
          } else if (observation.results.length === 3) {
            assert.equal(result.value.isError, true);
            assert.equal(JSON.parse(text).outcome, "error");
            phase = "replay";
            // Deliberately lose the lease after receiving real outcomes. No fake
            // result or count-based shortcut can satisfy the subsequent root reads.
            stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
          }
        }
      } catch (error) {
        backendFailure = error;
        stream.close();
      }
    }
  });
});

let child;
let output = "";
try {
  await mkdir(join(project, ".opencode"), { recursive: true });
  const pluginDirectory = join(project, "fixture-plugin");
  await mkdir(pluginDirectory);
  await writeFile(
    join(pluginDirectory, "index.ts"),
    `export { default } from ${JSON.stringify(pathToFileURL(resolve("test/fixtures/v2-host-plugin.ts")).href)};\n`,
  );
  await writeFile(
    join(project, "denied.txt"),
    "This file must never be read by the model.",
  );
  await writeFile(join(project, "ask.txt"), "This file requires permission.");
  await writeFile(join(project, "image.png"), image);
  await writeFile(
    join(project, ".opencode/opencode.json"),
    JSON.stringify({
      plugins: [pluginDirectory],
      model: "cursor/fixture-composer",
      snapshots: false,
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "read", resource: "*denied.txt", effect: "deny" },
        { action: "read", resource: "*ask.txt", effect: "ask" },
      ],
    }),
  );
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const launchHost = () => {
    child = spawn(
      process.env.OPENCODE_CURSOR_HOST_BINARY ??
        resolve("node_modules/@opencode/cli/bin/opencode.exe"),
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: project,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "data"),
          XDG_CACHE_HOME: join(root, "cache"),
          OPENCODE_DB: join(root, "host.db"),
          OPENCODE_CONFIG_DIR: join(project, ".opencode"),
          OPENCODE_SERVER_PASSWORD: "synthetic-host-password",
          CURSOR_API_URL: `http://127.0.0.1:${backend.address().port}`,
          OPENCODE_CURSOR_PRE_OUTPUT_STALL_TIMEOUT_MS: "5000",
          OPENCODE_CURSOR_STALL_TIMEOUT_MS: "400",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-16000);
    });
    child.stderr.on("data", (chunk) => {
      output = (output + chunk).slice(-16000);
    });
  };
  launchHost();
  const exportPath = (sessionPath) =>
    `/api/experimental/session/${sessionPath.split("/").at(-1)}/export`;
  const request = async (path, body, method = body ? "POST" : "GET") => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from("opencode:synthetic-host-password").toString("base64")}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.status === 204 ? undefined : response.json();
  };
  const until = async (check, label) => {
    for (let i = 0; i < 120; i++) {
      if (backendFailure) throw backendFailure;
      if (await check()) return;
      if (child.exitCode !== null) throw new Error("Host exited");
      await delay(100);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const hostReady = () =>
    until(async () => {
      try {
        return (await request("/api/plugin")).data?.some(
          (item) =>
            item.id === "test.cursor-host-boundary" && item.state.status === "active",
        );
      } catch {
        return false;
      }
    }, "fixture plugin loading");
  await hostReady();
  const { data: session } = await request("/api/session", {
    title: "Offline Cursor host test",
    model: { providerID: "cursor", id: "fixture-composer" },
  });
  const sessionPath = `/api/session/${session.id}`;
  await request(`${sessionPath}/prompt`, {
    text: "Execute the synthetic tool sequence.",
  });
  await until(async () => {
    const exported = (await request(exportPath(sessionPath))).data;
    const tools = exported.messages.flatMap((message) =>
      message.type === "assistant"
        ? message.content.filter((part) => part.type === "tool")
        : [],
    );
    return (
      tools.some(
        (tool) => tool.name === "read" && tool.state?.status === "error",
      ) || phase === "replay"
    );
  }, "real host tools and permission denial");
  // A configured denial may interrupt the host step. Explicit user steering is
  // what authorizes continuation; it must be present in the fresh Run's action.
  await until(
    async () =>
      !Object.hasOwn((await request("/api/session/active")).data, session.id),
    "host step completion",
  );
  await request(`${sessionPath}/prompt`, {
    text: "Steering after lease loss: confirm the real outcomes.",
  });
  await until(async () => {
    const exported = (await request(exportPath(sessionPath))).data;
    return exported.messages.some(
      (message) =>
        message.type === "assistant" &&
        message.content.some(
          (part) =>
            part.type === "text" && part.text.includes("COLD_REPLAY_OK"),
        ),
    );
  }, "cold reconstruction");
  await until(
    async () =>
      !Object.hasOwn((await request("/api/session/active")).data, session.id),
    "final persisted completion",
  );
  const exported = (await request(exportPath(sessionPath))).data;
  assert.equal(exported.info.outcome, "succeeded");
  assert.ok(
    exported.messages.some(
      (message) =>
        message.type === "assistant" &&
        message.finish === "stop" &&
        message.content.some(
          (part) =>
            part.type === "text" && part.text.includes("COLD_REPLAY_OK"),
        ),
    ),
  );
  const tools = exported.messages.flatMap((message) =>
    message.type === "assistant"
      ? message.content.filter((part) => part.type === "tool")
      : [],
  );
  assert.equal(tools.length, 3);
  assert.equal(
    tools.filter((tool) => tool.state.status === "completed").length,
    2,
  );
  assert.equal(tools.filter((tool) => tool.state.status === "error").length, 1);
  const primary = observations.filter((item) => item.primary);
  assert.equal(primary.length, 2);
  assert.ok(primary[1].roots.some((entry) => entry.role === "tool"));
  const final = exported.messages.find(
    (message) =>
      message.finish === "stop" &&
      message.content.some((part) => part.text === "COLD_REPLAY_OK"),
  );
  assert.deepEqual(final.tokens, {
    input: 350,
    output: 40,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  });
  assert.deepEqual(final.providerState?.turnUsage, {
    input: 350,
    output: 40,
    cacheRead: 200,
    cacheWrite: 50,
    reasoning: 15,
  });

  const idle = (path) =>
    until(
      async () =>
        !Object.hasOwn(
          (await request("/api/session/active")).data,
          path.split("/").at(-1),
        ),
      "session idle",
    );
  const start = async (text, files, modelID = "fixture-composer") => {
    const { data } = await request("/api/session", {
      title: "Offline boundary case",
      model: { providerID: "cursor", id: modelID },
    });
    const path = `/api/session/${data.id}`;
    await request(`${path}/prompt`, { text, files });
    return path;
  };
  const toolParts = async (path) =>
    (await request(exportPath(path))).data.messages.flatMap((message) =>
      message.type === "assistant"
        ? message.content.filter((part) => part.type === "tool")
        : [],
    );

  for (const action of ["rejection", "interruption"]) {
    const text = `Wait for permission ${action}.`;
    const path = await start(text);
    let permission;
    await until(async () => {
      permission = (await request(`${path}/permission`)).data[0];
      return permission;
    }, "permission request");
    await delay(600); // Longer than the model-output watchdog: the host owns this wait.
    const run = observations.find((item) => item.text === text);
    assert.equal(run.closed, undefined);
    if (action === "rejection")
      await request(`${path}/permission/${permission.id}/reply`, {
        decision: "reject",
      });
    else await request(`${path}/interrupt`, { resume: false });
    await idle(path);
    await until(() => run.closed, "cancelled Cursor Run cleanup");
    assert.equal(run.results.length, 0);
    assert.equal((await toolParts(path))[0].state.status, "error");
  }

  const questionPath = await start("Cancel the question.");
  let form;
  await until(async () => {
    form = (await request(`${questionPath}/form`)).data[0];
    return form;
  }, "host question form");
  await request(`${questionPath}/form/${form.id}`, undefined, "DELETE");
  await idle(questionPath);
  assert.equal((await toolParts(questionPath))[0].state.status, "error");
  assert.equal(
    observations.find((item) => item.scenario === "question").results.length,
    0,
  );

  const interruptedPath = await start("Interrupt a running side effect.");
  await until(async () => {
    try {
      return (
        (await readFile(join(project, "interrupted-effect.txt"), "utf8")) ===
        "started"
      );
    } catch {
      return false;
    }
  }, "real side effect before interruption");
  await request(`${interruptedPath}/interrupt`, { resume: false });
  await idle(interruptedPath);
  assert.equal((await toolParts(interruptedPath))[0].state.status, "error");
  assert.equal(
    await readFile(join(project, "interrupted-effect.txt"), "utf8"),
    "started",
  );
  assert.equal(
    observations.find((item) => item.scenario === "interrupt").results.length,
    0,
  );
  await request(`${interruptedPath}/prompt`, {
    text: "Replay interrupted side effect.",
  });
  await idle(interruptedPath);
  assert.equal(
    (await request(exportPath(interruptedPath))).data.info.outcome,
    "succeeded",
  );

  const invalidPath = await start("Reject invalid tool input.");
  await idle(invalidPath);
  assert.equal((await toolParts(invalidPath))[0].state.status, "error");
  assert.equal(
    (await request(exportPath(invalidPath))).data.info.outcome,
    "succeeded",
  );

  const steeredPath = await start("Steer while a tool runs.");
  await until(async () => {
    try {
      return (
        (await readFile(join(project, "steering-ready.txt"), "utf8")) ===
        "ready"
      );
    } catch {
      return false;
    }
  }, "real tool started before steering");
  await request(`${steeredPath}/prompt`, {
    text: "New steering before model checkpoint.",
    delivery: "steer",
  });
  await idle(steeredPath);
  assert.equal(
    observations.find((item) => item.scenario === "steer").results.length,
    0,
  );
  assert.equal(
    (await request(exportPath(steeredPath))).data.info.outcome,
    "succeeded",
  );

  const imagePath = await start("Inspect attached image.", [
    { uri: pathToFileURL(join(project, "image.png")).href },
  ]);
  await idle(imagePath);
  await request(`${imagePath}/prompt`, { text: "Recall attached image." });
  await idle(imagePath);
  assert.equal(
    (await request(exportPath(imagePath))).data.info.outcome,
    "succeeded",
  );
  const toolImagePath = await start("Read a tool image.");
  await idle(toolImagePath);
  assert.equal((await toolParts(toolImagePath))[0].state.status, "completed");
  assert.ok(observations.some((item) => item.toolImageReplay));
  assert.equal(
    (await request(exportPath(toolImagePath))).data.info.outcome,
    "succeeded",
  );

  const { data: fork } = await request(`${sessionPath}/fork`, {});
  const forkPath = `/api/session/${fork.id}`;
  await request(`${forkPath}/prompt`, { text: "Forked steering." });
  await idle(forkPath);
  assert.equal(
    (await request(exportPath(forkPath))).data.info.outcome,
    "succeeded",
  );
  assert.deepEqual(
    (await request(exportPath(sessionPath))).data.messages,
    exported.messages,
  );

  phase = "compacting";
  await request(`${sessionPath}/compact`, {});
  await idle(sessionPath);
  await request(`${sessionPath}/prompt`, {
    text: "Continue after compaction.",
  });
  await idle(sessionPath);
  assert.ok(observations.some((item) => item.compaction));
  assert.equal(
    (await request(exportPath(sessionPath))).data.info.outcome,
    "succeeded",
  );

  const usagePath = await start(
    "USAGE_SCOPE_ARCHIVE\n" +
      Array.from(
        { length: 18000 },
        (_, i) =>
          `${String(i).padStart(6, "0")}: amber birch cedar delta elm fern grove hazel iris jade kelp lilac maple oak pine reed`,
      ).join("\n"),
    undefined,
    "fixture-composer-large",
  );
  await idle(usagePath);
  await request(`${usagePath}/prompt`, {
    text: "Continue usage-scope session.",
  });
  await idle(usagePath);
  const usageExport = (await request(exportPath(usagePath))).data;
  assert.equal(usageExport.info.outcome, "succeeded");
  assert.equal(
    usageExport.messages.filter((message) => message.type === "compaction")
      .length,
    0,
  );
  assert.ok(observations.some((item) => item.usageContinuation));
  const turn = usageExport.messages.find(
    (message) =>
      message.type === "assistant" &&
      message.content.some(
        (part) => part.type === "text" && part.text === "USAGE_SCOPE_DONE",
      ),
  );
  assert.ok(turn);
  assert.deepEqual(turn.providerState?.turnUsage, {
    input: 1_356_511,
    output: 185,
    cacheRead: 904_220,
    cacheWrite: 452_286,
    reasoning: 0,
  });

  const autoPath = await start("Seed automatic compaction.");
  await idle(autoPath);
  await request(`${autoPath}/prompt`, {
    text: "Advance the compaction boundary.",
  });
  await idle(autoPath);
  await request(`${autoPath}/prompt`, {
    text: "Continue automatically compacted history.",
  });
  await idle(autoPath);
  assert.ok(observations.some((item) => item.automaticCompaction));
  assert.equal(
    (await request(exportPath(autoPath))).data.info.outcome,
    "succeeded",
  );
  const beforeRestart = (await request(exportPath(forkPath))).data;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(killTimer);
  launchHost();
  await hostReady();
  assert.deepEqual(
    (await request(exportPath(forkPath))).data.messages,
    beforeRestart.messages,
  );
  phase = "restarted";
  await request(`${forkPath}/prompt`, { text: "Forked steering." });
  await idle(forkPath);
  assert.equal(
    (await request(exportPath(forkPath))).data.info.outcome,
    "succeeded",
  );
  assert.equal(observations.filter((item) => item.reasoningReplay).length, 2);
  console.log(
    "OpenCode host acceptance passed: delayed parallel tools, permission waits/rejection, question dismissal, interrupted side effects, checkpoint steering, invalid input, usage, images, forks, signed/opaque reasoning restart replay, manual/automatic compaction, cold replay, and graceful completion.",
  );
} catch (error) {
  console.error(String(error).replaceAll(root, "<fixture>").slice(0, 2000));
  console.error(output.replaceAll(root, "<fixture>"));
  console.error(
    JSON.stringify(
      observations.map(({ primary, tools, results, text, roots }) => ({
        primary,
        tools,
        results,
        text: text?.slice(0, 1000),
        rootRoles: roots.map((entry) => entry.role),
      })),
    ).replaceAll(root, "<fixture>"),
  );
  for (const name of await readdir(root, { recursive: true })) {
    if (!name.endsWith(".log")) continue;
    const text = await readFile(join(root, name), "utf8");
    console.error(
      text
        .split("\n")
        .filter((line) => /ERROR/.test(line))
        .map((line) => line.replaceAll(root, "<fixture>"))
        .join("\n"),
    );
  }
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
  for (const session of sessions) session.destroy();
  await new Promise((resolve) => backend.close(resolve));
  await rm(root, { recursive: true, force: true });
}
