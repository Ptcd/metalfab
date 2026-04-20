/**
 * lib/doc-fetchers/index.js — dispatch table for per-source doc fetchers.
 *
 * Each fetcher exports an async function: findCandidates(opp) -> {
 *   candidates: [{url, filename, category?}],
 *   cookiesFile?: string,
 *   authRequired?: boolean,
 *   reason?: string,
 * }
 *
 * Supported today:   samgov, samgov-sgs, usaspending, milwaukee, mke-county, cullen
 * Auth-required:     bidnet, cdsmith, buildingconnected, stevens, scherrer, bonfire,
 *                    demandstar, questcdn, sigma, bidbuy
 */

const samgov = require('./samgov');
const milwaukee = require('./milwaukee');
const mkeCounty = require('./mke-county');
const cullen = require('./cullen');
const cdsmith = require('./cdsmith');
const bidnet = require('./bidnet');

const AUTH_REQUIRED = {
  authRequired: true,
  reason: 'portal requires login',
  candidates: [],
};
function stub() { return async () => AUTH_REQUIRED; }

const FETCHERS = {
  samgov: samgov.findCandidates,
  'samgov-sgs': samgov.findCandidates,
  usaspending: samgov.findCandidates,
  milwaukee: milwaukee.findCandidates,
  'mke-county': mkeCounty.findCandidates,
  cullen: cullen.findCandidates,
  cdsmith: cdsmith.findCandidates,
  bidnet: bidnet.findCandidates,
  buildingconnected: stub(),
  stevens: stub(),
  scherrer: stub(),
  bonfire: stub(),
  demandstar: stub(),
  questcdn: stub(),
  sigma: stub(),
  bidbuy: stub(),
  constructconnect: stub(),
};

function getFetcher(source) {
  return FETCHERS[source] || null;
}

module.exports = { getFetcher, FETCHERS };
