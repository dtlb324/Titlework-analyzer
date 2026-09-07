/**
 * Client IP for rate limits. Cloud Run appends the connecting hop to
 * X-Forwarded-For without stripping client-supplied values, so the leftmost
 * entry is spoofable. Trust the rightmost hop (the one Cloud Run added).
 */
export function getClientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (typeof raw === 'string' && raw.trim()) {
    const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req?.socket?.remoteAddress || 'unknown';
}
