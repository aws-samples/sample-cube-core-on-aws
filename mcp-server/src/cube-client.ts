/**
 * Minimal client for the Cube Core REST API.
 * https://cube.dev/docs/product/apis-integrations/rest-api/reference
 */

export interface CubeClientOptions {
  /** Base URL of the Cube deployment, e.g. https://dxxxx.cloudfront.net (without /cubejs-api). */
  baseUrl: string;
  /** Cube JWT (signed with CUBEJS_API_SECRET or issued by your IdP). "Bearer " prefix is optional. */
  token: string;
  /** Overall timeout for a single tool call, including "Continue wait" polling. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class CubeApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class CubeClient {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CubeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '').replace(/\/cubejs-api(\/v1)?$/, '');
    this.authorization = opts.token.replace(/^Bearer\s+/i, '');
    this.timeoutMs = opts.timeoutMs ?? 25_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  meta(): Promise<any> {
    return this.request('GET', '/cubejs-api/v1/meta?extended=true');
  }

  load(query: unknown): Promise<any> {
    return this.request('POST', '/cubejs-api/v1/load', { query, queryType: 'multi' });
  }

  sql(query: unknown): Promise<any> {
    return this.request('POST', '/cubejs-api/v1/sql', { query });
  }

  /** Sends a request and transparently polls while Cube answers {"error":"Continue wait"}. */
  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new CubeApiError('Timed out waiting for Cube; the query is still running, retry later.', 504);
      }
      const res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: {
          Authorization: this.authorization,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(remaining),
      });
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new CubeApiError(`Cube returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status);
      }
      if (json?.error === 'Continue wait') {
        await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, deadline - Date.now()))));
        continue;
      }
      if (!res.ok || json?.error) {
        throw new CubeApiError(`Cube API error (HTTP ${res.status}): ${json?.error ?? text.slice(0, 300)}`, res.status);
      }
      return json;
    }
  }
}
