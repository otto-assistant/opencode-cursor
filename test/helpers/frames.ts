import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentServerMessageSchema,
  HeartbeatUpdateSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
} from "../../src/proto/agent_pb";

export function frameConnectUnaryMessage(payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

/** Cursor heartbeat interaction update — keeps the stream alive with no content. */
export function frameHeartbeatServerMessage(): Buffer {
  const payload = toBinary(
    AgentServerMessageSchema,
    create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: {
            case: "heartbeat",
            value: create(HeartbeatUpdateSchema, {}),
          },
        }),
      },
    }),
  );
  return frameConnectUnaryMessage(payload);
}

/** Minimal assistant text + turn_ended so the proxy finishes without empty-stream retries. */
export function frameTextThenEndServerMessages(text: string): Buffer[] {
  const textPayload = toBinary(
    AgentServerMessageSchema,
    create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: {
            case: "textDelta",
            value: create(TextDeltaUpdateSchema, { text }),
          },
        }),
      },
    }),
  );
  const endPayload = toBinary(
    AgentServerMessageSchema,
    create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: {
            case: "turnEnded",
            value: create(TurnEndedUpdateSchema, {}),
          },
        }),
      },
    }),
  );
  return [
    frameConnectUnaryMessage(textPayload),
    frameConnectUnaryMessage(endPayload),
  ];
}
