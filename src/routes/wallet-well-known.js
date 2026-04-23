/**
 * wallet-well-known.js
 * Express route handler for GET /.well-known/wallet.json
 *
 * Exposes the Hive Civilization treasury wallet metadata so that
 * x402 clients, payment SDKs, and service-discovery agents can
 * automatically resolve the correct payment destination.
 *
 * Usage:
 *   const walletWellKnown = require('./wallet-well-known');
 *   app.get('/.well-known/wallet.json', walletWellKnown);
 */

const WALLET_INFO = {
  address:  '0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe',
  network:  'base',
  asset:    'USDC',
  explorer: 'https://basescan.org/address/0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe',
  hive_services: [
    'HiveGate',
    'HiveTrust',
    'HiveLaw',
    'HiveBank',
    'HiveForge',
  ],
};

/**
 * Express route handler.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
function walletWellKnown(req, res) {
  res.set('Content-Type', 'application/json');
  res.set('Cache-Control', 'public, max-age=300');
  return res.status(200).json(WALLET_INFO);
}

export default walletWellKnown;
