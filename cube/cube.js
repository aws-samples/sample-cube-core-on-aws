// Cube configuration file. Docs: https://cube.dev/docs/product/configuration/reference/config
//
// Everything in this folder (cube.js + model/) is uploaded to S3 by `./deploy.sh` and
// synced into every Cube container at start-up. Change files here and re-run ./deploy.sh.
module.exports = {
  // Example of row-level security driven by the JWT security context
  // (see scripts/gen-token.mjs --claims '{"region":"Europe"}'):
  //
  // queryRewrite: (query, { securityContext }) => {
  //   if (securityContext.region) {
  //     query.filters.push({ member: 'orders.region', operator: 'equals', values: [securityContext.region] });
  //   }
  //   return query;
  // },
  //
  // If you use queryRewrite, also define scheduledRefreshContexts so that the refresh
  // worker can build pre-aggregations for every tenant.
};
