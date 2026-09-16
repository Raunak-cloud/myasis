import { existsSync } from 'node:fs';
import { open as openMmdb, type CityResponse } from 'maxmind';
import { readEnv } from './runner.js';

/**
 * Where a visitor is, from their address, answered on this machine.
 *
 * The database is a MaxMind-format file named by GEOIP_DB in seek-bot/.env —
 * DB-IP's free city database, fetched by deploy/geoip-update.sh, or MaxMind's
 * own GeoLite2-City. Looking an address up in a file is a microsecond and
 * sends nothing anywhere, which is the point: a job-seeker's address never
 * leaves the server just to be turned into a city name.
 *
 * Without a database every lookup answers with nothing and the Visitors view
 * says so; the rest of the analytics keep working.
 */

export interface GeoPlace {
  countryCode: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
}

export const NO_PLACE: GeoPlace = { countryCode: null, country: null, region: null, city: null, latitude: null, longitude: null };

type CityReader = Awaited<ReturnType<typeof openMmdb<CityResponse>>>;

let reader: Promise<CityReader | null> | null = null;
let warnedMissing = false;

function databasePath(): string {
  return (process.env.GEOIP_DB ?? readEnv().GEOIP_DB ?? '').trim();
}

/** Whether a database is in place, for the Visitors view to explain empty locations. */
export function geoipConfigured(): boolean {
  const path = databasePath();
  return Boolean(path && existsSync(path));
}

/**
 * Opened once, on first use, and watched: the monthly refresh replaces the
 * file in place and the reader reloads it, so no restart is needed. A missing
 * file is not cached as a failure — a database dropped in later is picked up
 * on the next lookup.
 */
function reading(): Promise<CityReader | null> {
  if (reader) return reader;
  const path = databasePath();
  if (!path || !existsSync(path)) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(`[geoip] no database at GEOIP_DB=${path || '(unset)'}; visitors will have no location until one is installed`);
    }
    return Promise.resolve(null);
  }
  reader = openMmdb<CityResponse>(path, { watchForUpdates: true }).catch((error) => {
    console.warn(`[geoip] could not open ${path}: ${(error as Error).message}`);
    reader = null;
    return null;
  });
  return reader;
}

export async function lookupPlace(ip: string | null): Promise<GeoPlace> {
  if (!ip) return NO_PLACE;
  const db = await reading();
  if (!db) return NO_PLACE;
  let hit: CityResponse | null;
  try {
    hit = db.get(ip);
  } catch {
    // A malformed address; the row is still worth keeping without a place.
    return NO_PLACE;
  }
  if (!hit) return NO_PLACE;
  return {
    countryCode: hit.country?.iso_code ?? null,
    country: hit.country?.names?.en ?? null,
    region: hit.subdivisions?.[0]?.names?.en ?? null,
    city: hit.city?.names?.en ?? null,
    latitude: hit.location?.latitude ?? null,
    longitude: hit.location?.longitude ?? null,
  };
}
