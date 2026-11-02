import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
export { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';

export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_IO_TIMEOUT_MS = 120_000;
export class GmailConnectionError extends Error {}
export class GmailRequestTimeoutError extends GmailConnectionError {
  constructor() { super('The Gmail mailbox request timed out independently of the verification-email wait. Its result is incomplete.'); this.name = 'GmailRequestTimeoutError'; }
}
export class GmailReadCancelledError extends GmailConnectionError {
  constructor() { super('The Gmail read request was cancelled.'); this.name = 'GmailReadCancelledError'; }
}
export interface GmailMessage {
  id: string; subject?: string; sender?: string; date?: string;
  plaintextBody?: string; htmlBody?: string; snippet?: string; labelIds?: string[];
}
export interface GmailThread { id: string; messages?: GmailMessage[] }
export interface EmailReceipt { messageId: string; threadId?: string; alreadySent?: boolean }
export interface GmailMcpConnection { url: string; token: string; account: string }

/** Every mailbox operation uses MCP; this client never knows a Google token. */
export class GmailMcpClient {
  private client?: Client;
  private connecting?: Promise<Client>;
  private connection: GmailMcpConnection;
  private network: typeof fetch;
  private signal?: AbortSignal;
  private requestTimeoutMs: number;
  private readonly clientId = randomUUID();
  private readonly cancellations = new Set<Promise<Response>>();
  constructor(connection: GmailMcpConnection, network: typeof fetch = fetch, options: { signal?: AbortSignal; requestTimeoutMs?: number } = {}) {
    this.connection = connection; this.network = network;
    this.signal = options.signal;
    this.requestTimeoutMs = options.requestTimeoutMs ?? GMAIL_IO_TIMEOUT_MS;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0 || this.requestTimeoutMs > GMAIL_IO_TIMEOUT_MS) throw new GmailConnectionError('Invalid Gmail request timeout.');
    const url = new URL(connection.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/gmail/mcp'
      || url.username || url.password || url.search || url.hash) throw new GmailConnectionError('Invalid Gmail MCP connection. Reconnect Gmail in Setup.');
  }
  private async connected(): Promise<Client> {
    this.signal?.throwIfAborted();
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const client = new Client({ name: 'owtomate-applications', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(this.connection.url), {
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set('Authorization', `Bearer ${this.connection.token}`);
          headers.set('X-Owtomate-Gmail-Client', this.clientId);
          let cancellation = false;
          try { cancellation = JSON.parse(String(init?.body)).method === 'notifications/cancelled'; } catch { /* Non-JSON transport work follows ordinary lifetime rules. */ }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new GmailRequestTimeoutError()), cancellation ? 1000 : this.requestTimeoutMs);
          // The cancellation notification must survive the operation it cancels.
          // It carries only this client's request ID, never a new mailbox action.
          const signal = cancellation ? controller.signal : AbortSignal.any([controller.signal, ...(this.signal ? [this.signal] : []), ...(init?.signal ? [init.signal] : [])]);
          const pending = this.network(input, { ...init, headers, signal, redirect: 'error' });
          if (cancellation) this.cancellations.add(pending);
          try { return await pending; }
          catch (error) { if (signal.aborted) throw signal.reason; throw error; }
          finally { clearTimeout(timer); this.cancellations.delete(pending); }
        }, requestInit: { redirect: 'error' },
      });
      try { await client.connect(transport, { timeout: Math.min(25_000, this.requestTimeoutMs) }); this.signal?.throwIfAborted(); this.client = client; return client; }
      catch (error) { await client.close().catch(() => {}); throw error; }
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async call(name: 'search_threads' | 'get_thread' | 'send_application_email', args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const result = await (await this.connected()).callTool({ name, arguments: args }, undefined, { timeout: this.requestTimeoutMs, signal: this.signal });
      if (result.isError) {
        const failure = result.structuredContent as Record<string, unknown> | undefined;
        const code = failure?.code;
        const message = typeof failure?.message === 'string' ? failure.message.slice(0, 500) : '';
        if (code === 'reconnect') throw new GmailConnectionError(`Reconnect Gmail in Settings. ${message || 'Mailbox authorization is unavailable.'}`);
        if (code === 'unavailable') throw new GmailConnectionError(message || 'Gmail is temporarily unavailable. Retry the mailbox request.');
        if (code === 'uncertain') throw new GmailConnectionError('The email send could not be confirmed. Check Gmail Sent before retrying; Owtomate will not send a duplicate.');
        if (code === 'unapproved') throw new GmailConnectionError(String((result.structuredContent as Record<string, unknown>)?.message || 'Review and confirm this email application again.').slice(0, 300));
        throw new GmailConnectionError('Gmail MCP could not complete this request. Check the Gmail connection and approved application.');
      }
      const data = result.structuredContent;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid MCP result');
      return data as Record<string, unknown>;
    } catch (error) {
      if (this.signal?.aborted) throw this.signal.reason;
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) throw new GmailRequestTimeoutError();
      throw safeGmailError(error);
    }
  }
  async search(query: string): Promise<GmailThread[]> {
    const result = await this.call('search_threads', { query, pageSize: 20 });
    if (!Array.isArray(result.threads)) throw new GmailConnectionError('Gmail MCP returned an invalid thread list.');
    return result.threads.filter((thread): thread is GmailThread => Boolean(thread && typeof thread.id === 'string')).slice(0, 20);
  }
  async thread(threadId: string): Promise<GmailMessage[]> {
    const result = await this.call('get_thread', { threadId });
    if (!Array.isArray(result.messages)) throw new GmailConnectionError('Gmail MCP returned an invalid email thread.');
    return result.messages.filter((message): message is GmailMessage => Boolean(message && typeof message.id === 'string')).slice(-20);
  }
  async sendApproved(reviewId: string, revision: string): Promise<EmailReceipt> {
    const result = await this.call('send_application_email', { reviewId, revision });
    if (typeof result.messageId !== 'string' || !result.messageId) throw new GmailConnectionError('Gmail did not confirm the email send.');
    return result as unknown as EmailReceipt;
  }
  async close(): Promise<void> { await this.client?.close().catch(() => {}); this.client = undefined; await Promise.allSettled([...this.cancellations]); }
}
export function safeGmailError(error: unknown): GmailConnectionError {
  return error instanceof GmailConnectionError ? error : new GmailConnectionError('Gmail MCP could not be reached. Retry later or reconnect Gmail in Setup.');
}
