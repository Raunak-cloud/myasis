import { applicationAgentIdentity } from '../application-model.js';
import { celerisChat, type CelerisReply, type CelerisRequest } from './celeris.js';
import { openrouterChat } from './openrouter.js';

/** One tool loop and one budget for either provider, including consultations.
 * Matching and other background Celeris calls do not use this router. */
export function applicationChat(request: CelerisRequest): Promise<CelerisReply> {
  return applicationAgentIdentity().selection === 'minimax' ? openrouterChat(request) : celerisChat(request);
}
