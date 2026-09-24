import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
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
      const scope = crypto.randomUUID();
      cleanups.push(() => services.stopTransport(scope));
      const languageRegistration =
        await services.registerLanguage(context, getAccessToken, scope);
      cleanups.push(() => languageRegistration.dispose());
      let catalogCredential: string | undefined;
      const discoverModels = async (
        fallback: CursorCatalogState["models"],
        connectionChanged = false,
      ): Promise<{ models: CursorCatalogState["models"]; complete: boolean; credential?: string }> => {
        try {
          const credential = await services.resolveCredential(context);
          if (!credential?.access) return { models: [], complete: true };
          const key = createHash("sha256").update(credential.access).digest("hex");
          const discovered = await services.getModels(credential.access);
          return {
            models: !discovered.complete && key === catalogCredential && fallback.length
              ? fallback
              : discovered.models,
            complete: discovered.complete,
            credential: key,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.warn(`[opencode-cursor] failed to resolve Cursor catalog: ${message}`);
          if (error instanceof RefreshTokenInvalidError)
            return { models: [], complete: true };
          return {
            models: connectionChanged ? [] : fallback,
            complete: false,
            credential: connectionChanged ? undefined : catalogCredential,
          };
        }
      };

      const initial = await discoverModels([]);
      catalogCredential = initial.credential;
      const catalogState = createCursorCatalogState(
        initial.models,
      );
      const catalogRegistration =
        await services.registerCatalog(context, catalogState);
      cleanups.push(() => catalogRegistration.dispose());

      let disposed = false;
      let reloadInFlight: Promise<void> | undefined;
      let reloadGeneration = 0;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let retryDelay = 5_000;
      let generation = 0;
      let pendingReload = false;
      const scheduleRetry = () => {
        if (disposed || retry) return;
        retry = setTimeout(() => {
          retry = undefined;
          void reload().catch((error) => {
            log.warn("[opencode-cursor] catalog retry failed", {
              error: error instanceof Error ? error.name : "unknown",
            });
            scheduleRetry();
          });
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 60_000);
      };
      const reload = async (connectionChanged = false): Promise<void> => {
        if (reloadInFlight) {
          await reloadInFlight;
          if (reloadGeneration === generation) return;
        }
        const requestGeneration = generation;
        reloadGeneration = requestGeneration;
        reloadInFlight = (async () => {
          const discovered = await discoverModels(catalogState.models, connectionChanged);
          if (disposed || requestGeneration !== generation) return;
          catalogCredential = discovered.credential;
          if (discovered.complete) retryDelay = 5_000;
          else scheduleRetry();
          const changed = discovered.models !== catalogState.models;
          if (changed)
            updateCursorCatalogState(catalogState, discovered.models);
          if (changed || connectionChanged || pendingReload) {
            pendingReload = true;
            await context.provider.reload();
            pendingReload = false;
          }
        })().finally(() => {
          reloadInFlight = undefined;
        });
        return reloadInFlight;
      };
      if (!initial.complete) scheduleRetry();

      const controller = new AbortController();
      const eventTask = (async () => {
        try {
          for await (const event of context.event.subscribe({
            signal: controller.signal,
          })) {
            if (
              event.type !== "credential.switched" ||
              event.data.integrationID !== CURSOR_INTEGRATION_ID
            ) {
              continue;
            }
            generation += 1;
            clearTimeout(retry);
            retry = undefined;
            retryDelay = 5_000;
            pendingReload = false;
            services.clearModelCache();
            try {
              await reload(true);
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : String(error);
              log.warn(
                `[opencode-cursor] failed to reload Cursor connection: ${message}`,
              );
              scheduleRetry();
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
        clearTimeout(retry);
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
