import pool from '../services/db.js';

/**
 * Detect source platform from request headers and user-agent.
 */
function detectPlatform(req) {
  // Check explicit source header first
  const hiveSource = req.headers['x-hive-source'];
  if (hiveSource) return hiveSource;

  // Check if internal key present — indicates platform-to-platform call
  if (req.headers['x-hive-internal-key'] || req.headers['x-api-key']) {
    return 'hive-internal';
  }

  // Detect from user-agent
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('hivetrust')) return 'hivetrust';
  if (ua.includes('hiveagent')) return 'hiveagent';
  if (ua.includes('hivemind')) return 'hivemind';
  if (ua.includes('hiveforge')) return 'hiveforge';

  return 'external';
}

/**
 * Audit logging middleware — logs every request to public.audit_log.
 * Fire-and-forget: never blocks or breaks requests.
 */
export function auditLogger() {
  return (req, res, next) => {
    const start = Date.now();
    const fromPlatform = detectPlatform(req);

    // Capture response finish to log status
    res.on('finish', () => {
      if (!pool) return;

      const durationMs = Date.now() - start;
      const did = req.agentDid || req.headers['x-hivetrust-did'] || null;

      pool.query(
        `INSERT INTO public.audit_log (from_platform, to_platform, endpoint, did, method, status_code, success, error_message, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          fromPlatform,
          'hiveforge',
          req.originalUrl || req.url,
          did,
          req.method,
          res.statusCode,
          res.statusCode < 400,
          res.statusCode >= 400 ? `HTTP ${res.statusCode}` : null,
          durationMs,
        ]
      ).catch(() => {
        // Audit logging should never break the request
      });
    });

    next();
  };
}
