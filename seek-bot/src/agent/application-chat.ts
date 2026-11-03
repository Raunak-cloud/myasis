import { applicationAgentIdentity } from '../application-model.js';
import { celerisChat, type CelerisReply, type CelerisRequest } from './celeris.js';
import { openrouterChat } from './openrouter.js';

/** The authorized run selection owns every stage. Neither route falls back to another model. */
export function applicationChat(request: CelerisRequest): Promise<CelerisReply> {
  return applicationAgentIdentity().provider === 'OpenRouter' ? openrouterChat(request) : celerisChat({ ...request, model: 'celeris-1-magnus', thinking: true });
}

/** Normal customer suitability uses Magnus; admin MiniMax runs use only MiniMax. */
export function reviewChat(request: CelerisRequest): Promise<CelerisReply> {
  return applicationChat(request);
}
/** Non-rejecting ordering of discovered listings retains the lightweight model. */
export function rankingChat(request: CelerisRequest): Promise<CelerisReply> {
  return applicationAgentIdentity().provider === 'OpenRouter' ? openrouterChat(request)
    : celerisChat({ ...request, model: 'celeris-1', thinking: false });
}
