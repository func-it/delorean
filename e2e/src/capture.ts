import { createServer, type IncomingMessage, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { decodeJson, decodeProtobuf, type Span } from './otlp.ts';

/**
 * A stand-in for Langfuse that keeps what the quoters send it: the spans of
 * their OTLP exporters and the batches of their score ingestion. Each quoter
 * is known by its public key, `pk-<quoter>`. GET /captured hands it all to
 * the parity suite.
 *
 *   node src/capture.ts      # prints the port it listens on, then serves
 */

export interface Ingestion {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
}

export interface Captured {
  spans: Span[];
  ingestion: Ingestion[];
  /** Any other request: a quoter calling Langfuse for something else. */
  other: string[];
}

function quoterOf(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? '';
  const user =
    Buffer.from(auth.replace(/^Basic /, ''), 'base64')
      .toString('utf8')
      .split(':')[0] ?? '';
  return user.replace(/^pk-/, '') || 'unknown';
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  return req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
}

export function captureServer(): Server {
  const all = new Map<string, Captured>();
  const of = (q: string): Captured => {
    let c = all.get(q);
    if (!c) {
      c = { spans: [], ingestion: [], other: [] };
      all.set(q, c);
    }
    return c;
  };
  return createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (req.method === 'GET' && path === '/captured') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Object.fromEntries(all)));
        return;
      }
      const c = of(quoterOf(req));
      const b = await body(req);
      if (req.method === 'POST' && path.endsWith('/v1/traces')) {
        const json = (req.headers['content-type'] ?? '').includes('json');
        c.spans.push(...(json ? decodeJson(b.toString('utf8')) : decodeProtobuf(b)));
        res.writeHead(200, { 'Content-Type': json ? 'application/json' : 'application/x-protobuf' });
        res.end(json ? '{}' : undefined);
        return;
      }
      if (req.method === 'POST' && path === '/api/public/ingestion') {
        const batch = (JSON.parse(b.toString('utf8')) as { batch?: Ingestion[] }).batch ?? [];
        c.ingestion.push(...batch);
        res.writeHead(207, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ successes: batch.map((e) => ({ id: e.id, status: 201 })), errors: [] }));
        return;
      }
      c.other.push(`${req.method ?? ''} ${path}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    })().catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const server = captureServer();
  server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
    const address = server.address();
    console.log(typeof address === 'object' && address ? address.port : '');
  });
}
