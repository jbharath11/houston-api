import { ResourceNotFoundError } from "errors";
import { first } from "lodash";

/*
 * Verify a users email address.
 * @param {Object} parent The result of the parent resolver.
 * @param {Object} args The graphql arguments.
 * @param {Object} ctx The graphql context.
 * @return {Deployment} The updated Deployment.
 */
export default async function verifyEmail(parent, args, ctx) {
  // Pull out the email address.
  const { email } = args;
  const users = await ctx.db.query.users(
    {
      where: {
        emails_every: {
          address: email
        }
      }
    },
    `{ id }`
  );

  // There should be one or none.
  const user = first(users);

  // Throw error if user not found.
  if (!user) throw new ResourceNotFoundError();

  // Update email to be verified.
  const where = { id: user.id };
  const data = {
    emails: {
      update: { where: { address: email }, data: { verified: true } }
    },
    status: "active"
  };
  await ctx.db.mutation.updateUser({ where, data });

  // Always return true.
  return true;
}
