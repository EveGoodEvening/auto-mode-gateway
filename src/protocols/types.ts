/** A complete execution input; incomplete/invalid inputs never reach a decision callback. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  raw: unknown;
}

/** Extracted metadata only. Forward the original request bytes, never this parsed view. */
export interface RequestContext {
  model?: string;
  system?: unknown;
  tools?: unknown[];
  messages?: unknown[];
  safeguards?: unknown;
  stream: boolean;
  classifier_context?: unknown;
  lastUserText?: string;
}

/** Temporary C05 seam, not an installed security gate. C08 replaces fixture-only allow. */
export interface AdapterOptions {
  signal: AbortSignal;
  onToolCalls: (
    calls: readonly ToolCall[],
    context: RequestContext,
    signal: AbortSignal,
  ) => Promise<'allow' | 'block'>;
}

export interface ProtocolAdapter {
  extractRequest(body: Uint8Array): RequestContext | undefined;
  transformResponse(response: Response, context: RequestContext, options: AdapterOptions): Promise<Response>;
}
