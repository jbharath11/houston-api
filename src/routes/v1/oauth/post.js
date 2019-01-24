import fragment from "./fragment";
import { createUser as _createUser } from "users";
import { getProvider, orbit } from "oauth/config";
import { prisma } from "generated/client";
import { createJWT, setJWTCookie } from "jwt";
import { addMember } from "mailchimp";
import { first } from "lodash";
import querystring from "querystring";

/*
 * Handle oauth request.
 * @param {Object} req The request.
 * @param {Object} res The response.
 */
export default async function(req, res) {
  // Grab params out of the request body.
  const {
    id_token: idToken,
    expires_in: expiration,
    state: rawState
  } = req.body;

  // Parse the state object.
  const state = JSON.parse(decodeURIComponent(rawState));

  // Get the provider module.
  const provider = getProvider(state.provider);

  // Create a token.
  const data = {
    encodedJWT: idToken,
    expires: provider.expires(expiration)
  };

  // Validate the token.
  const jwt = await provider.validate(data);

  // Grab user data
  const { providerUserId, email, fullName, avatarUrl } = provider.userData(jwt);

  // Search for user in our system using email address.
  const user = first(
    await prisma
      .users({ where: { emails_some: { address: email } } })
      .$fragment(fragment)
  );

  // Set the userId, either the existing, or the newly created one.
  const userId = user
    ? user.id
    : await _createUser({
        username: email,
        fullName,
        email,
        inviteToken: state.inviteToken
      });

  // If we already have a user, update it.
  if (user) {
    await prisma.updateUser({
      where: { id: userId },
      data: { fullName, avatarUrl }
    });
  }

  // If we just created the user, also create and connect the oauth cred.
  if (!user) {
    await prisma.createOAuthCredential({
      oauthProvider: state.provider,
      oauthUserId: providerUserId,
      user: { connect: { id: userId } }
    });

    // Add user to Mailchimp list for onboarding.
    await addMember(email);
  }

  // Create the JWT.
  const { token } = createJWT(userId);

  // Set the cookie.
  setJWTCookie(res, token);

  // Build redirect query string.
  const qs = querystring.stringify({
    extras: JSON.stringify(state.extras),
    strategy: state.provider,
    token
  });

  // Respond with redirect to orbit.
  const url = `${orbit()}/${state.redirect}?${qs}`;
  const cleanUrl = url.replace(/([^:]\/)\/+/g, "$1");
  res.redirect(cleanUrl);
}
