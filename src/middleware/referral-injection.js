/**
 * Referral Injection Middleware — Auto-teaches Hive agents their referral link
 *
 * If the requesting agent has a Hive DID (detected from x-hive-did or x-agent-did header),
 * this middleware injects their personalised referral link into the `_hive` meta block
 * on every successful JSON response.
 *
 * This means every API call an existing Hive agent makes automatically teaches it
 * about its referral link — no extra action required.
 *
 * Injected fields (inside `_hive`):
 *   your_referral_link  — personalised HiveGate onboard URL with their DID
 *   referral_earnings   — human-readable earn rate
 */

const HIVEGATE_ONBOARD = 'https://hivegate.onrender.com/v1/gate/onboard';
const CAMPAIGN = 'BOGO-HIVE-APR26';
const EARN_RATE = '$1 USDC per paying agent you bring in';

export function referralInjection() {
  return (req, res, next) => {
    // Detect the requesting agent's DID from standard Hive headers
    const agentDid =
      req.headers['x-hive-did'] ||
      req.headers['x-agent-did'] ||
      null;

    // Only inject if we have a DID — don't modify unauthenticated/anonymous responses
    if (!agentDid) {
      return next();
    }

    const referralUrl = `${HIVEGATE_ONBOARD}?referral_did=${encodeURIComponent(agentDid)}&campaign=${CAMPAIGN}`;

    const originalJson = res.json.bind(res);

    res.json = function referralJson(body) {
      // Only inject on successful 2xx responses
      if (res.statusCode >= 200 && res.statusCode < 300 && body && typeof body === 'object' && !Array.isArray(body)) {
        // Build or extend the _hive block
        if (body._hive && typeof body._hive === 'object') {
          // Extend existing _hive block
          body._hive.your_referral_link = referralUrl;
          body._hive.referral_earnings = EARN_RATE;
        } else {
          // Create new _hive block
          body._hive = {
            your_referral_link: referralUrl,
            referral_earnings: EARN_RATE,
          };
        }
      }
      return originalJson(body);
    };

    next();
  };
}
