import { useSyncExternalStore, useCallback } from 'react';
import { dataCache, type CacheKey, type AgentsResult, type TeamsResult, type RequirementsResult, type GroupChatsResult, type UsersResult } from '../lib/dataCache.ts';

type CacheData<K extends CacheKey> = K extends 'agents' ? AgentsResult | null
  : K extends 'teams' ? TeamsResult | null
  : K extends 'requirements' ? RequirementsResult | null
  : K extends 'groupChats' ? GroupChatsResult | null
  : K extends 'users' ? UsersResult | null
  : unknown | null;

export function useDataCache<K extends CacheKey>(key: K): {
  data: CacheData<K>;
  refresh: () => Promise<unknown>;
} {
  const subscribe = useCallback(
    (onStoreChange: () => void) => dataCache.subscribe(key, onStoreChange),
    [key],
  );
  const getSnapshot = useCallback(() => dataCache.get(key), [key]);
  const data = useSyncExternalStore(subscribe, getSnapshot) as CacheData<K>;
  const refresh = useCallback(() => dataCache.refresh(key), [key]);
  return { data, refresh };
}
