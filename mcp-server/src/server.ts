import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CubeApiError, CubeClient } from './cube-client.js';

export const SERVER_NAME = 'cube-core';
export const SERVER_VERSION = '1.0.0';

/** Max rows returned to the model per query, to keep LLM context small. */
const MAX_ROWS = 500;

const filterSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.object({
      member: z.string().describe('Member name, e.g. "orders.status"'),
      operator: z
        .enum([
          'equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'notStartsWith',
          'endsWith', 'notEndsWith', 'gt', 'gte', 'lt', 'lte', 'set', 'notSet',
          'inDateRange', 'notInDateRange', 'beforeDate', 'beforeOrOnDate', 'afterDate', 'afterOrOnDate',
        ])
        .describe('Filter operator'),
      values: z.array(z.string()).optional().describe('Values (always strings); omit for set/notSet'),
    }),
    z.object({ and: z.array(filterSchema) }),
    z.object({ or: z.array(filterSchema) }),
  ]),
);

export const querySchema = {
  measures: z.array(z.string()).optional().describe('Measures, e.g. ["orders.count", "orders.total_amount"]'),
  dimensions: z.array(z.string()).optional().describe('Dimensions, e.g. ["orders.status"]'),
  timeDimensions: z
    .array(
      z.object({
        dimension: z.string().describe('Time dimension, e.g. "orders.created_at"'),
        granularity: z
          .enum(['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'])
          .optional(),
        dateRange: z
          .union([z.string(), z.array(z.string()).length(2)])
          .optional()
          .describe('e.g. "last 30 days", "this year" or ["2024-01-01", "2024-03-31"]'),
      }),
    )
    .optional(),
  filters: z.array(filterSchema).optional(),
  segments: z.array(z.string()).optional(),
  order: z
    .record(z.string(), z.enum(['asc', 'desc']))
    .optional()
    .describe('e.g. {"orders.count": "desc"}'),
  limit: z.number().int().positive().max(50_000).optional().describe(`Row limit (default 100, at most ${MAX_ROWS} rows are returned to you)`),
  offset: z.number().int().nonnegative().optional(),
  timezone: z.string().optional().describe('IANA timezone, e.g. "Asia/Shanghai"'),
  ungrouped: z.boolean().optional(),
};

type QueryArgs = { [K in keyof typeof querySchema]?: any };

function toCubeQuery(args: QueryArgs): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined) q[k] = v;
  }
  if (q.limit === undefined) q.limit = 100;
  return q;
}

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown) {
  const msg = err instanceof CubeApiError || err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text' as const, text: msg }] };
}

/** Compact view of /v1/meta so that the model can discover the semantic layer cheaply. */
export function summarizeMeta(meta: any) {
  return (meta?.cubes ?? [])
    .filter((c: any) => c.public !== false)
    .map((c: any) => ({
      name: c.name,
      type: c.type,
      title: c.title,
      description: c.description,
      measures: (c.measures ?? []).filter((m: any) => m.public !== false).map((m: any) => m.name),
      dimensions: (c.dimensions ?? []).filter((d: any) => d.public !== false).map((d: any) => `${d.name}${d.type === 'time' ? ' (time)' : ''}`),
      segments: (c.segments ?? []).map((s: any) => s.name),
    }));
}

/**
 * Builds an MCP server bound to a single Cube client (i.e. a single caller identity).
 * The Cube JWT carries the security context, so row-level security defined in the
 * Cube data model applies to every tool call.
 */
export function createCubeMcpServer(client: CubeClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Tools for querying a Cube semantic layer. Always call cube_list_models first to discover ' +
        'cubes/views and their member names, use cube_describe_model for details, then cube_query. ' +
        'Member names are fully qualified ("view.member"). Prefer views over cubes when available.',
    },
  );

  server.registerTool(
    'cube_list_models',
    {
      title: 'List Cube models',
      description: 'List the cubes and views of the semantic layer with their measures, dimensions and segments.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok(summarizeMeta(await client.meta()));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'cube_describe_model',
    {
      title: 'Describe a cube or view',
      description: 'Return full metadata (types, descriptions, formats) for one cube or view.',
      inputSchema: { name: z.string().describe('Cube or view name, e.g. "orders_view"') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      try {
        const meta = await client.meta();
        const cube = (meta?.cubes ?? []).find((c: any) => c.name === name);
        if (!cube) return fail(new Error(`No cube or view named "${name}". Call cube_list_models to see available names.`));
        const pick = (m: any) => ({ name: m.name, title: m.title, type: m.type, description: m.description, format: m.format });
        return ok({
          name: cube.name,
          type: cube.type,
          title: cube.title,
          description: cube.description,
          measures: (cube.measures ?? []).map((m: any) => ({ ...pick(m), aggType: m.aggType })),
          dimensions: (cube.dimensions ?? []).map(pick),
          segments: (cube.segments ?? []).map(pick),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'cube_query',
    {
      title: 'Run a Cube query',
      description:
        'Execute a Cube REST API query (JSON query format) and return the result rows. ' +
        `At most ${MAX_ROWS} rows are returned.`,
      inputSchema: querySchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const res = await client.load(toCubeQuery(args));
        const result = res.results?.[0] ?? res;
        const rows: unknown[] = result.data ?? [];
        return ok({
          rowCount: rows.length,
          truncated: rows.length > MAX_ROWS,
          data: rows.slice(0, MAX_ROWS),
          usedPreAggregations: Object.keys(result.usedPreAggregations ?? {}),
          lastRefreshTime: result.lastRefreshTime,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'cube_generate_sql',
    {
      title: 'Explain a Cube query',
      description: 'Validate a Cube query and return the SQL Cube would run against the data source (no execution).',
      inputSchema: querySchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const res = await client.sql(toCubeQuery(args));
        const sql = res.sql ?? res;
        return ok({ sql: sql.sql, preAggregations: sql.preAggregations, external: sql.external });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
