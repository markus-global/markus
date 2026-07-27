import { hubApi, type HubItem } from '../api.ts';

/**
 * Ensure a Hub item targeted by a deep link (`?install=` / markus://install)
 * is present in the current list. Marketplace search is paginated (≈50), so
 * the target is often missing unless we fetch it by id and pin it to the top.
 */
export async function mergeHighlightedHubItem(
  items: HubItem[],
  highlightItemId: string | null | undefined,
): Promise<{ items: HubItem[]; highlighted: HubItem | null; missing: boolean }> {
  if (!highlightItemId) {
    return { items, highlighted: null, missing: false };
  }
  const existing = items.find((i) => i.id === highlightItemId);
  if (existing) {
    // Keep target first so scroll-into-view is reliable.
    return {
      items: [existing, ...items.filter((i) => i.id !== highlightItemId)],
      highlighted: existing,
      missing: false,
    };
  }
  try {
    const { item } = await hubApi.getItem(highlightItemId);
    if (!item) return { items, highlighted: null, missing: true };
    return { items: [item, ...items], highlighted: item, missing: false };
  } catch {
    return { items, highlighted: null, missing: true };
  }
}
