import {
  Integration,
  Model,
  Plugin,
  Provider,
} from "@opencode-ai/plugin";
import { Money } from "@opencode-ai/schema/money";
import {
  CURSOR_SELECTION_HEADER,
  encodeCursorModelSelection,
  type CursorModel,
} from "../model-selection.js";
import { estimateModelCost } from "../provider/pricing.js";
import {
  CURSOR_INTEGRATION_ID,
  type DisposableRegistration,
} from "./integration.js";

const CURSOR_PROVIDER_ID = Provider.ID.make(
  CURSOR_INTEGRATION_ID,
);
const CURSOR_INTEGRATION = Integration.ID.make(
  CURSOR_INTEGRATION_ID,
);
const CURSOR_PACKAGE = `aisdk:${new URL("./provider.js", import.meta.url).href}`;

export interface CursorCatalogState {
  models: readonly CursorModel[];
}

type CatalogContext = Pick<Plugin.Context, "catalog">;

export function createCursorCatalogState(
  models: readonly CursorModel[],
): CursorCatalogState {
  return { models };
}

export function updateCursorCatalogState(
  state: CursorCatalogState,
  models: readonly CursorModel[],
): void {
  state.models = models;
}

export async function registerCursorCatalog(
  context: CatalogContext,
  state: CursorCatalogState,
): Promise<DisposableRegistration> {
  return context.catalog.transform((catalog) => {
    catalog.provider.update(CURSOR_PROVIDER_ID, (provider) => {
      provider.name = "Cursor";
      provider.integrationID = CURSOR_INTEGRATION;
      provider.activation =
        state.models.length === 0 ? "enabled" : "auto";
      provider.package = CURSOR_PACKAGE;
    });

    if (state.models.length === 0) {
      const connectModelID = Model.ID.make("connect");
      catalog.model.update(
        CURSOR_PROVIDER_ID,
        connectModelID,
        (model) => {
          model.name = "Connect Cursor to load models";
          model.modelID = connectModelID;
          model.capabilities = {
            tools: false,
            input: ["text"],
            output: ["text"],
          };
          model.variants = [];
          model.time = { released: 0 };
          model.cost = [];
          model.status = "active";
          model.enabled = true;
          model.limit = { context: 1, output: 1 };
        },
      );
    }

    for (const cursorModel of state.models) {
      const modelID = Model.ID.make(cursorModel.id);
      catalog.model.update(CURSOR_PROVIDER_ID, modelID, (model) => {
        const cost = estimateModelCost(cursorModel.id);
        model.name = cursorModel.name;
        model.modelID = modelID;
        model.capabilities = {
          tools: true,
          input: ["text", "image"],
          output: ["text"],
        };
        model.headers = {
          ...model.headers,
          [CURSOR_SELECTION_HEADER]: encodeCursorModelSelection(
            cursorModel.defaultSelection,
          ),
        };
        model.variants = Object.entries(cursorModel.variants).map(
          ([id, selection]) => ({
            id: Model.VariantID.make(id),
            headers: {
              [CURSOR_SELECTION_HEADER]:
                encodeCursorModelSelection(selection),
            },
          }),
        );
        model.time = { released: 0 };
        model.cost = [
          {
            input: Money.USDPerMillionTokens.make(cost.input),
            output: Money.USDPerMillionTokens.make(cost.output),
            cache: {
              read: Money.USDPerMillionTokens.make(cost.cache.read),
              write: Money.USDPerMillionTokens.make(cost.cache.write),
            },
          },
        ];
        model.status = "active";
        model.enabled = true;
        model.limit = {
          context: cursorModel.contextWindow,
          output: cursorModel.maxTokens,
        };
      });
    }
  });
}
