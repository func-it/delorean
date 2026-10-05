import "server-only";

export type BodyText = { ok: true; text: string } | { ok: false };

/**
 * The body as text, never more than `limit` bytes of it in memory: a
 * `Content-Length` over the limit is refused before reading, and a body
 * without one (or lying about it) stops being read one byte past the limit.
 * `ok: false` means over the limit.
 */
export async function readBodyText(request: Request, limit: number): Promise<BodyText> {
  const announced = Number(request.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > limit) return { ok: false };
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}
