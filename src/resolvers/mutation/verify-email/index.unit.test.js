import resolvers from "resolvers";
import casual from "casual";
import { graphql } from "graphql";
import { makeExecutableSchema } from "graphql-tools";
import { importSchema } from "graphql-import";

// Import our application schema
const schema = makeExecutableSchema({
  typeDefs: importSchema("src/schema.graphql"),
  resolvers
});

// Define our mutation
const mutation = `
  mutation verifyEmail(
    $email: String!
  ) {
    verifyEmail(
      email: $email
    )
  }
`;

describe("verifyEmail", () => {
  // Define constants to be applied to each test
  const email = casual.email;
  const query = {
    users: jest.fn()
  };
  // Vars for the gql mutation.
  const vars = {
    email
  };
  test("typical request is successful", async () => {
    const usr = {
      id: casual.uuid
    };
    // Run the mock query on the database
    query.users.mockReturnValue([usr]);

    // Mock up some functions.
    const updateUser = jest.fn();

    // Construct db object for context.
    const db = {
      query,
      mutation: { updateUser }
    };

    // Run the graphql mutation.
    const res = await graphql(schema, mutation, null, { db }, vars);
    expect(res.errors).toBeUndefined();
    expect(updateUser).toHaveBeenCalledTimes(1);
  });

  test("throws error if user not found", async () => {
    const db = { query };
    // Mock up some db functions.
    query.users.mockReturnValue([]);

    // Run the graphql mutation.
    const res = await graphql(schema, mutation, null, { db }, vars);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].message).toEqual(
      expect.stringMatching(/^The requested resource was not found/)
    );
  });
});
