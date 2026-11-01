import { applicationAgentIdentity } from '../application-model.js';
import { celerisChat, type CelerisReply, type CelerisRequest } from './celeris.js';
import { openrouterChat } from './openrouter.js';

/** All run model requests use the selected provider, without cross-provider fallback. */
export function applicationChat(request: CelerisRequest): Promise<CelerisReply> {
  return applicationAgentIdentity().provider === 'OpenRouter' ? openrouterChat(request) : celerisChat(request);
}
