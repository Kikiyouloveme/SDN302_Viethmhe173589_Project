export interface Location { code: string; name: string }
export interface LocationValue {
  provinceCode: string;
  province: string;
  wardCode: string;
  ward: string;
}
export const emptyLocation: LocationValue = { provinceCode: '', province: '', wardCode: '', ward: '' };

export function normalizeLocation(text: string) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function matchesLocation(location: Location, query: string) {
  const search = normalizeLocation(query).replace(/\s/g, '');
  return normalizeLocation(location.name).replace(/\s/g, '').includes(search) || location.code.includes(search);
}

/** Only an exact unique name within its parent is eligible for legacy preselection. */
export function resolveLocation(list: Location[], code: unknown, name: string | undefined, width: number) {
  if (code !== undefined && code !== null && code !== '') {
    const raw = String(code);
    return /^\d+$/.test(raw) ? list.find(item => item.code === raw.padStart(width, '0')) : undefined;
  }
  const matches = list.filter(item => normalizeLocation(item.name) === normalizeLocation(name || ''));
  return matches.length === 1 ? matches[0] : undefined;
}
