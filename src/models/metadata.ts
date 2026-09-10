export interface CatalogCost {
  input: number;
  output: number;
  cache: { read: number; write: number };
  tier?: { type: "context"; size: number };
}

export interface CatalogMetadata {
  providerID?: string;
  id: string;
  family?: string;
  context?: number;
  output?: number;
  input?: readonly string[];
  released?: number;
  cost?: readonly CatalogCost[];
}

export interface AppliedCatalogMetadata {
  family?: string;
  context: number;
  output: number;
  input: string[];
  released: number;
  cost?: readonly CatalogCost[];
}

const CURSOR_PROVIDER_ID = "cursor";

/**
 * models.dev's Cursor provider (anomalyco/models.dev#6624) uses the same bare
 * id we publish, such as `grok-4.6`, with Cursor's own limits and price.
 * A lab row such as `xai/grok-4.6` can supply family, not Cursor caps.
 * Availability still comes from the live Cursor catalog.
 */
export function applyCatalogMetadata(
  model: { id: string; contextWindow: number; maxTokens: number },
  references: readonly CatalogMetadata[],
  defaults: { context: number; output: number },
): AppliedCatalogMetadata {
  const cursor = references.find(
    (reference) =>
      reference.providerID === CURSOR_PROVIDER_ID && reference.id === model.id,
  );
  const lab = references.find(
    (reference) =>
      reference.providerID !== CURSOR_PROVIDER_ID &&
      (reference.id === model.id || reference.id.endsWith(`/${model.id}`)),
  );
  const unspecified =
    model.contextWindow === defaults.context &&
    model.maxTokens === defaults.output;
  return {
    family: cursor?.family ?? lab?.family,
    context: unspecified && cursor?.context ? cursor.context : model.contextWindow,
    output: unspecified && cursor?.output ? cursor.output : model.maxTokens,
    input: cursor?.input?.length
      ? mediaInputs(cursor.input)
      : ["text", "image"],
    released:
      (cursor?.released && cursor.released > 0 ? cursor.released : undefined) ??
      (lab?.released && lab.released > 0 ? lab.released : 0),
    cost: cursor?.cost?.length ? cursor.cost : undefined,
  };
}

function mediaInputs(input: readonly string[]): string[] {
  const values = new Set<string>(["text"]);
  for (const item of input) {
    if (item === "text" || item === "image" || item === "pdf") values.add(item);
  }
  return [...values];
}
