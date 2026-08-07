/**
 * POST a chat-completion body with keepalive disabled. The suite starts/stops
 * the proxy ~35 times on the SAME port, and Bun's keepalive pool caches
 * sockets per origin — a socket left over from a previous proxy instance is
 * stale after stopProxy() closes the server, and reusing it yields a flaky
 * ECONNRESET on the first request after a restart. keepalive:false forces a
 * fresh connection each time.
 */
export async function postChat(
  url: string,
  body: unknown,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: false,
  });
}
