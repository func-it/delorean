/**
 * Asks the service on this machine for /healthz, for a container that is
 * asked to do it with what the image has (compose's healthcheck runs this
 * command). It reads PORT, as the service does, and nothing else: it must not
 * fail on a setting the service accepted. Up is a 200 with the health JSON,
 * said by nothing at all; anything else is an Error of one short line.
 */
export async function healthcheck(
  env: NodeJS.ProcessEnv,
  timeoutMs = 3000,
  fetchHealth: typeof fetch = fetch,
): Promise<void> {
  let port = 24793;
  const given = env.PORT;
  if (given !== undefined && given !== '') {
    port = Number(given);
    if (!/^\d+$/.test(given) || port < 1 || port > 65535) {
      throw new Error(`healthcheck: PORT=${JSON.stringify(given)} is not a port`);
    }
  }
  let response: Response;
  try {
    response = await fetchHealth(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error(`healthcheck: no answer on port ${port}`);
  }
  if (response.status !== 200) throw new Error(`healthcheck: HTTP ${response.status} on port ${port}`);
  const health: unknown = await response.json().catch(() => undefined);
  if (typeof health !== 'object' || health === null || (health as { status?: unknown }).status !== 'ok') {
    throw new Error(`healthcheck: not the health of a quoter on port ${port}`);
  }
}
