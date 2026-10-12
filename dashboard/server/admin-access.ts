import { readEnv } from './runner.js';

/** Resolve per call so administrator changes take effect on the next request. */
export function adminAddresses(): string[] {
  return [...new Set((process.env.ADMIN_EMAILS ?? readEnv().ADMIN_EMAILS ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean))];
}

export function isAdmin(email?: string | null): boolean {
  return Boolean(email && adminAddresses().includes(email.toLowerCase()));
}
