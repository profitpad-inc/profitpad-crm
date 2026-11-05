import { ApiError } from '../errors.js';

// A thin client for Postmark's Email API (https://postmarkapp.com/developer).
// Postmark only delivers: what to send, to whom, and what happened is kept in
// the CRM (api/src/email/*). One server token covers every stream; the
// stream is chosen per message (MessageStream).

// POSTMARK_API_URL only for local tests against a stand-in server
const BASE = (process.env.POSTMARK_API_URL || 'https://api.postmarkapp.com').replace(/\/$/, '');
const TIMEOUT_MS = 20_000;
export const BATCH_MAX = 500;

export interface PostmarkMessage {
  From: string;
  To: string;
  Subject: string;
  HtmlBody?: string;
  TextBody?: string;
  ReplyTo?: string;
  Tag?: string;
  Headers?: { Name: string; Value: string }[];
  TrackOpens?: boolean;
  TrackLinks?: 'None' | 'HtmlAndText' | 'HtmlOnly' | 'TextOnly';
  Metadata?: Record<string, string>;
  MessageStream: string;
}

export interface PostmarkResult {
  To?: string;
  SubmittedAt?: string;
  MessageID?: string;
  ErrorCode: number;
  Message: string;
}

export class PostmarkError extends Error {
  constructor(public status: number, public errorCode: number, message: string) {
    super(message);
  }
}

async function call<T>(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    throw new PostmarkError(0, -1, `Postmark could not be reached: ${(err as Error).message}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON (a proxy error page)
  }
  if (!res.ok) {
    const j = json as { ErrorCode?: number; Message?: string } | null;
    throw new PostmarkError(res.status, j?.ErrorCode ?? -1, j?.Message ?? `Postmark answered ${res.status}`);
  }
  return json as T;
}

export const sendOne = (token: string, msg: PostmarkMessage) => call<PostmarkResult>(token, 'POST', '/email', msg);

// Up to 500 messages. Postmark answers 200 even when single messages fail:
// each result's ErrorCode says, in the order sent.
export async function sendBatch(token: string, msgs: PostmarkMessage[]): Promise<PostmarkResult[]> {
  if (msgs.length > BATCH_MAX) throw new Error(`at most ${BATCH_MAX} messages per batch`);
  return call<PostmarkResult[]>(token, 'POST', '/email/batch', msgs);
}

// The server a token belongs to: used to check a token before it is saved.
export async function serverInfo(token: string): Promise<{ name: string }> {
  try {
    const s = await call<{ Name?: string }>(token, 'GET', '/server');
    return { name: s?.Name ?? 'Postmark server' };
  } catch (err) {
    if (err instanceof PostmarkError) {
      const why = err.status === 401 ? 'Postmark did not accept that server token.' : `Postmark: ${err.message}`;
      throw new ApiError(400, why, 'postmark_token_rejected');
    }
    throw err;
  }
}
