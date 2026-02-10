import { Readable, Writable } from 'node:stream';

export interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  bodyText(): string;
  bodyJson(): any;
}

class MockRes extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  headersSent = false;
  destroyed = false;
  private chunks: Buffer[] = [];

  writeHead(code: number, headers?: Record<string, any>) {
    this.statusCode = code;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === 'string') this.headers[k.toLowerCase()] = v;
      }
    }
    this.headersSent = true;
    return this;
  }

  override _write(chunk: any, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    cb();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

export async function dispatch(
  handler: (req: any, res: any) => void,
  opts: { method: string; url: string; headers?: Record<string, string>; remoteAddress?: string; body?: string },
): Promise<MockResponse> {
  const req = new Readable({ read() {} }) as any;
  req.method = opts.method;
  req.url = opts.url;
  req.headers = opts.headers || {};
  req.socket = { remoteAddress: opts.remoteAddress || '127.0.0.1' };

  const res = new MockRes() as any;

  // Run handler first so it can attach listeners before we push data.
  handler(req, res);

  queueMicrotask(() => {
    if (opts.body) req.push(Buffer.from(opts.body, 'utf8'));
    req.push(null);
  });

  await new Promise<void>((resolve) => res.on('finish', () => resolve()));

  return {
    statusCode: res.statusCode,
    headers: res.headers,
    bodyText: () => res.text(),
    bodyJson: () => JSON.parse(res.text()),
  };
}
