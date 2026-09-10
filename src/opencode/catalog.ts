import {
  Integration,
  Model,
  Plugin,
  Provider,
} from "@opencode/plugin";
import { Money } from "@opencode/schema/money";
import {
  CURSOR_SELECTION_HEADER,
  encodeCursorModelSelection,
  type CursorModel,
} from "../model-selection.js";
import { rememberCursorModels } from "../models/catalog.js";
import {
  applyCatalogMetadata,
  type CatalogMetadata,
} from "../models/metadata.js";
import { estimateModelCost } from "../provider/pricing.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from "../shared/constants.js";
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

type CatalogContext = {
  provider: Pick<Plugin.Context["provider"], "transform">;
};

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
  rememberCursorModels(models);
}

export async function registerCursorCatalog(
  context: CatalogContext,
  state: CursorCatalogState,
): Promise<DisposableRegistration> {
  return context.provider.transform((editor) => {
    rememberCursorModels(state.models);
    const references = catalogReferences(editor.list());
    const models: Model.Info[] = state.models.map((cursorModel) => {
      const modelID = Model.ID.make(cursorModel.id);
      const metadata = applyCatalogMetadata(cursorModel, references, {
        context: DEFAULT_CONTEXT_WINDOW,
        output: DEFAULT_MAX_TOKENS,
      });
      const priced = metadata.cost ?? [estimateModelCost(cursorModel.id)];
      return {
        ...Model.Info.default(CURSOR_PROVIDER_ID, modelID),
        name: cursorModel.name,
        modelID,
        ...(metadata.family
          ? { family: Model.Family.make(metadata.family) }
          : {}),
        capabilities: {
          tools: true,
          input: metadata.input,
          output: ["text"],
        },
        headers: {
          [CURSOR_SELECTION_HEADER]: encodeCursorModelSelection(
            cursorModel.defaultSelection,
          ),
        },
        variants: Object.entries(cursorModel.variants).map(
          ([id, selection]) => ({
            id: Model.VariantID.make(id),
            headers: {
              [CURSOR_SELECTION_HEADER]:
                encodeCursorModelSelection(selection),
            },
          }),
        ),
        time: { released: metadata.released },
        cost: priced.map((item) => ({
          ...("tier" in item && item.tier ? { tier: item.tier } : {}),
          input: Money.USDPerMillionTokens.make(item.input),
          output: Money.USDPerMillionTokens.make(item.output),
          cache: {
            read: Money.USDPerMillionTokens.make(item.cache.read),
            write: Money.USDPerMillionTokens.make(item.cache.write),
          },
        })),
        status: "active",
        enabled: true,
        limit: {
          context: metadata.context,
          output: metadata.output,
        },
      };
    });

    if (models.length === 0) {
      const connectModelID = Model.ID.make("connect");
      models.push({
        ...Model.Info.default(CURSOR_PROVIDER_ID, connectModelID),
        name: "Connect Cursor to load models",
        modelID: connectModelID,
        capabilities: {
          tools: false,
          input: ["text"],
          output: ["text"],
        },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 1, output: 1 },
      });
    }

    editor.add({
      info: {
        ...Provider.Info.empty(CURSOR_PROVIDER_ID),
        name: "Cursor",
        integrationID: CURSOR_INTEGRATION,
        activation: state.models.length === 0 ? "enabled" : "auto",
        package: CURSOR_PACKAGE,
      },
      models,
    });
  });
}

function catalogReferences(
  records: readonly {
    provider: { id: string };
    models: ReadonlyMap<string, Model.Info>;
  }[],
): CatalogMetadata[] {
  const references: CatalogMetadata[] = [];
  for (const record of records) {
    for (const model of record.models.values()) {
      references.push({
        providerID: record.provider.id,
        id: model.id,
        family: model.family,
        context: model.limit.context,
        output: model.limit.output,
        input: model.capabilities.input,
        released: model.time.released,
        cost: model.cost.map((item) => ({
          ...(item.tier ? { tier: item.tier } : {}),
          input: item.input,
          output: item.output,
          cache: { read: item.cache.read, write: item.cache.write },
        })),
      });
    }
  }
  return references;
}
