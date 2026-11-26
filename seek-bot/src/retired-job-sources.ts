// These providers no longer have dedicated search adapters. Their application
// forms are handled by the same browser as other public destinations.
const retiredDiscoveryPlatforms = new Set(['lever', 'web-search', 'smartrecruiters', 'pageup']);
export const RETIRED_SOURCE_SETTING_KEYS = ['LEVER_COMPANIES', 'SMARTRECRUITERS_COMPANIES', 'SMARTRECRUITERS_ADMIN_ENABLED', 'PAGEUP_SITES'];
// Historical source-only skips must not suppress a future application.
export const RETIRED_SOURCE_MESSAGE = 'This job source is no longer available.';

export function retiredDiscoveryPlatform(platform: string): boolean {
  return retiredDiscoveryPlatforms.has(platform);
}
