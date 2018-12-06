import { token, permissions, isAdmin } from "./auth-user";

describe("AuthUser", () => {
  test("token resolves a valid token", () => {
    const userId = "12345";
    const res = token({ userId });

    // Test that uuid gets set propertly.
    expect(res.payload.uuid).toBe(userId);

    // Test that the issued at is now.
    expect(res.payload.iat).toBe(Math.floor(new Date() / 1000));

    // Test that the expiration is greater than now.
    expect(res.payload.exp).toBeGreaterThan(Math.floor(new Date() / 1000));
  });

  test("permissions is an empty object", () => {
    expect(permissions()).toEqual({});
  });

  test("isAdmin is false", () => {
    expect(isAdmin()).toEqual(false);
  });
});
