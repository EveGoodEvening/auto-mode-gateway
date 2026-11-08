import type { Verdict } from '../gate/types.js';

/** A complete execution input; incomplete/invalid inputs never reach a decision callback. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  raw: unknown;
}

export type RequestProtocol = 'anthropic-messages' | 'openai-responses' | 'openai-chat';

/** Extracted metadata only. Forward the original request bytes, never this parsed view. */
export interface RequestContext {
  model?: string;
  system?: unknown;
  tools?: unknown[];
  messages?: unknown[];
  safeguards?: unknown;
  stream: boolean;
  classifier_context?: unknown;
  /** Latest user message text, including explicit empty text; excludes nested tool results. */
  lastUserText?: string;
  /** Authenticated ingress metadata; never extracted from model-generated output. */
  source?: {
    headers: Headers;
    route: string;
    identity?: string;
    session_id?: string;
    agent_version?: string;
  };
}

/** Complete calls receive individual real verdicts; adapters control safe delivery. */
export interface AdapterOptions {
  signal: AbortSignal;
  mode?: 'enforce' | 'shadow';
  delivery?: 'native' | 'rewrite';
  holdKeepaliveMs?: number;
  /**
   * Whole-turn tool decision deadline. Defaults to DECISION_TIMEOUT_MS (60s);
   * extended when a human may hold a decision. Upstream completion/idle bounds
   * remain independent and never run while decisions are awaited after EOF.
   */
  decisionTimeoutMs?: number;
  /**
   * Added to the whole-turn decision deadline for every tool call after the
   * first, so each sequential human wait has its own budget. Defaults to 0.
   */
  decisionExtensionMs?: number;
  onNativeDelivered?: () => void;
  /** Register detached shadow work so shutdown can drain its eventual audit. */
  trackObservation?: (work: Promise<void>) => void;
  onToolCall: (
    call: ToolCall,
    context: RequestContext,
    signal: AbortSignal,
  ) => Promise<Verdict>;
}

export interface ProtocolAdapter {
  extractRequest(body: Uint8Array): RequestContext | undefined;
  transformResponse(response: Response, context: RequestContext, options: AdapterOptions): Promise<Response>;
}
