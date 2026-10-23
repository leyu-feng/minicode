import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticateEntraRoutineWebhook } from "./entra-routine-webhook.js";
import { authenticateHostedWorkerProvider } from "./entra-hosted-workers.js";

const { jwks } = vi.hoisted(() => ({ jwks: { keys: [] as JWK[] } }));
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(() => actual.createLocalJWKSet(jwks)),
  };
});

const tenantId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const clientId = "33333333-3333-4333-8333-333333333333";
const principalId = "44444444-4444-4444-8444-444444444444";
const applicationId = "66666666-6666-4666-8666-666666666666";
const publicId = "1234567890abcdef12345678";
const audience = `api://${tenantId}/test-api`;
const issuer = `https://sts.windows.net/${tenantId}/`;
const configuration = {
  tenantId,
  applicationId,
  audience,
  grants: [{ publicId, companyId, clientId, principalId }],
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;

async function token(overrides: JWTPayload = {}, signingKey = keys.privateKey) {
  return new SignJWT({
    iss: issuer,
    aud: audience,
    tid: tenantId,
    oid: principalId,
    appid: clientId,
    ver: "1.0",
    roles: ["AdoPipelines"],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(signingKey);
}

describe("Entra routine webhook authorization", () => {
  beforeAll(async () => {
    keys = await generateKeyPair("RS256");
    jwks.keys.push({ ...await exportJWK(keys.publicKey), alg: "RS256", kid: "test-key" });
  });

  afterEach(() => vi.unstubAllEnvs());

  function configure() {
    vi.stubEnv("PAPERCLIP_ENTRA_ROUTINE_WEBHOOKS", JSON.stringify(configuration));
  }

  it("authorizes managed Hosted pairing only for the exact AdoPipelines provider identity", async () => {
    const grant = { clientId, principalId, apiUrl: "https://provider.example/v1/hosted-worker", audience: "api://provider" };
    vi.stubEnv("PAPERCLIP_ENTRA_HOSTED_WORKERS", JSON.stringify({ tenantId, applicationId, audience, providers: [grant] }));
    expect(await authenticateHostedWorkerProvider(`Bearer ${await token()}`)).toEqual(grant);
    for (const claims of [{ roles: ["Developer"] }, { oid: companyId }, { appid: applicationId }, { scp: "user_impersonation" }]) {
      await expect(authenticateHostedWorkerProvider(`Bearer ${await token(claims)}`)).rejects.toMatchObject({ status: 403 });
    }
  });

  it("leaves existing webhook authentication unchanged when not configured or not granted", async () => {
    vi.stubEnv("PAPERCLIP_ENTRA_ROUTINE_WEBHOOKS", "");
    expect(await authenticateEntraRoutineWebhook(publicId, companyId, "Bearer legacy-secret")).toBeNull();
    configure();
    expect(await authenticateEntraRoutineWebhook("aaaaaaaaaaaaaaaaaaaaaaaa", companyId, null)).toBeNull();
  });

  it("accepts a signed v1 application token with the role and exact identity grant", async () => {
    configure();
    expect(await authenticateEntraRoutineWebhook(publicId, companyId, `Bearer ${await token()}`))
      .toEqual({ clientId, principalId });
  });

  it("accepts a signed v2 token using azp, not appid", async () => {
    configure();
    const jwt = await token({
      ver: "2.0",
      aud: applicationId,
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      azp: clientId,
      appid: undefined,
    });
    expect(await authenticateEntraRoutineWebhook(publicId, companyId, `Bearer ${jwt}`))
      .toEqual({ clientId, principalId });
  });

  it.each([
    { roles: ["Developer"] },
    { roles: ["Default Access"] },
    { roles: "AdoPipelines" },
    { scp: "user_impersonation" },
    { tid: "55555555-5555-4555-8555-555555555555" },
    { oid: "55555555-5555-4555-8555-555555555555" },
    { appid: "55555555-5555-4555-8555-555555555555" },
  ])("rejects valid tokens without the required application authorization %#", async (claims) => {
    configure();
    await expect(authenticateEntraRoutineWebhook(publicId, companyId, `Bearer ${await token(claims)}`))
      .rejects.toMatchObject({ status: 403 });
  });

  it.each([
    { aud: "api://another-api" },
    { aud: clientId },
    { iss: "https://untrusted.example.test" },
    { exp: 1 },
    { nbf: Math.floor(Date.now() / 1000) + 3600 },
    { roles: undefined },
  ])("rejects invalid token claims %#", async (claims) => {
    configure();
    await expect(authenticateEntraRoutineWebhook(publicId, companyId, `Bearer ${await token(claims)}`))
      .rejects.toMatchObject({ status: 401 });
  });

  it("rejects a forged signature", async () => {
    configure();
    const attacker = await generateKeyPair("RS256");
    await expect(authenticateEntraRoutineWebhook(
      publicId, companyId, `Bearer ${await token({}, attacker.privateKey)}`,
    )).rejects.toMatchObject({ status: 401 });
  });

  it.each([undefined, "", "Bearer legacy-secret", "Basic abc", "Bearer malformed.jwt.token"])(
    "does not fall back to a webhook secret for a protected trigger %#",
    async (authorization) => {
      configure();
      await expect(authenticateEntraRoutineWebhook(publicId, companyId, authorization))
        .rejects.toMatchObject({ status: 401 });
    },
  );

  it("rejects cross-company grants", async () => {
    configure();
    await expect(authenticateEntraRoutineWebhook(
      publicId, "55555555-5555-4555-8555-555555555555", `Bearer ${await token()}`,
    )).rejects.toMatchObject({ status: 403 });
  });

  it("fails closed on malformed deployment configuration", async () => {
    vi.stubEnv("PAPERCLIP_ENTRA_ROUTINE_WEBHOOKS", '{"grants":[]}');
    await expect(authenticateEntraRoutineWebhook(publicId, companyId, "Bearer legacy-secret"))
      .rejects.toThrow();
  });
});
