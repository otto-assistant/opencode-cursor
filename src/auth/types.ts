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
