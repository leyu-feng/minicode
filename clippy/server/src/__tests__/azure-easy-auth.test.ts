import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, UnsecuredJWT, type JWK, type JWTPayload } from "jose";
import { eq } from "drizzle-orm";
import { authAccounts, authUsers, createDb, instanceUserRoles } from "@paperclipai/db";
import {
  createAzureEasyAuth,
  loadAzureEasyAuthConfig,
  parseAzureEasyAuthIdentity,
  parseAzureEasyAuthBearerIdentity,
  type AzureEasyAuthConfig,
} from "../auth/azure-easy-auth.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { authRoutes } from "../routes/auth.js";
import { healthRoutes } from "../routes/health.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OBJECT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "https://paperclip.example.com";
const AUDIENCE = `api://${TENANT}/paperclip`;
const { jwks } = vi.hoisted(() => ({ jwks: { keys: [] as JWK[] } }));
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return { ...actual, createRemoteJWKSet: vi.fn(() => actual.createLocalJWKSet(jwks)) };
});
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks.keys.push({ ...await exportJWK(keys.publicKey), alg: "RS256", kid: "user-key" });
});
async function userToken(overrides: JWTPayload = {}, signingKey = keys.privateKey) {
  return new SignJWT({
    iss: `https://sts.windows.net/${TENANT}/`, aud: AUDIENCE,
    tid: TENANT, oid: OBJECT, roles: ["Developer"], scp: "user_impersonation",
    name: "Entra User", preferred_username: "user@example.com", idtyp: "user",
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: "user-key" }).sign(signingKey);
}
const config: AzureEasyAuthConfig = {
  tenantId: TENANT, allowedRoles: ["Developer"], userMappings: {}, publicOrigin: ORIGIN, audiences: [AUDIENCE],
};
const baseClaims = [
  { typ: "tid", val: TENANT },
  { typ: "oid", val: OBJECT },
  { typ: "roles", val: "Developer" },
  { typ: "name", val: "Entra User" },
  { typ: "preferred_username", val: "user@example.com" },
];
function principal(claims = baseClaims, auth_typ = "aad") {
  return Buffer.from(JSON.stringify({ auth_typ, claims })).toString("base64");
}
function headers(claims = baseClaims) {
  return new Headers({ "x-ms-client-principal": principal(claims) });
}

describe("Azure Easy Auth configuration and identity validation", () => {
  const env = {
    PAPERCLIP_AUTH_PROVIDER: "azure_easy_auth",
    PAPERCLIP_ENTRA_TENANT_ID: TENANT,
    PAPERCLIP_ENTRA_ALLOWED_ROLES: " Developer, Support ",
    PAPERCLIP_ENTRA_AUDIENCES: ` ${AUDIENCE}, ${OBJECT} `,
  };
  it("keeps local auth as the default and fails closed on invalid external configuration", () => {
    expect(loadAzureEasyAuthConfig({}, "authenticated", undefined)).toBeUndefined();
    expect(loadAzureEasyAuthConfig(env, "authenticated", ORIGIN)).toMatchObject({
      tenantId: TENANT, allowedRoles: ["Developer", "Support"], audiences: [AUDIENCE, OBJECT],
    });
    expect(() => loadAzureEasyAuthConfig({ ...env, PAPERCLIP_AUTH_PROVIDER: "unknown" }, "authenticated", ORIGIN)).toThrow();
    expect(() => loadAzureEasyAuthConfig(env, "local_trusted", ORIGIN)).toThrow();
    expect(() => loadAzureEasyAuthConfig(env, "authenticated", "http://paperclip.example.com")).toThrow();
    expect(() => loadAzureEasyAuthConfig({ ...env, PAPERCLIP_ENTRA_TENANT_ID: "bad" }, "authenticated", ORIGIN)).toThrow();
    expect(() => loadAzureEasyAuthConfig({ ...env, PAPERCLIP_ENTRA_ALLOWED_ROLES: "" }, "authenticated", ORIGIN)).toThrow();
    expect(() => loadAzureEasyAuthConfig({ ...env, PAPERCLIP_ENTRA_USER_MAPPINGS: "not JSON" }, "authenticated", ORIGIN)).toThrow();
  });
  it("rejects ambiguous mappings to the same local account", () => {
    expect(() => loadAzureEasyAuthConfig({
      ...env, PAPERCLIP_ENTRA_USER_MAPPINGS: JSON.stringify({ [OBJECT]: "same-user", [OTHER]: "same-user" }),
    }, "authenticated", ORIGIN)).toThrow("one-to-one");
  });
  it("accepts short and platform-mapped Entra claim names", () => {
    expect(parseAzureEasyAuthIdentity(headers(), config)).toEqual({
      objectId: OBJECT, name: "Entra User", email: "user@example.com",
    });
    const mapped = headers([
      { typ: "http://schemas.microsoft.com/identity/claims/tenantid", val: TENANT },
      { typ: "http://schemas.microsoft.com/identity/claims/objectidentifier", val: OBJECT },
      { typ: "http://schemas.microsoft.com/ws/2008/06/identity/claims/role", val: "Developer" },
      { typ: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name", val: "user@example.com" },
    ]);
    expect(parseAzureEasyAuthIdentity(mapped, config)?.objectId).toBe(OBJECT);
  });
  it.each(["Bearer", "AuthenticationTypes.Federation"])(
    "accepts the platform authentication scheme %s only with the Entra provider header",
    (scheme) => {
      const platformHeaders = new Headers({ "x-ms-client-principal": principal(baseClaims, scheme) });
      expect(() => parseAzureEasyAuthIdentity(platformHeaders, config)).toThrow();
      platformHeaders.set("x-ms-client-principal-idp", "github");
      expect(() => parseAzureEasyAuthIdentity(platformHeaders, config)).toThrow();
      platformHeaders.set("x-ms-client-principal-idp", "aad");
      expect(parseAzureEasyAuthIdentity(platformHeaders, config)?.objectId).toBe(OBJECT);
      platformHeaders.set("x-ms-client-principal", principal(baseClaims.filter(({ typ }) => typ !== "roles"), scheme));
      expect(() => parseAzureEasyAuthIdentity(platformHeaders, config)).toThrow("assigned Entra user role");
    },
  );
  it("rejects a conflicting provider even when the principal names Entra", () => {
    const conflicting = headers();
    conflicting.set("x-ms-client-principal-idp", "github");
    expect(() => parseAzureEasyAuthIdentity(conflicting, config)).toThrow();
  });
  it("does not accept an old local session cookie or name/ID hint headers as identity", () => {
    expect(parseAzureEasyAuthIdentity(new Headers({
      cookie: "better-auth.session_token=old",
      "x-ms-client-principal-id": OBJECT,
      "x-ms-client-principal-name": "user@example.com",
    }), config)).toBeNull();
  });
  it("explains why a platform-only client-directed session cannot authorize board access", () => {
    const platformHeaders = new Headers({
      "x-ms-client-principal-idp": "aad",
      "x-ms-client-principal": principal([
        { typ: "stable_sid", val: "sid:platform-session" },
        { typ: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier", val: "platform-subject" },
      ], "AuthenticationTypes.Federation"),
    });
    expect(() => parseAzureEasyAuthIdentity(platformHeaders, config)).toThrow("use browser sign-in or an Entra user bearer token");
  });
  it.each([
    baseClaims.filter(({ typ }) => typ !== "tid"),
    baseClaims.filter(({ typ }) => typ !== "oid"),
    baseClaims.filter(({ typ }) => typ !== "roles"),
    baseClaims.map((c) => c.typ === "tid" ? { ...c, val: OTHER } : c),
    baseClaims.map((c) => c.typ === "roles" ? { ...c, val: "developer" } : c),
    [...baseClaims, { typ: "idtyp", val: "app" }],
    [...baseClaims, { typ: "oid", val: OTHER }],
  ])("rejects invalid tenant, object, role, or app-only claims (%#)", (claims) => {
    expect(() => parseAzureEasyAuthIdentity(headers(claims), config)).toThrow();
  });
  it.each(["!!!", principal([], "github"), Buffer.from("not JSON").toString("base64"), `${principal()},${principal()}`])(
    "rejects malformed or non-Entra principals (%#)", (value) => {
      expect(() => parseAzureEasyAuthIdentity(new Headers({ "x-ms-client-principal": value }), config)).toThrow();
    },
  );
  it("announces external login to signed-out clients without disclosing identity configuration", async () => {
    const app = express();
    app.use("/health", healthRoutes(undefined, {
      deploymentMode: "authenticated", deploymentExposure: "public", authReady: true,
      companyDeletionEnabled: true, authProvider: "azure_easy_auth",
    }));
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.authProvider).toBe("azure_easy_auth");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toHaveProperty("tenantId");
    expect(response.body).not.toHaveProperty("userMappings");
  });
});

describe("Azure Easy Auth human bearer verification", () => {
  it.each([
    `https://sts.windows.net/${TENANT}/`,
    `https://login.microsoftonline.com/${TENANT}/v2.0`,
  ])("accepts a signed delegated user token from %s", async (iss) => {
    expect(await parseAzureEasyAuthBearerIdentity(`Bearer ${await userToken({ iss })}`, config)).toEqual({
      objectId: OBJECT, name: "Entra User", email: "user@example.com",
    });
  });
  it.each([
    { iss: "https://untrusted.example" }, { aud: "api://another-service" },
    { tid: OTHER }, { oid: undefined }, { oid: "not-an-object-id" },
    { roles: ["NotDeveloper"] }, { roles: "Developer" }, { roles: undefined },
    { scp: undefined }, { scp: "some_other_scope" }, { idtyp: "app" },
    { exp: 1 }, { exp: undefined }, { iat: undefined },
    { "http://schemas.microsoft.com/identity/claims/objectidentifier": OTHER },
  ])("rejects invalid or unauthorized user claims %#", async (claims) => {
    await expect(parseAzureEasyAuthBearerIdentity(`Bearer ${await userToken(claims)}`, config))
      .rejects.toMatchObject({ status: 401 });
  });
  it("rejects forged signatures, unsigned tokens and absent audience configuration", async () => {
    const otherKeys = await generateKeyPair("RS256");
    const forged = await userToken({}, otherKeys.privateKey);
    await expect(parseAzureEasyAuthBearerIdentity(`Bearer ${forged}`, config)).rejects.toMatchObject({ status: 401 });
    const unsigned = new UnsecuredJWT({ tid: TENANT, oid: OBJECT, roles: ["Developer"] }).encode();
    await expect(parseAzureEasyAuthBearerIdentity(`Bearer ${unsigned}`, config)).rejects.toMatchObject({ status: 401 });
    await expect(parseAzureEasyAuthBearerIdentity(`Bearer ${await userToken()}`, { ...config, audiences: [] }))
      .rejects.toThrow("PAPERCLIP_ENTRA_AUDIENCES");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("Azure Easy Auth persisted identities", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let auth: Awaited<ReturnType<typeof createAzureEasyAuth>>;
  let app: express.Express;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-easy-auth-");
    db = createDb(database.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({
      id: "existing-user", name: "Existing User", email: "user@example.com",
      createdAt: now, updatedAt: now,
    });
    await db.insert(instanceUserRoles).values({ userId: "existing-user", role: "instance_admin" });
    auth = await createAzureEasyAuth(db, { ...config, userMappings: { [OBJECT]: "existing-user" } });
    app = express();
    app.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: (req) => auth.resolveSessionFromHeaders(new Headers({
        ...(req.get("x-ms-client-principal") ? { "x-ms-client-principal": req.get("x-ms-client-principal")! } : {}),
        ...(req.get("x-ms-client-principal-idp") ? { "x-ms-client-principal-idp": req.get("x-ms-client-principal-idp")! } : {}),
      }), { rejectInvalidIdentity: true }),
      resolveBearerSession: (req) => auth.resolveBearerSession(req.get("authorization")),
    }));
    app.use("/api/auth", authRoutes(db));
    app.all("/api/auth/{*authPath}", auth.handler);
    app.use(errorHandler);
  });

  afterAll(async () => { await database?.cleanup(); });

  it("retains the explicitly mapped local user and its admin authorization over HTTP", async () => {
    const response = await request(app).get("/api/auth/get-session").set("x-ms-client-principal", principal());
    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe("existing-user");
    const roles = await db.select().from(instanceUserRoles);
    expect(roles).toHaveLength(1);
    expect(roles[0]?.userId).toBe("existing-user");
    const again = await createAzureEasyAuth(db, config);
    expect((await again.resolveSessionFromHeaders(headers()))?.user?.id).toBe("existing-user");
  });
  it("resolves a verified human bearer to the same mapped administrator, even beside a platform-only session", async () => {
    const response = await request(app).get("/api/auth/get-session")
      .set("Authorization", `Bearer ${await userToken()}`)
      .set("x-ms-client-principal-idp", "aad")
      .set("x-ms-client-principal", principal([{ typ: "stable_sid", val: "sid:platform" }], "AuthenticationTypes.Federation"));
    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe("existing-user");
    expect(await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, "existing-user"))).toHaveLength(1);
  });
  it("returns an explicit authentication failure instead of masking missing session claims as board permissions", async () => {
    const response = await request(app).get("/api/auth/get-session")
      .set("x-ms-client-principal-idp", "aad")
      .set("x-ms-client-principal", principal([{ typ: "stable_sid", val: "sid:platform" }], "AuthenticationTypes.Federation"));
    expect(response.status).toBe(401);
    expect(response.body.error).toContain("use browser sign-in or an Entra user bearer token");
  });

  it("never links by matching email and handles concurrent first requests without granting admin", async () => {
    const fresh = headers(baseClaims.map((c) => c.typ === "oid" ? { ...c, val: OTHER } : c));
    const sessions = await Promise.all(Array.from({ length: 5 }, () => auth.resolveSessionFromHeaders(fresh)));
    const id = sessions[0]?.user?.id;
    expect(id).toBe(`entra:${TENANT}:${OTHER}`);
    expect(sessions.every((session) => session?.user?.id === id)).toBe(true);
    expect(await db.select().from(authAccounts).where(eq(authAccounts.accountId, OTHER))).toHaveLength(1);
    expect(await db.select().from(authUsers).where(eq(authUsers.id, id!))).toHaveLength(1);
    expect(await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, id!))).toHaveLength(0);
  });

  it("does not provision an identity without the required assigned role", async () => {
    const before = await db.select().from(authUsers);
    expect(await auth.resolveSessionFromHeaders(headers(baseClaims.filter(({ typ }) => typ !== "roles")))).toBeNull();
    expect(await db.select().from(authUsers)).toHaveLength(before.length);
    expect(await auth.resolveSessionFromHeaders(new Headers({ cookie: "paperclip.session_token=old" }))).toBeNull();
  });

  it("rejects missing mapping targets and refuses to relink existing identities", async () => {
    await expect(createAzureEasyAuth(db, { ...config, userMappings: { [OBJECT]: "missing-user" } })).rejects.toThrow("missing");
    await expect(createAzureEasyAuth(db, {
      ...config, userMappings: { [OTHER]: "existing-user" },
    })).rejects.toThrow("already linked");
    expect((await auth.resolveSessionFromHeaders(headers()))?.user?.id).toBe("existing-user");
  });

  it.each(["sign-in/email", "sign-up/email", "request-password-reset", "reset-password", "link-social", "update-user"])(
    "disables the local %s endpoint", async (path) => {
      const response = await request(app).post(`/api/auth/${path}`).send({});
      expect(response.status).toBe(403);
      expect(response.body.error).toContain("Local authentication is disabled");
    },
  );

  it("signs out through the gateway only from the configured browser origin", async () => {
    const denied = await request(app).post("/api/auth/sign-out").set("origin", "https://untrusted.example");
    expect(denied.status).toBe(403);
    const response = await request(app).post("/api/auth/sign-out").set("origin", ORIGIN);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, redirectTo: "/.auth/logout" });
  });

  it("uses the same Entra identity for WebSocket upgrades and still enforces company access", async () => {
    const server = createServer(app);
    const wss = setupLiveEventsWebSocketServer(server, db, {
      deploymentMode: "authenticated", resolveSessionFromHeaders: auth.resolveSessionFromHeaders,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    const url = `ws://127.0.0.1:${address.port}/api/companies/44444444-4444-4444-8444-444444444444/events/ws`;
    const connect = (value: string) => new WebSocket(url, { headers: { "x-ms-client-principal": value } });
    try {
      const socket = connect(principal());
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      await new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.close(); });
      const denied = connect(principal(baseClaims.map((c) => c.typ === "oid" ? { ...c, val: OTHER } : c)));
      await new Promise<void>((resolve, reject) => {
        denied.once("open", () => { denied.close(); reject(new Error("Unprivileged user joined a company")); });
        denied.once("unexpected-response", (_req, response) => {
          expect(response.statusCode).toBe(403);
          response.resume();
          denied.terminate();
          resolve();
        });
        denied.on("error", () => {});
      });
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
