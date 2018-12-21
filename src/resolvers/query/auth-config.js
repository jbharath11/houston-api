/*
 * Get information about how auth is configured for the cluster.
 * @param {Object} parent The result of the parent resolver.
 * @param {Object} args The graphql arguments.
 * @param {Object} ctx The graphql context.
 * @return {AuthConfig} The auth config.
 */
export default async function authConfig(parent, args, ctx) {
  console.log(args);
}
