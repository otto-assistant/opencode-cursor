import { refreshCursorToken } from "../auth.js";
import {
  isCursorOAuthCredential,
  type CursorOAuthCredential,
} from "./types.js";

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
