/**
 * IP Allowlist middleware for internal endpoints.
 * Only applies to requests carrying internal key headers.
 * If ALLOWED_INTERNAL_IPS is not set, skips check entirely (backward compatible).
 */

const ALLOWED_IPS = process.env.ALLOWED_INTERNAL_IPS
  ? process.env.ALLOWED_INTERNAL_IPS.split(',').map(ip => ip.trim()).filter(Boolean)
  : null;

/**
 * Get the client IP address, respecting reverse proxy headers.
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip;
}

export function ipAllowlist() {
  return (req, res, next) => {
    // Skip if no allowlist configured
    if (!ALLOWED_IPS) return next();

    // Only apply to requests with internal key headers
    const hasInternalKey = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
    if (!hasInternalKey) return next();

    const clientIp = getClientIp(req);

    if (!ALLOWED_IPS.includes(clientIp)) {
      console.warn(`[IP Allowlist] Blocked internal request from ${clientIp} to ${req.method} ${req.originalUrl}`);
      return res.status(403).json({
        success: false,
        error: 'Forbidden — IP not in allowlist for internal endpoints.',
      });
    }

    next();
  };
}
