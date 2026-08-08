export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEqual<T>(
  actual: T,
  expected: T,
  message: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

export function assertArrayEqual(
  actual: readonly string[],
  expected: readonly string[],
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

export function assertDefaultProviderModel(
  provider: { models: Record<string, any> },
  expectedApiModelId: string,
  message: string,
): void {
  const model = provider.models.default;
  assert(model, `${message}: missing provider model 'default'`);
  assertEqual(model.id, "default", `${message}: unexpected alias id`);
  assertEqual(
    model.providerID,
    "cursor",
    `${message}: unexpected provider id`,
  );
  assertEqual(
    model.api?.id,
    expectedApiModelId,
    `${message}: unexpected API model id`,
  );
}
