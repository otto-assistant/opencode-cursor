import type { Plugin } from "@opencode-ai/plugin";
import { RefreshTokenInvalidError } from "../auth.js";
import { clearModelCache, getCursorModels } from "../models.js";
import { log } from "../shared/log.js";
import { startCursorTransport, stopCursorTransport } from "../cursor-agent.js";
import {
  createCursorCatalogState,
  registerCursorCatalog,
  type CursorCatalogState,
  updateCursorCatalogState,
} from "./catalog.js";
import {
  createCursorAccessTokenProvider,
  CURSOR_INTEGRATION_ID,
  registerCursorIntegration,
  resolveCursorCredential,
} from "./integration.js";
import { registerCursorLanguage } from "./language.js";
import { resetPendingCursorLogin } from "./auth-login.js";

export type CursorPluginSetup = (
  context: Plugin.Context,
) => Promise<Plugin.Cleanup | void>;

export interface CursorRuntimeServices {
  registerIntegration: typeof registerCursorIntegration;
  registerCatalog: typeof registerCursorCatalog;
  registerLanguage: typeof registerCursorLanguage;
  createAccessTokenProvider: typeof createCursorAccessTokenProvider;
  resolveCredential: typeof resolveCursorCredential;
  getModels: typeof getCursorModels;
  startTransport: typeof startCursorTransport;
  stopTransport: typeof stopCursorTransport;
  resetLogin: typeof resetPendingCursorLogin;
  clearModelCache: typeof clearModelCache;
  sleep: (milliseconds: number) => Promise<void>;
}

const defaultServices: CursorRuntimeServices = {
  registerIntegration: registerCursorIntegration,
  registerCatalog: registerCursorCatalog,
  registerLanguage: registerCursorLanguage,
  createAccessTokenProvider: createCursorAccessTokenProvider,
  resolveCredential: resolveCursorCredential,
  getModels: getCursorModels,
  startTransport: startCursorTransport,
  stopTransport: stopCursorTransport,
  resetLogin: resetPendingCursorLogin,
  clearModelCache,
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

type Cleanup = () => Promise<void> | void;

export function createCursorRuntime(
  services: CursorRuntimeServices,
): CursorPluginSetup {
  return async (context) => {
    const cleanups: Cleanup[] = [
      () => {
        services.resetLogin();
        services.clearModelCache();
      },
    ];
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      let firstError: unknown;
      for (const release of cleanups.reverse()) {
        try {
          await release();
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    };

    try {
      const integrationRegistration =
        await services.registerIntegration(context);
      cleanups.push(() => integrationRegistration.dispose());
      const getAccessToken =
        services.createAccessTokenProvider(context);
      services.startTransport();
      cleanups.push(() => services.stopTransport());
      const languageRegistration =
        await services.registerLanguage(context, getAccessToken);
      cleanups.push(() => languageRegistration.dispose());
      const discoverModels = async (
        fallback: CursorCatalogState["models"],
      ) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const credential =
              await services.resolveCredential(context);
            if (!credential?.access) return [];
            const discovered = await services.getModels(
              credential.access,
            );
            if (discovered.length > 0) return discovered;
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : String(error);
            log.warn(
              `[opencode-cursor] failed to resolve Cursor catalog (attempt ${attempt + 1}/3): ${message}`,
            );
            if (error instanceof RefreshTokenInvalidError) {
              return [];
            }
          }
          if (attempt < 2) {
            await services.sleep(1_000 * (attempt + 1));
          }
        }
        return fallback;
      };

      const initialModels = await discoverModels([]);
      const catalogState = createCursorCatalogState(
        initialModels,
      );
      const catalogRegistration =
        await services.registerCatalog(context, catalogState);
      cleanups.push(() => catalogRegistration.dispose());

      let disposed = false;
      let reloadInFlight: Promise<void> | undefined;
      const reload = async (): Promise<void> => {
        if (reloadInFlight) return reloadInFlight;
        reloadInFlight = (async () => {
          const models = await discoverModels(catalogState.models);
          if (disposed) return;
          updateCursorCatalogState(
            catalogState,
            models,
          );
          await context.catalog.reload();
        })().finally(() => {
          reloadInFlight = undefined;
        });
        return reloadInFlight;
      };

      const controller = new AbortController();
      const eventTask = (async () => {
        try {
          for await (const event of context.event.subscribe({
            signal: controller.signal,
          })) {
            if (
              event.type !== "integration.connection.updated" ||
              event.data.integrationID !== CURSOR_INTEGRATION_ID
            ) {
              continue;
            }
            services.clearModelCache();
            try {
              await reload();
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : String(error);
              log.warn(
                `[opencode-cursor] failed to reload Cursor connection: ${message}`,
              );
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            const message =
              error instanceof Error
                ? error.message
                : String(error);
            log.warn(
              `[opencode-cursor] integration event subscription failed: ${message}`,
            );
          }
        }
      })();
      cleanups.push(async () => {
        disposed = true;
        controller.abort();
        await eventTask;
      });

      return cleanup;
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        const message =
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        log.warn(
          `[opencode-cursor] setup rollback failed: ${message}`,
        );
      }
      throw error;
    }
  };
}

export const setupCursorRuntime =
  createCursorRuntime(defaultServices);
