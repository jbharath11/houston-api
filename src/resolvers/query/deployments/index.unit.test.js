import { deploymentsQuery } from "./index";
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
const query = `
  query deployments {
    deployments {
      id
      label
      description
      type
      releaseName
      version
      workspace {
        id: uuid
      }
      urls {
        type
        url
      }
      createdAt
      updatedAt
      config
      env
      properties
    }
  }
`;

describe("deployments", () => {
  test("typical request is successful", async () => {
    const user = {
      id: casual.uuid,
      roleBindings: [{ deployment: { id: casual.uuid } }]
    };

    // Mock up some db functions.
    const deployments = jest.fn();

    // Construct db object for context.
    const db = {
      query: {
        deployments
      }
    };

    // Run the graphql mutation.
    const res = await graphql(schema, query, null, { db, user });
    expect(res.errors).toBeUndefined();
    expect(deployments.mock.calls.length).toBe(1);
  });
});

describe("deploymentsQuery", () => {
  test("deploymentId is correctly used in query", async () => {
    const deploymentId = casual.uuid;

    const args = {
      deploymentUuid: deploymentId
    };

    const user = {
      id: casual.uuid
    };

    // Build context.
    const ctx = { user };

    // Get the query.
    const query = deploymentsQuery(args, ctx);

    expect(query).toHaveProperty("where.AND");
    expect(query.where.AND).toHaveLength(1);
    expect(query.where.AND[0]).toHaveProperty("id", deploymentId);
  });

  test("workspaceId is correctly used in query", async () => {
    const workspaceId = casual.uuid;

    const args = {
      workspaceUuid: workspaceId
    };

    const user = {
      id: casual.uuid
    };

    // Build context.
    const ctx = { user };

    // Get the query.
    const query = deploymentsQuery(args, ctx);

    expect(query).toHaveProperty("where.AND");
    expect(query.where.AND).toHaveLength(1);
    expect(query.where.AND[0]).toHaveProperty("workspace.id", workspaceId);
  });

  test("correctly falls back if no arguments are provided", async () => {
    const deploymentId1 = casual.uuid;
    const deploymentId2 = casual.uuid;

    const args = {};

    const user = {
      id: casual.uuid,
      roleBindings: [
        { deployment: { id: deploymentId1 } },
        { deployment: { id: deploymentId2 } }
      ]
    };

    // Build context.
    const ctx = { user };

    // Run the graphql mutation.
    const query = deploymentsQuery(args, ctx);

    expect(query).toHaveProperty("where.AND");
    expect(query.where.AND).toHaveLength(1);
    expect(query.where.AND[0]).toHaveProperty("id_in", [
      deploymentId1,
      deploymentId2
    ]);
  });
});