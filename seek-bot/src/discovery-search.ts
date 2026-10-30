export type SearchArrangement = 'onsite' | 'hybrid' | 'remote';

export interface DiscoverySearch {
  location: string;
  radiusKm: number;
  arrangements: SearchArrangement[];
  label: string;
}

/** Translate saved location preferences into board searches before spending reviews. */
export function discoverySearches(
  search: { location: string; radiusKm: number },
  rules: { onsiteCity: string; workArrangements: readonly string[] },
): DiscoverySearch[] {
  const arrangements = (['onsite', 'hybrid', 'remote'] as const).filter(value =>
    !rules.workArrangements.length || rules.workArrangements.includes(value));
  const city = rules.onsiteCity.trim();
  const address = search.location.trim();
  // A candidate's explicit distance restriction still centres on their address.
  if (address && Number.isFinite(search.radiusKm) && search.radiusKm > 0) {
    return [{ location: address, radiusKm: search.radiusKm, arrangements, label: `${search.radiusKm} km from ${address}` }];
  }
  if (!city) return [{ location: '', radiusKm: 0, arrangements, label: 'Australia' }];
  const searches: DiscoverySearch[] = [];
  const office = arrangements.filter(value => value !== 'remote');
  if (office.length) searches.push({ location: city, radiusKm: 0, arrangements: office, label: `${city} (${office.join('/')})` });
  if (arrangements.includes('remote')) searches.push({ location: '', radiusKm: 0, arrangements: ['remote'], label: 'Remote (Australia)' });
  return searches;
}
