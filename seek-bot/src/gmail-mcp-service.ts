import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { EmailReceipt, GmailMcpConnection, GmailThread, GmailMessage } from './gmail-mcp-client.js';

export class GmailServiceError extends Error {
  code: 'reconnect' | 'unavailable' | 'unapproved' | 'uncertain';
  constructor(code: 'reconnect' | 'unavailable' | 'unapproved' | 'uncertain', message: string) { super(message); this.code = code; }
}
export interface GmailBackend {
  search(userId: string, query: string): Promise<GmailThread[]>;
  thread(userId: string, threadId: string): Promise<GmailMessage[]>;
  send(userId: string, reviewId: string, revision: string): Promise<EmailReceipt>;
}
interface Lease { userId: string; approvals: Set<string>; threads: Set<string>; expiresAt: number }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Private MCP gateway: per-run capabilities, never cookies or browser profiles. */
export class GmailMcpService {
  private server?: Server;
  private listening?: Promise<number>;
  private leases = new Map<string, Lease>();
  private backend: GmailBackend;
  constructor(backend: GmailBackend) { this.backend = backend; }
  private listen(): Promise<number> {
    this.listening ??= new Promise((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        const key = /^Bearer ([\w-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
        const lease = key ? this.leases.get(digest(key)) : undefined;
        if (req.headers.origin || req.url !== '/gmail/mcp' || !lease || lease.expiresAt < Date.now()) {
          res.writeHead(401).end(); return;
        }
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        let mcp: McpServer | undefined;
        let transport: StreamableHTTPServerTransport | undefined;
        try {
          const chunks: Buffer[] = []; let length = 0;
          for await (const chunk of req) {
            length += chunk.length;
            if (length > 32_768) { res.writeHead(413).end(); return; }
            chunks.push(Buffer.from(chunk));
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          mcp = new McpServer({ name: 'owtomate-gmail', version: '1.0.0' });
          const answer = async (work: () => Promise<unknown>) => {
            if (!key || this.leases.get(digest(key)) !== lease || lease.expiresAt < Date.now()) return {
              isError: true, content: [], structuredContent: { code: 'reconnect', message: 'The Gmail run capability expired.' },
            };
            try { return { content: [], structuredContent: await work() as Record<string, unknown> }; }
            catch (error) {
              return { isError: true, content: [{ type: 'text' as const, text: 'Gmail request could not complete.' }],
                structuredContent: { code: error instanceof GmailServiceError ? error.code : 'unavailable',
                  message: error instanceof GmailServiceError ? error.message : 'Gmail is temporarily unavailable.' } };
            }
          };
          mcp.registerTool('search_threads', { description: 'Search recent verification emails for this candidate.',
            inputSchema: { query: z.string().max(2000), pageSize: z.number().int().min(1).max(20).optional() } },
          ({ query }) => answer(async () => {
            const threads = await this.backend.search(lease.userId, query);
            for (const thread of threads) lease.threads.add(thread.id);
            return { threads };
          }));
          mcp.registerTool('get_thread', { description: 'Read messages in a thread returned for this candidate.', inputSchema: { threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) } },
            ({ threadId }) => answer(async () => {
              if (!lease.threads.has(threadId)) throw new GmailServiceError('unapproved', 'Search this mailbox before reading a thread.');
              return { messages: await this.backend.thread(lease.userId, threadId) };
            }));
          mcp.registerTool('send_application_email', { description: 'Send only the exact email application explicitly approved by this candidate. Recipients, documents and content come from the approved server record.',
            inputSchema: { reviewId: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/) } },
          ({ reviewId, revision }) => answer(async () => {
            if (!lease.approvals.has(reviewId)) throw new GmailServiceError('unapproved', 'This run cannot send that application.');
            return this.backend.send(lease.userId, reviewId, revision);
          }));
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          await mcp.connect(transport);
          await transport.handleRequest(req, res, body);
        } catch { if (!res.headersSent) res.writeHead(400).end(); }
        finally { await transport?.close().catch(() => {}); await mcp?.close().catch(() => {}); }
      });
      this.server.requestTimeout = 30_000;
      this.server.headersTimeout = 10_000;
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server!.unref(); resolve((this.server!.address() as { port: number }).port);
      });
    });
    return this.listening;
  }
  async grant(userId: string, account: string, approvals: string[] = []): Promise<{ connection: GmailMcpConnection; revoke: () => void }> {
    const port = await this.listen(), token = randomBytes(32).toString('base64url'), key = digest(token);
    for (const [id, lease] of this.leases) if (lease.expiresAt < Date.now()) this.leases.delete(id);
    this.leases.set(key, { userId, approvals: new Set(approvals), threads: new Set(), expiresAt: Date.now() + 4 * 60 * 60_000 });
    return { connection: { url: `http://127.0.0.1:${port}/gmail/mcp`, token, account }, revoke: () => { this.leases.delete(key); } };
  }
  async close(): Promise<void> {
    this.leases.clear();
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>(done => this.server!.close(() => done())); }
  }
}
