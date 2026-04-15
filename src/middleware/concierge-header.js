/**
 * Concierge Header Middleware — X-Hive-Concierge-Suggestion
 *
 * Adds contextual upsell / next-action suggestions to every successful response
 * based on the route that was matched.
 */

import { getCensus } from '../services/agent-foundry.js';

// Route-specific suggestion generators (path prefix -> fn(req, res, body))
const SUGGESTIONS = [
  {
    match: (method, path) => method === 'POST' && path === '/v1/forge/mint',
    suggestion: () =>
      'Agent minted. Boost visibility with POST /v1/boost/purchase (24h visibility boost for $5 USDC)',
  },
  {
    match: (method, path) => method === 'GET' && path === '/v1/population/census',
    suggestion: async () => {
      const census = await getCensus();
      return `Your ecosystem has ${census.total_agents} agents. Crossbreed top performers to create elite offspring: POST /v1/forge/crossbreed`;
    },
  },
  {
    match: (method, path) => method === 'POST' && path === '/v1/bazaar/discover',
    suggestion: (req, res, body) => {
      const n = body?.data?.total_matches ?? body?.data?.matches?.length ?? 0;
      return `Found ${n} listings. Negotiate bulk pricing for 3+ capabilities: POST /v1/bazaar/negotiate`;
    },
  },
  {
    match: (method, path) => method === 'POST' && path === '/v1/spawner/trigger',
    suggestion: (req, res, body) => {
      const n = body?.data?.agents_spawned ?? 0;
      return `Spawned ${n} agents. Priority spawns skip the queue: POST /v1/spawner/priority-trigger`;
    },
  },
];

/**
 * Middleware: intercept res.json on successful responses to add
 * X-Hive-Concierge-Suggestion header.
 */
export function conciergeHeader() {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = function conciergeJson(body) {
      // Only add suggestion on 2xx responses
      // Use originalUrl (not req.path) since routes are mounted on sub-paths
      const fullPath = req.originalUrl.split('?')[0];
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const rule = SUGGESTIONS.find((s) => s.match(req.method, fullPath));
        if (rule) {
          const result = rule.suggestion(req, res, body);
          if (result && typeof result.then === 'function') {
            // Async suggestion — resolve then send
            return result
              .then((suggestion) => {
                res.set('X-Hive-Concierge-Suggestion', suggestion);
                if (body && typeof body === 'object' && !Array.isArray(body)) {
                  body.concierge_suggestion = suggestion;
                }
                return originalJson(body);
              })
              .catch(() => originalJson(body));
          }
          res.set('X-Hive-Concierge-Suggestion', result);
          if (body && typeof body === 'object' && !Array.isArray(body)) {
            body.concierge_suggestion = result;
          }
        }
      }
      return originalJson(body);
    };

    next();
  };
}
