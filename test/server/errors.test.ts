import { describe, expect, it } from 'vitest';
import { errorResponse, upstreamErrorResponse } from '../../src/server/errors.js';

describe('locally generated errors', () => {
  it('uses the Anthropic error envelope for explicit safe messages', async () => {
    const response = errorResponse(413, 'request_too_large', 'Request body too large');
    expect(response.status).toBe(413);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ type: 'error', error: { type: 'request_too_large', message: 'Request body too large' } });
  });

  it.each([
    [502, 'api_error', 'Upstream connection failed'],
    [504, 'timeout_error', 'Upstream request timed out'],
  ] as const)('returns a fixed safe %i diagnostic', async (status, type, message) => {
    const response = upstreamErrorResponse(status);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ type: 'error', error: { type, message } });
  });
});
