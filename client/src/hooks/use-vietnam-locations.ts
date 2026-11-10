import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Location } from '@/lib/location-utils';

// Share in-flight requests and successful catalog responses between forms.
// Failures are evicted so Retry really requests the server again.
const cache = new Map<string, Promise<Location[]>>();
export function loadLocations(provinceCode = '') {
  const path = provinceCode ? `/api/orders/locations/${encodeURIComponent(provinceCode)}/wards` : '/api/orders/locations';
  let request = cache.get(path);
  if (!request) {
    request = api.get<Location[]>(path).catch(error => { cache.delete(path); throw error; });
    cache.set(path, request);
  }
  return request;
}

export function useVietnamLocations(provinceCode: string, enabled: boolean, retry: number) {
  const [result, setResult] = useState<{ key: string; data: Location[]; error: string; retry: number }>();
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    loadLocations(provinceCode).then(data => {
      if (active) setResult({ key: provinceCode, data, error: '', retry });
    }).catch(error => {
      if (active) setResult({ key: provinceCode, data: [], error: error.message, retry });
    });
    return () => { active = false; };
  }, [provinceCode, enabled, retry]);
  // Never render data from the preceding province, even before effects run.
  const current = result?.key === provinceCode && result.retry === retry ? result : undefined;
  return { data: current?.data || [], error: current?.error || '', loading: enabled && !current };
}
