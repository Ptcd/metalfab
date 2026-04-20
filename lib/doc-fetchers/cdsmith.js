/**
 * CD Smith doc fetcher.
 *
 * cdsmithplans.com project detail pages require login (ReproConnect/Blueprint).
 * We don't currently have credentials wired up, so this flags auth_required.
 * When credentials are provisioned, replace with a real implementation that
 * logs in and pulls the project's planroom attachments.
 */

module.exports = {
  async findCandidates(/* opp */) {
    return {
      authRequired: true,
      candidates: [],
      reason: 'cdsmithplans.com detail requires login',
    };
  },
};
