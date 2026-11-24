import { applicationAgentIdentity } from '../application-model.js';
import { celerisChat, type CelerisReply, type CelerisRequest } from './celeris.js';
import { openrouterChat, qwenReviewChat } from './openrouter.js';

/** The authorized applying model owns writing, recovery and browser decisions. */
export function applicationChat(request: CelerisRequest): Promise<CelerisReply> {
  return applicationAgentIdentity().provider === 'OpenRouter' ? openrouterChat(request) : celerisChat({ ...request, model: 'celeris-1-magnus', thinking: true });
}

export function reviewChat(request: CelerisRequest): Promise<CelerisReply> {
  return qwenReviewChat(request);
}
export function rankingChat(request: CelerisRequest): Promise<CelerisReply> {
  return qwenReviewChat(request);
}
