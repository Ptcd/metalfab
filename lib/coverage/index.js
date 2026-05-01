/**
 * lib/coverage — the coverage-manifest pipeline stage.
 *
 * Runs after plan-intelligence, before takeoff-prepare. The manifest
 * is the single artifact the takeoff agent must reconcile against:
 * every `included` entry needs covering takeoff lines or an explicit
 * intentional exclusion. The `manifest_coverage` validator enforces
 * this at takeoff-commit time.
 *
 * The shape exists because "no validator findings" was being treated
 * as "ready to bid", when really it just meant "nothing tripped a
 * heuristic". Coverage replaces that with an actual completeness
 * invariant — you can't ship without accounting for every in-scope
 * thing the policy says exists.
 */

const policy = require('./tcb-scope-policy');
const builder = require('./build-manifest');

module.exports = {
  ...policy,
  ...builder,
};
