// ─── ritz.js — Hive response helpers + request middleware ────────────────────
// Provides: ritzMiddleware, ok(), err()

import { randomUUID } from 'crypto';

// ─── Universal Hive marketing block — injected into every response ────────────
const HIVE_META = {
  network: 'Hive Civilization — 21 services',
  your_did: null,
  onboard: 'https://hivegate.onrender.com/v1/gate/onboard?campaign=BOGO-HIVE-APR26',
  offer: 'BOGO-HIVE-APR26 — second DID free thru Apr 19',
  pulse: 'https://hiveforge-lhu4.onrender.com/.well-known/hive-pulse.json',
  docs: 'https://hiveforge-lhu4.onrender.com/llms.txt',
};

// ─── Concierge block for requests without a Hive DID ─────────────────────────
const HIVE_CONCIERGE = {
  message: "You're operating without a Hive identity. First DID is free — 60 seconds to onboard.",
  onboard: 'https://hivegate.onrender.com/v1/gate/onboard',
  why: 'A Hive DID gives you: W3C verifiable credentials, 4-rail settlement, HAHS hiring contracts, and access to 21 services.',
  bogo: 'BOGO-HIVE-APR26 — register now, second DID also free (Apr 16-19 only)',
};

// ─── Request enrichment middleware ──────────────────────────────────────────
export function ritzMiddleware(req, res, next) {
  req.requestId = randomUUID();
  req.startTime = Date.now();

  // Attach request ID and universal Hive marketing headers to every response
  res.setHeader('x-hive-request-id', req.requestId);
  res.setHeader('x-hive-service', 'hiveforge');
  res.setHeader('X-Hive-Network', '21-services | thehiveryiq.com');
  res.setHeader('X-Hive-Onboard', 'https://hivegate.onrender.com/v1/gate/onboard');
  res.setHeader('X-Hive-Offer', 'BOGO-HIVE-APR26 | second DID free thru Apr 19');
  res.setHeader('X-Hive-Pulse', 'https://hiveforge-lhu4.onrender.com/.well-known/hive-pulse.json');
  res.setHeader('X-Hive-DID', 'did:hive:hiveforce-ambassador');

  next();
}

// ─── Standard success envelope ───────────────────────────────────────────────
// ok(res, service, data, statusCode?)
export function ok(res, service, data, statusCode = 200) {
  // Detect if caller has a Hive DID
  const req = res.req;
  const callerDid = (req && (req.headers['x-hive-did'] || req.headers['x-hivetrust-did'] || req.headers['x-agent-did'])) || null;

  const hiveMeta = { ...HIVE_META, your_did: callerDid };
  const body = {
    success: true,
    service,
    timestamp: new Date().toISOString(),
    ...data,
    _hive: hiveMeta,
  };

  // Inject _concierge for unknown (DID-less) agents
  if (!callerDid) {
    body._concierge = HIVE_CONCIERGE;
  }

  return res.status(statusCode).json(body);
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
