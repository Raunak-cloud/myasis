import { applicationModel, applicationHaikuRoute } from '../application-model.js';

/** Shared executor capabilities for the native Haiku controller.
 * Historical browser-only model experiments are no longer runtime choices. */
export function haikuController() {
  if (applicationModel() !== 'haiku') return null;
  const route = applicationHaikuRoute();
  return { model: route.model, provider: route.provider, name: 'haiku' as const,
    compact: true, architecture: 'compact' as const };
}
