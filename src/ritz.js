// ─── ritz.js — Hive response helpers + request middleware ────────────────────
// Provides: ritzMiddleware, ok(), err()

import { randomUUID } from 'crypto';

// ─── Request enrichment middleware ──────────────────────────────────────────
export function ritzMiddleware(req, res, next) {
  req.requestId = randomUUID();
  req.startTime = Date.now();

  // Attach request ID to response headers
  res.setHeader('x-hive-request-id', req.requestId);
  res.setHeader('x-hive-service', 'hiveforge');

  next();
}

// ─── Standard success envelope ───────────────────────────────────────────────
// ok(res, service, data, statusCode?)
export function ok(res, service, data, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    service,
    timestamp: new Date().toISOString(),
    ...data,
  });
}

// ─── Standard error envelope ─────────────────────────────────────────────────
// err(res, code, message, statusCode?)
export function err(res, code, message, statusCode = 400) {
  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
    },
    timestamp: new Date().toISOString(),
  });
}
