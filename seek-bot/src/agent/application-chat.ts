import { applicationAgentIdentity } from '../application-model.js';
import { celerisChat, type CelerisReply, type CelerisRequest } from './celeris.js';
import { openrouterChat } from './openrouter.js';

/** Application writing, browser work and supervision share the applying provider.
 * Job review uses its separate route; neither route falls back to another model. */
export function applicationChat(request: CelerisRequest): Promise<CelerisReply> {
  return applicationAgentIdentity().provider === 'OpenRouter' ? openrouterChat(request) : celerisChat(request);
}

/** Only suitability evaluation enters this route. Never inherit the applying model. */
export function reviewChat(request: CelerisRequest): Promise<CelerisReply> {
  return celerisChat({ ...request, model: 'celeris-1-magnus', thinking: true });
}
/** Non-rejecting ordering of discovered listings retains the lightweight model. */
export function rankingChat(request: CelerisRequest): Promise<CelerisReply> {
  return celerisChat({ ...request, model: 'celeris-1', thinking: false });
}
