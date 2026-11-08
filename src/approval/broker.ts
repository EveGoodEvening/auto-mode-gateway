import { randomUUID } from 'node:crypto';

/** What a human sees. Every field is already redacted gateway state, never raw tool input. */
export interface ApprovalSubject {
  tool: string;
  kind: string;
  argv?: readonly string[];
  text?: string;
  paths: readonly string[];
  url?: string;
  workdir?: string;
  content_excerpt?: string;
  /** MCP tool arguments: redacted, display-only, bounded; untrusted agent output. */
  arguments?: string;
  arguments_truncated?: boolean;
  user_request?: string;
  route?: string;
  protocol?: string;
  session_id?: string;
  /** First-stage probabilities (untrusted model output). */
  probabilities?: Readonly<Record<string, number>>;
  /** Why the request escalated: gray first stage without reviewer, or uncertain reviewer. */
  escalation: 'gray-no-reviewer' | 'reviewer-uncertain';
  /** Redacted, bounded reviewer reason when a reviewer ran. */
  reviewer_reason?: string;
}

export type HumanDecision = 'allow' | 'block';
export type ApprovalResult =
  | { status: 'decided'; decision: HumanDecision; decided_at: number }
  | { status: 'timeout' }
  | { status: 'aborted' }
  | { status: 'rejected' };

export interface PendingApproval {
  id: string;
  created_at: number;
  expires_at: number;
  subject: ApprovalSubject;
}

export interface ResolvedApproval extends PendingApproval {
  resolved_at: number;
  result: 'allow' | 'block' | 'timeout' | 'aborted';
}

export interface ApprovalBrokerOptions {
  timeout_ms: number;
  max_pending: number;
  /** Bounded in-memory history for the UI; never persisted. */
  history_limit?: number;
  now?: () => number;
}

interface Entry extends PendingApproval {
  settle(result: ApprovalResult): void;
}

/**
 * Process-local queue of actions awaiting a human verdict. A request is settled
 * exactly once: by a human decision, its timeout, or caller cancellation. Every
 * non-decision settlement is treated as a block by the gate.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, Entry>();
  private readonly history: ResolvedApproval[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly historyLimit: number;
  private closed = false;

  constructor(private readonly options: ApprovalBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.historyLimit = options.history_limit ?? 50;
  }

  /** Resolves when a human decides, the timeout expires or `signal` aborts. Never rejects. */
  request(subject: ApprovalSubject, signal?: AbortSignal): Promise<ApprovalResult> {
    if (signal?.aborted) return Promise.resolve({ status: 'aborted' });
    // After shutdown no human can answer; reject instead of waiting for the timeout.
    if (this.closed) return Promise.resolve({ status: 'rejected' });
    if (this.pending.size >= this.options.max_pending) return Promise.resolve({ status: 'rejected' });
    const { promise, resolve } = Promise.withResolvers<ApprovalResult>();
    const created = this.now();
    const id = randomUUID();
    let settled = false;
    const onAbort = () => entry.settle({ status: 'aborted' });
    const timer = setTimeout(() => entry.settle({ status: 'timeout' }), this.options.timeout_ms);
    timer.unref?.();
    const entry: Entry = {
      id, created_at: created, expires_at: created + this.options.timeout_ms, subject,
      settle: (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        this.history.unshift({ id, created_at: entry.created_at, expires_at: entry.expires_at, subject,
          resolved_at: this.now(), result: result.status === 'decided' ? result.decision : result.status === 'timeout' ? 'timeout' : 'aborted' });
        this.history.length = Math.min(this.history.length, this.historyLimit);
        resolve(result);
        this.notify();
      },
    };
    this.pending.set(id, entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.notify();
    return promise;
  }

  /** Returns false when the id is unknown or already settled. */
  decide(id: string, decision: HumanDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.settle({ status: 'decided', decision, decided_at: this.now() });
    return true;
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map(({ id, created_at, expires_at, subject }) => ({ id, created_at, expires_at, subject }))
      .sort((a, b) => a.created_at - b.created_at);
  }

  recent(): ResolvedApproval[] {
    return this.history.map((item) => ({ ...item }));
  }

  get size(): number { return this.pending.size; }

  /** Change notification for long-poll/SSE UIs. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Settles every pending request as aborted (gate treats it as block). */
  close(): void {
    this.closed = true;
    for (const entry of [...this.pending.values()]) entry.settle({ status: 'aborted' });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* A UI listener must not affect decisions. */ }
    }
  }
}
