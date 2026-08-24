export interface TestModules {
  startProxy: typeof import("../../src/proxy").startProxy;
  stopProxy: typeof import("../../src/proxy").stopProxy;
  getProxyPort: typeof import("../../src/proxy").getProxyPort;
  getCursorProxyBaseUrl: typeof import("../../src/proxy").getCursorProxyBaseUrl;
  resolveProxyModelId: typeof import("../../src/proxy").resolveProxyModelId;
  computeUsage: typeof import("../../src/proxy").computeUsage;
  isServerKeepaliveMessage: typeof import("../../src/proxy").isServerKeepaliveMessage;
  cursorSelectionHeader: typeof import("../../src/model-selection").CURSOR_SELECTION_HEADER;
  encodeCursorModelSelection: typeof import("../../src/model-selection").encodeCursorModelSelection;
  decodeCursorModelSelection: typeof import("../../src/model-selection").decodeCursorModelSelection;
  generateCursorAuthParams: typeof import("../../src/auth").generateCursorAuthParams;
  getTokenExpiry: typeof import("../../src/auth").getTokenExpiry;
  CursorAuthPlugin: typeof import("../../src/index").CursorAuthPlugin;
  clearModelCache: typeof import("../../src/models").clearModelCache;
  normalizeCursorModels: typeof import("../../src/models").normalizeCursorModels;
  normalizeAvailableModels: typeof import("../../src/models").normalizeAvailableModels;
  resolveCursorModelSelection: typeof import("../../src/models").resolveCursorModelSelection;
  resetPendingCursorLogin: typeof import("../../src/auth-login").resetPendingCursorLogin;
}

export async function loadTestModules(): Promise<TestModules> {
  const proxy = await import("../../src/proxy");
  const auth = await import("../../src/auth");
  const index = await import("../../src/index");
  const models = await import("../../src/models");
  const modelSelection = await import("../../src/model-selection");
  const authLogin = await import("../../src/auth-login");
  return {
    startProxy: proxy.startProxy,
    stopProxy: proxy.stopProxy,
    getProxyPort: proxy.getProxyPort,
    getCursorProxyBaseUrl: proxy.getCursorProxyBaseUrl,
    resolveProxyModelId: proxy.resolveProxyModelId,
    computeUsage: proxy.computeUsage,
    isServerKeepaliveMessage: proxy.isServerKeepaliveMessage,
    cursorSelectionHeader: modelSelection.CURSOR_SELECTION_HEADER,
    encodeCursorModelSelection: modelSelection.encodeCursorModelSelection,
    decodeCursorModelSelection: modelSelection.decodeCursorModelSelection,
    generateCursorAuthParams: auth.generateCursorAuthParams,
    getTokenExpiry: auth.getTokenExpiry,
    CursorAuthPlugin: index.CursorAuthPlugin,
    clearModelCache: models.clearModelCache,
    normalizeCursorModels: models.normalizeCursorModels,
    normalizeAvailableModels: models.normalizeAvailableModels,
    resolveCursorModelSelection: models.resolveCursorModelSelection,
    resetPendingCursorLogin: authLogin.resetPendingCursorLogin,
  };
}
