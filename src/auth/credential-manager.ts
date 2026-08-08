import { refreshCursorToken } from "../auth.js";

/** Canonical Cursor OAuth credential shape stored in OpenCode auth.json. */
export type CursorOAuthCredential = {
  type: "oauth";
  access?: string;
  refresh: string;
  expires: number;
};

export function isCursorOAuthCredential(
  auth: unknown,
): auth is CursorOAuthCredential {
  return (
    !!auth &&
    typeof auth === "object" &&
    (auth as { type?: unknown }).type === "oauth" &&
    typeof (auth as { refresh?: unknown }).refresh === "string" &&
    typeof (auth as { expires?: unknown }).expires === "number"
  );
}

export type AccessTokenProvider = () => Promise<string>;

export async function ensureValidAccessToken(options: {
  auth: CursorOAuthCredential;
  /** Persist refreshed credentials (plugin client.auth.set and/or auth.json). */
  persist: (cred: CursorOAuthCredential) => Promise<void> | void;
}): Promise<string | undefined> {
  const { auth, persist } = options;

  if (auth.access && auth.expires >= Date.now()) {
    return auth.access;
  }

  const refreshed = await refreshCursorToken(auth.refresh);
  const credential: CursorOAuthCredential = {
    type: "oauth",
    access: refreshed.access,
    refresh: refreshed.refresh,
    expires: refreshed.expires,
  };

  await persist(credential);
  return credential.access;
}

export function createAccessTokenProvider(
  getAuth: () => Promise<unknown>,
  persist: (cred: CursorOAuthCredential) => Promise<void> | void,
): AccessTokenProvider {
  return async () => {
    const auth = await getAuth();
    if (!isCursorOAuthCredential(auth)) {
      throw new Error("Cursor auth not configured");
    }

    const accessToken = await ensureValidAccessToken({ auth, persist });
    if (!accessToken) {
      throw new Error("Cursor access token unavailable");
    }

    return accessToken;
  };
}
