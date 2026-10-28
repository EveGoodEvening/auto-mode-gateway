// Only fixed, explicitly safe messages belong in locally generated errors.
// Responses returned by an upstream do not pass through this formatter.
export function errorResponse(status: number, type: string, message: string): Response {
  return Response.json({ type: 'error', error: { type, message } }, { status });
}

export function upstreamErrorResponse(status: 502 | 504): Response {
  return errorResponse(status, status === 504 ? 'timeout_error' : 'api_error',
    status === 504 ? 'Upstream request timed out' : 'Upstream connection failed');
}
