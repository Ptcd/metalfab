/**
 * BidNet Direct doc fetcher.
 *
 * BidNet requires authenticated session + session cookies to download
 * solicitation documents. The existing fetch-bidnet.js scraper does log in,
 * but cookie preservation for downloads is not yet wired here. Flag
 * auth_required until credentials + cookie export are added.
 */

module.exports = {
  async findCandidates(/* opp */) {
    return {
      authRequired: true,
      candidates: [],
      reason: 'BidNet Direct requires authenticated session for downloads',
    };
  },
};
