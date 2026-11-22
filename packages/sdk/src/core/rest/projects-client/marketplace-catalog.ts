// The marketplace client. The marketplace was removed on 2026-11-20: every
// `/v1/marketplace/*` route and `POST /workspaces/:id/marketplace/install-session`
// answer `410 ENDPOINT_RETIRED` (apps/api/src/routes/retired.ts). These names
// stay exported, deprecated, until the next major.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major. */
export interface MarketplaceCatalogItem {
  id: string;
  title: string;
  type: string;
  source: string;
  description?: string | null;
  [key: string]: unknown;
}

/** @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major. */
export interface MarketplaceCatalogStatus {
  loading?: boolean;
  pending?: number | string[];
  sources?: unknown[];
  total?: number;
  hasMore?: boolean;
}

/** @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major. */
export interface MarketplaceItemsResponse extends MarketplaceCatalogStatus {
  items: MarketplaceCatalogItem[];
}

/** @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major. */
export interface ListMarketplaceItemsOptions {
  query?: string;
  type?: string;
  source?: string;
  limit?: number;
  offset?: number;
}

/**
 * Browse the public registry catalog (no auth required).
 *
 * @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major.
 */
export async function listMarketplaceCatalogItems(
  options?: ListMarketplaceItemsOptions,
): Promise<MarketplaceItemsResponse> {
  const params = new URLSearchParams();
  if (options?.query) params.set('query', options.query);
  if (options?.type) params.set('type', options.type);
  if (options?.source) params.set('source', options.source);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.offset !== undefined) params.set('offset', String(options.offset));
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(await backendApi.get<MarketplaceItemsResponse>(`/marketplace/items${query}`));
}

/** @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major. */
export interface MarketplaceEntry {
  name: string;
  item_count: number;
  [key: string]: unknown;
}

/** @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major. */
export interface MarketplacesResponse extends MarketplaceCatalogStatus {
  marketplaces: MarketplaceEntry[];
}

/**
 * Distinct marketplaces (sources) with item counts.
 *
 * @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major.
 */
export async function listMarketplaces(): Promise<MarketplacesResponse> {
  return unwrap(await backendApi.get<MarketplacesResponse>('/marketplace/marketplaces'));
}

/** @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major. */
export interface FeaturedMarketplacesResponse {
  featured: MarketplaceEntry[];
}

/**
 * Curated featured marketplaces.
 *
 * @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major.
 */
export async function listFeaturedMarketplaces(): Promise<FeaturedMarketplacesResponse> {
  return unwrap(await backendApi.get<FeaturedMarketplacesResponse>('/marketplace/marketplaces/featured'));
}

/**
 * A single catalog item's full detail (manifest + file listing).
 *
 * @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major.
 */
export async function getMarketplaceCatalogItem(id: string): Promise<Record<string, unknown>> {
  return unwrap(
    await backendApi.get<Record<string, unknown>>(`/marketplace/items/${encodeURIComponent(id)}`),
    'Item not found',
  );
}

/** @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major. */
export interface MarketplaceItemFile {
  path: string;
  content: string;
  [key: string]: unknown;
}

/**
 * Read a single file's content out of a catalog item (before installing it).
 *
 * @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major.
 */
export async function getMarketplaceCatalogItemFile(
  id: string,
  path: string,
): Promise<MarketplaceItemFile> {
  return unwrap(
    await backendApi.get<MarketplaceItemFile>(
      `/marketplace/items/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
    ),
    'File not found',
  );
}

// ── Sources ("Add a marketplace") — authed, platform-global ────────────────

/** @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major. */
export interface MarketplaceSource {
  id: string;
  address: string;
  gitRef?: string | null;
  sparsePaths?: string[] | null;
  label?: string | null;
  [key: string]: unknown;
}

/** @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major. */
export interface MarketplaceSourcesResponse {
  sources: MarketplaceSource[];
}

/**
 * List operator-managed marketplace sources (a GitHub repo, Git URL, or local folder).
 *
 * @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major.
 */
export async function listMarketplaceSources(): Promise<MarketplaceSourcesResponse> {
  return unwrap(await backendApi.get<MarketplaceSourcesResponse>('/marketplace/sources'));
}

/** @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major. */
export interface AddMarketplaceSourceInput {
  address: string;
  gitRef?: string;
  sparsePaths?: string[];
  label?: string;
}

/** @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major. */
export interface AddMarketplaceSourceResponse {
  source: MarketplaceSource;
}

/**
 * Add a marketplace source. Rejects local-folder/private/non-https addresses server-side.
 *
 * @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major.
 */
export async function addMarketplaceSource(
  input: AddMarketplaceSourceInput,
): Promise<AddMarketplaceSourceResponse> {
  return unwrap(
    await backendApi.post<AddMarketplaceSourceResponse>('/marketplace/sources', input),
    'Failed to add marketplace source',
  );
}

/**
 * Remove a marketplace source by id.
 *
 * @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major.
 */
export async function removeMarketplaceSource(id: string): Promise<{ ok: boolean }> {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/marketplace/sources/${encodeURIComponent(id)}`),
    'Failed to remove marketplace source',
  );
}

/** @deprecated The marketplace was removed (2026-11-20); the API answers `410 ENDPOINT_RETIRED`. Removed in the next major. */
export async function createMarketplaceInstallSession(
  projectId: string,
  itemId: string,
): Promise<{ session_id: string }> {
  return unwrap(
    await backendApi.post<{ session_id: string }>(
      `/workspaces/${encodeURIComponent(projectId)}/marketplace/install-session`,
      { id: itemId },
    ),
    'Failed to start marketplace install session',
  );
}
