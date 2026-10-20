import type { RemoteModel } from '@orison/shared-contracts';
import { resolveModelInfo } from '@orison/shared-contracts';
import { getJson, normalizeBaseUrl } from './http';
import { ProtocolHttpError } from './errors';
import type { ListModelsRequest } from './types';

/**
 * Model discovery.
 *
 * Providers differ a lot here, so the adapter is deliberately forgiving:
 *   • accepts `{ data: [...] }` (OpenAI / Anthropic), `{ models: [...] }`
 *     (Ollama-style gateways) and bare arrays, including one nested level;
 *   • follows Anthropic (`has_more` + `last_id`) pagination instead of silently
 *     returning only the first page (Anthropic defaults to 20 per page);
 *   • asks for the largest page size up front (`limit=1000`).
 *
 * Anything unrecognized yields an empty list rather than throwing, matching the
 * previous behaviour.
 */

type UnknownRecord = Record<string, unknown>;

const MAX_PAGES = 20;
const PAGE_SIZE = 1000;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null ? (value as UnknownRecord) : null;
}

function idOf(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.trim() || null;
  const record = asRecord(entry);
  if (!record) return null;
  for (const key of ['id', 'name', 'model', 'model_id', 'modelId']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function extractIds(body: unknown): string[] {
  if (Array.isArray(body)) {
    return body.map(idOf).filter((id): id is string => Boolean(id));
  }
  const record = asRecord(body);
  if (!record) return [];
  for (const key of ['data', 'models', 'model_list', 'modelList', 'items', 'results']) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.map(idOf).filter((id): id is string => Boolean(id));
    }
    const nested = asRecord(value);
    if (nested) {
      const ids = extractIds(nested);
      if (ids.length > 0) return ids;
    }
  }
  return [];
}

/** Build the next page URL when the provider advertises more results. */
function nextPageUrl(body: unknown, baseUrl: string, request: ListModelsRequest): string | null {
  const record = asRecord(body);
  if (!record) return null;
  const hasMore = record.has_more === true || record.hasMore === true;
  if (!hasMore) return null;

  const cursorKeys = ['last_id', 'lastId', 'next_page_token', 'nextPageToken', 'next', 'cursor'];
  for (const key of cursorKeys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      const param = request.protocol === 'anthropic-compatible' ? 'after_id' : 'cursor';
      return `${baseUrl}/models?limit=${PAGE_SIZE}&${param}=${encodeURIComponent(value.trim())}`;
    }
  }

  const page = typeof record.page === 'number' ? record.page : null;
  if (page !== null) {
    return `${baseUrl}/models?limit=${PAGE_SIZE}&page=${page + 1}`;
  }
  return null;
}

function requestUrl(baseUrl: string, request: ListModelsRequest): string {
  // Anthropic paginates by default (limit 20); ask for the maximum page size.
  return request.protocol === 'anthropic-compatible'
    ? `${baseUrl}/models?limit=${PAGE_SIZE}`
    : `${baseUrl}/models`;
}

export async function listModels(request: ListModelsRequest): Promise<RemoteModel[]> {
  const baseUrl = normalizeBaseUrl(request.baseUrl);
  const headers: Record<string, string> = request.protocol === 'anthropic-compatible'
    ? { 'x-api-key': request.apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${request.apiKey}` };

  const ids: string[] = [];
  let url: string | null = requestUrl(baseUrl, request);
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    let body: unknown;
    try {
      body = await getJson<unknown>({ url, headers, signal: request.signal });
    } catch (error) {
      const fallbackUrl = deepSeekAnthropicModelsFallbackUrl(request);
      if (pages === 0 && error instanceof ProtocolHttpError && error.status === 404 && fallbackUrl) {
        body = await getJson<unknown>({
          url: fallbackUrl,
          headers: { authorization: `Bearer ${request.apiKey}` },
          signal: request.signal,
        });
        url = null;
      } else {
        throw error;
      }
    }

    ids.push(...extractIds(body));
    if (url !== null) url = nextPageUrl(body, baseUrl, request);
    pages += 1;
  }

  const seen = new Set<string>();
  const uniqueIds = ids.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return uniqueIds.map((id) => {
    const info = resolveModelInfo(id);
    return { id, capability: info.capability, alias: info.alias };
  });
}

function deepSeekAnthropicModelsFallbackUrl(request: ListModelsRequest): string | null {
  if (request.protocol !== 'anthropic-compatible') return null;

  const base = request.baseUrl.replace(/\/+$/, '');
  if (!/\/anthropic$/i.test(base)) return null;

  return `${base.replace(/\/anthropic$/i, '')}/models`;
}
