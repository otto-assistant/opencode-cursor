import { Credential, Integration, Plugin } from "@opencode-ai/plugin";
import {
  getPendingCursorLogin,
  startCursorBrowserLogin,
} from "./auth-login.js";
import { refreshCursorToken } from "../auth.js";

export const CURSOR_INTEGRATION_ID = "cursor";
export const CURSOR_OAUTH_METHOD_ID =
  Integration.MethodID.make("browser");

type IntegrationContext = Pick<Plugin.Context, "integration">;
export interface DisposableRegistration {
  dispose(): Promise<void>;
}

export async function registerCursorIntegration(
  context: IntegrationContext,
): Promise<DisposableRegistration> {
  return context.integration.transform((draft) => {
    draft.update(CURSOR_INTEGRATION_ID, (integration) => {
      integration.name = "Cursor";
    });
    draft.method.update({
      integrationID: CURSOR_INTEGRATION_ID,
      method: {
        id: CURSOR_OAUTH_METHOD_ID,
        type: "oauth",
        label: "Sign in with Cursor",
      },
      authorize: async () => {
        const existing = getPendingCursorLogin();
        const pending =
          existing && !existing.completed
            ? existing
            : await startCursorBrowserLogin();
        return {
          mode: "auto",
          url: pending.url,
          instructions:
            "Open the URL in your browser and approve access to Cursor.",
          expiresAt: pending.startedAt + 15 * 60 * 1000,
          callback: pending.result.then((result) =>
            Credential.OAuth.make({
              type: "oauth",
              methodID: CURSOR_OAUTH_METHOD_ID,
              access: result.access,
              refresh: result.refresh,
              expires: result.expires,
            }),
          ),
        };
      },
      refresh: async (credential) => {
        const refreshed = await refreshCursorToken(credential.refresh);
        return Credential.OAuth.make({
          ...credential,
          type: "oauth",
          methodID: CURSOR_OAUTH_METHOD_ID,
          access: refreshed.access,
          refresh: refreshed.refresh,
          expires: refreshed.expires,
        });
      },
    });
  });
}

export async function resolveCursorCredential(
  context: IntegrationContext,
): Promise<Credential.OAuth | undefined> {
  const connection = await context.integration.connection.active(
    CURSOR_INTEGRATION_ID,
  );
  if (!connection) return undefined;
  const credential =
    await context.integration.connection.resolve(connection);
  if (
    credential?.type !== "oauth" ||
    credential.methodID !== CURSOR_OAUTH_METHOD_ID
  ) {
    return undefined;
  }
  return credential;
}

export function createCursorAccessTokenProvider(
  context: IntegrationContext,
): () => Promise<string> {
  return async () => {
    const credential = await resolveCursorCredential(context);
    if (!credential?.access) {
      throw new Error("Cursor OAuth connection is not configured");
    }
    return credential.access;
  };
}
