// Tests the opt-in runner against a local backend and a real isolated host.
// It never reads an account, sends a live Run, or validates model quality.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, fromJson, toBinary } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import * as p from "../dist/proto/agent_pb.js";
import { TurnUsageSchema } from "../dist/cursor-agent-usage.js";

const frame = (bytes, flag = 0) => {
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
};
const root = await mkdtemp(join(tmpdir(), "cursor-probe-test-"));
const server = http2.createServer();
const connections = new Set();
let scenario;
let admitted = 0;
let backendError;
let originalNonce;
server.on("session", (session) => {
  connections.add(session);
  session.on("error", () => {});
  session.on("close", () => connections.delete(session));
});
server.on("stream", (stream, headers) => {
  stream.on("error", () => {});
  stream.respond({
    ":status": 200,
    "content-type": "application/connect+proto",
  });
  let pending = Buffer.alloc(0);
  let run;
  let ordinal;
  const roots = [];
  const outstanding = new Set();
  const send = (message) =>
    stream.write(
      frame(
        toBinary(
          p.AgentServerMessageSchema,
          create(p.AgentServerMessageSchema, { message }),
        ),
      ),
    );
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
            toolCallId: `test-${id}`,
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
  const finish = (text, aggregate = false) => {
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
      case: "conversationCheckpointUpdate",
      value: create(p.ConversationStateStructureSchema, {
        tokenDetails: create(p.ConversationTokenDetailsSchema, {
          usedTokens: ordinal === 1 ? 452300 : ordinal === 2 ? 985300 : 4000,
        }),
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
              create(TurnUsageSchema, {
                inputTokens: aggregate
                  ? 1356511n
                  : ordinal === 2
                    ? 985000n
                    : 350n,
                outputTokens: 185n,
                cacheReadTokens: aggregate ? 904220n : 200n,
                cacheWriteTokens: aggregate ? 452286n : 50n,
                reasoningTokens: 0n,
              }),
            ),
          ),
        },
      }),
    });
    stream.end(frame(Buffer.from("{}"), 2));
  };
  const ready = () => {
    if (ordinal === 1) return call(1, "acceptance_read");
    if (ordinal === 2) {
      assert.equal(run.mcpTools.mcpTools.length, 0);
      assert.match(JSON.stringify(roots), /amber birch cedar/);
      assert.match(
        run.action.action.value.userMessage.text,
        /CONTINUE_SUSTAINED/,
      );
      return finish("CURSOR_HOST_CANARY_OK");
    }
    if (ordinal === 3) {
      assert.equal(run.mcpTools.mcpTools.length, 0);
      assert.match(
        JSON.stringify(roots),
        /amber birch cedar/,
      );
      return finish(
        `## Objective\nSYNTHETIC_COMPACTED_SUMMARY: The genuine read and confirmation succeeded. Original nonce: ${originalNonce}. Use it for the later acceptance_continue tool.`,
      );
    }
    assert.equal(ordinal, 4);
    assert.match(
      JSON.stringify(roots) + run.action.action.value.userMessage.text,
      /SYNTHETIC_COMPACTED_SUMMARY/,
    );
    assert.match(
      run.action.action.value.userMessage.text,
      /CONTINUE_SUSTAINED/,
    );
    assert.deepEqual(
      run.mcpTools.mcpTools.map((tool) => tool.name),
      ["acceptance_continue"],
    );
    const history =
      JSON.stringify(roots) + run.action.action.value.userMessage.text;
    const nonce = /Original nonce: ([\w-]+)\./.exec(history)?.[1];
    assert.equal(nonce, originalNonce);
    call(3, "acceptance_continue", { nonce });
  };
  stream.on("data", (chunk) => {
    try {
      pending = Buffer.concat([pending, chunk]);
      while (
        pending.length >= 5 &&
        pending.length >= 5 + pending.readUInt32BE(1)
      ) {
        const length = pending.readUInt32BE(1);
        const { message } = fromBinary(
          p.AgentClientMessageSchema,
          pending.subarray(5, 5 + length),
        );
        pending = pending.subarray(5 + length);
        if (message.case === "runRequest") {
          assert.equal(headers.authorization, "Bearer synthetic-cursor-token");
          run = message.value;
          ordinal = ++admitted;
          if (
            scenario === "system-override-composer" ||
            scenario === "system-sdk-composer"
          ) {
            assert.match(run.customSystemPrompt, /CURSOR_HOST_CANARY_OK/);
            assert.equal(
              headers["x-cursor-client-type"],
              scenario === "system-sdk-composer" ? "sdk" : "cli",
            );
            if (scenario === "system-sdk-composer")
              assert.equal(headers["x-cursor-client-version"], "sdk-1.0.31");
            const message =
              scenario === "system-sdk-composer"
                ? "Synthetic fixture: system prompt override is not enabled for this account."
                : "Synthetic fixture: unknown option '--system-prompt'";
            stream.end(
              frame(
                Buffer.from(
                  JSON.stringify({
                    error: { code: "invalid_argument", message },
                  }),
                ),
                2,
              ),
            );
            continue;
          }
          run.conversationState.rootPromptMessagesJson.forEach((blobId, id) => {
            outstanding.add(id);
            send({
              case: "kvServerMessage",
              value: create(p.KvServerMessageSchema, {
                id,
                message: {
                  case: "getBlobArgs",
                  value: create(p.GetBlobArgsSchema, { blobId }),
                },
              }),
            });
          });
          if (!outstanding.size) ready();
        } else if (message.case === "kvClientMessage") {
          assert.equal(message.value.message.case, "getBlobResult");
          roots.push(
            JSON.parse(
              Buffer.from(message.value.message.value.blobData).toString(),
            ),
          );
          outstanding.delete(message.value.id);
          if (!outstanding.size) ready();
        } else if (
          message.case === "execClientMessage" &&
          message.value.message.case === "mcpResult"
        ) {
          const result = message.value.message.value.result;
          assert.equal(result.case, "success");
          assert.equal(result.value.isError, false);
          const outcome = JSON.parse(
            result.value.content[0].content.value.text,
          );
          assert.equal(outcome.outcome, "success");
          if (message.value.id === 1) {
            originalNonce = outcome.output;
            call(2, "acceptance_confirm", { nonce: outcome.output });
          } else {
            assert.equal(
              outcome.output,
              ordinal === 4
                ? "HOST_CONTINUATION_CONFIRMED"
                : "HOST_NONCE_CONFIRMED",
            );
            finish("CURSOR_HOST_CANARY_OK", true);
          }
        }
      }
    } catch (error) {
      backendError = error;
      stream.close();
    }
  });
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  for (const name of [
    "system-override-composer",
    "system-sdk-composer",
    "sustained-opus",
  ]) {
    scenario = name;
    admitted = 0;
    const id =
      name === "sustained-opus"
        ? "claude-opus-4-6-1m-thinking"
        : "composer-2.5";
    const selection = {
      publicId: id,
      modelId: id,
      displayName: "Synthetic fixture",
      maxMode: name === "sustained-opus",
      parameters: [],
    };
    await writeFile(
      join(root, "models.json"),
      JSON.stringify([
        {
          id,
          name: selection.displayName,
          contextWindow: 1000000,
          maxTokens: 64000,
          reasoning: true,
          defaultSelection: selection,
          variants: { max: selection },
        },
      ]),
    );
    await writeFile(
      join(root, "budget.json"),
      JSON.stringify({
        authorizedNewRuns: 4,
        usedNewRuns: 0,
        spendingAllowanceUSD: 28,
        reservedOrReportedUSD: 0,
      }),
    );
    const reportPath = join(root, `${name}.ndjson`);
    const historyPath = join(root, `${name}.json`);
    const env = { ...process.env };
    delete env.CURSOR_ACCESS_TOKEN;
    const child = spawn(
      process.execPath,
      [
        "scripts/probe-opencode-v2-host.mjs",
        "--offline-backend",
        `http://127.0.0.1:${server.address().port}`,
        "--case",
        name,
        "--models",
        join(root, "models.json"),
        "--budget",
        join(root, "budget.json"),
        "--report",
        reportPath,
        "--history",
        historyPath,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 60000);
    const [code] = await once(child, "exit");
    clearTimeout(timeout);
    if (backendError) throw backendError;
    const report = JSON.parse(
      (await readFile(reportPath, "utf8")).trim().split("\n").at(-1),
    );
    assert.equal(report.mode, "offline");
    if (name !== "sustained-opus") {
      assert.equal(code, 1, output.slice(-2000));
      assert.equal(
        report.runs[0].systemOverrideError,
        name === "system-sdk-composer"
          ? "access-message"
          : "unsupported-option",
      );
      assert.equal(
        report.runs[0].clientType,
        name === "system-sdk-composer" ? "sdk" : "cli",
      );
      assert.match(report.runs[0].connectDiagnostic, /Synthetic fixture/);
      assert.equal(report.hostOutcome, "failed", JSON.stringify({
        failure: report.failure,
        hostError: report.hostError,
        failureSnapshot: report.failureSnapshot,
      }));
      assert.equal(report.pass, false);
    } else {
      assert.equal(code, 0, output.slice(-2000));
      assert.equal(report.pass, true);
      assert.equal(admitted, 4);
      assert.ok(
        report.compactions.some(
          (item) => item.reason === "auto" && item.status === "completed",
        ),
      );
      assert.equal(report.followupMarker, true);
      assert.equal(report.postCompactionWork, true);
      assert.equal(report.host.continuations, 1);
    }
    assert.ok(JSON.parse(await readFile(historyPath, "utf8")).messages.length);
    console.log(`Offline acceptance runner verified: ${name}`);
  }
} finally {
  for (const session of connections) session.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
