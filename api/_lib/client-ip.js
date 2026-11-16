/** Cloud Run appends the trusted final hop; direct peers own all forwarded headers. */
export function getClientIp(req) {
  if (!String(process.env.K_SERVICE || '').trim()) return req?.socket?.remoteAddress || 'unknown';
  const forwarded = req?.headers?.['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (typeof raw === 'string' && raw.trim()) {
    const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req?.socket?.remoteAddress || 'unknown';
}
