import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import { authAccounts, authUsers, type Db } from "@paperclipai/db";
import { z } from "zod";
import { HttpError, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { BetterAuthSessionResult } from "./better-auth.js";

const uuid = z.uuid();
const principalSchema = z.object({
  auth_typ: z.enum(["aad", "Bearer", "AuthenticationTypes.Federation"]),
  claims: z.array(z.object({ typ: z.string(), val: z.string() })).max(512),
});
const OBJECT_ID = "http://schemas.microsoft.com/identity/claims/objectidentifier";
const TENANT_ID = "http://schemas.microsoft.com/identity/claims/tenantid";
const ROLE = "http://schemas.microsoft.com/ws/2008/06/identity/claims/role";
const NAME = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name";
const EMAIL = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";

export interface AzureEasyAuthConfig {
  tenantId: string;
  allowedRoles: string[];
  userMappings: Record<string, string>;
  publicOrigin: string;
}

export function loadAzureEasyAuthConfig(
  env: NodeJS.ProcessEnv,
  deploymentMode: string,
  publicBaseUrl: string | undefined,
): AzureEasyAuthConfig | undefined {
  const provider = env.PAPERCLIP_AUTH_PROVIDER?.trim() || "local";
  if (provider === "local") return undefined;
  if (provider !== "azure_easy_auth") throw new Error("Unsupported PAPERCLIP_AUTH_PROVIDER");
  if (deploymentMode !== "authenticated") {
    throw new Error("Azure Easy Auth requires authenticated deployment mode");
  }
  const tenantId = uuid.parse(env.PAPERCLIP_ENTRA_TENANT_ID).toLowerCase();
  const allowedRoles = (env.PAPERCLIP_ENTRA_ALLOWED_ROLES ?? "").split(",").map((role) => role.trim()).filter(Boolean);
  if (!allowedRoles.length) throw new Error("PAPERCLIP_ENTRA_ALLOWED_ROLES must name assigned Entra user roles");
  const url = new URL(publicBaseUrl ?? "");
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Azure Easy Auth requires an HTTPS public URL");
  }
  const mappings = z.record(uuid, z.string().trim().min(1)).parse(
    JSON.parse(env.PAPERCLIP_ENTRA_USER_MAPPINGS ?? "{}"),
  );
  const userMappings: Record<string, string> = {};
  for (const [objectId, userId] of Object.entries(mappings)) {
    const key = objectId.toLowerCase();
    if (userMappings[key] || Object.values(userMappings).includes(userId)) {
      throw new Error("Entra user mappings must be one-to-one");
    }
    userMappings[key] = userId;
  }
  return { tenantId, allowedRoles, userMappings, publicOrigin: url.origin };
}

export function parseAzureEasyAuthIdentity(headers: Headers, config: AzureEasyAuthConfig) {
  const encoded = headers.get("x-ms-client-principal");
  if (!encoded) return null;
  // Only enable this resolver behind Easy Auth, which strips caller-supplied identity headers.
  if (encoded.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw unauthorized("Invalid Easy Auth principal");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw unauthorized("Invalid Easy Auth principal");
  }
  const parsed = principalSchema.safeParse(decoded);
  if (!parsed.success) throw unauthorized("Expected an Entra Easy Auth principal");
  const provider = headers.get("x-ms-client-principal-idp") ?? parsed.data.auth_typ;
  if (provider !== "aad") throw unauthorized("Expected an Entra Easy Auth principal");
  const claims = parsed.data.claims;
  function claim(...types: string[]) {
    const values = new Set(claims.filter(({ typ }) => types.includes(typ)).map(({ val }) => val));
    if (values.size > 1) throw unauthorized("Conflicting Easy Auth identity claims");
    return [...values][0];
  }
  const tenant = uuid.safeParse(claim("tid", TENANT_ID));
  const object = uuid.safeParse(claim("oid", OBJECT_ID));
  if (!tenant.success || !object.success || tenant.data.toLowerCase() !== config.tenantId) {
    throw unauthorized("Easy Auth identity is not from the configured tenant");
  }
  const roles = claims.filter(({ typ }) => typ === "roles" || typ === ROLE).map(({ val }) => val);
  if (claim("idtyp") === "app" || !roles.some((role) => config.allowedRoles.includes(role))) {
    throw unauthorized("An assigned Entra user role is required");
  }
  const objectId = object.data.toLowerCase();
  return {
    objectId,
    name: claim("name") ?? claim("preferred_username", NAME, "upn") ?? "Entra user",
    email: claim("email", EMAIL) ?? claim("preferred_username", NAME, "upn")
      ?? `${objectId}@${config.tenantId}.entra.invalid`,
  };
}

export interface AzureEasyAuth {
  handler: RequestHandler;
  resolveSessionFromHeaders: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
}

export async function createAzureEasyAuth(db: Db, config: AzureEasyAuthConfig): Promise<AzureEasyAuth> {
  const issuer = `https://login.microsoftonline.com/${config.tenantId}/v2.0`;
  const accountWhere = (objectId: string) => and(eq(authAccounts.issuer, issuer), eq(authAccounts.accountId, objectId));
  const findUser = (database: Pick<Db, "select">, objectId: string) => database
    .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
    .from(authAccounts)
    .innerJoin(authUsers, eq(authUsers.id, authAccounts.userId))
    .where(accountWhere(objectId))
    .then((rows) => rows[0] ?? null);

  // Explicit operator mappings retain the user's existing memberships and roles.
  await db.transaction(async (tx) => {
    for (const [objectId, userId] of Object.entries(config.userMappings)) {
      const [user] = await tx.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, userId));
      if (!user) throw new Error("An Entra user mapping references a missing Paperclip user");
      const now = new Date();
      await tx.insert(authAccounts).values({
        id: randomUUID(), issuer, accountId: objectId, providerId: "azure_easy_auth", userId,
        createdAt: now, updatedAt: now,
      }).onConflictDoNothing();
      const linked = await findUser(tx, objectId);
      if (linked?.id !== userId) throw new Error("Entra identity is already linked to another Paperclip user");
    }
  });

  async function resolveSessionFromHeaders(headers: Headers): Promise<BetterAuthSessionResult | null> {
    let identity: ReturnType<typeof parseAzureEasyAuthIdentity>;
    try {
      identity = parseAzureEasyAuthIdentity(headers, config);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      logger.warn({ reason: error.message }, "Rejected Easy Auth identity");
      return null;
    }
    if (!identity) return null;
    let user = await findUser(db, identity.objectId);
    if (!user) {
      user = await db.transaction(async (tx) => {
        // A stable, tenant-scoped key makes concurrent first requests idempotent.
        // Email never links an external identity to an existing account.
        const userId = `entra:${config.tenantId}:${identity.objectId}`;
        const now = new Date();
        await tx.insert(authUsers).values({
          id: userId, name: identity.name, email: identity.email, emailVerified: false,
          createdAt: now, updatedAt: now,
        }).onConflictDoNothing();
        await tx.insert(authAccounts).values({
          id: randomUUID(), issuer, accountId: identity.objectId, providerId: "azure_easy_auth", userId,
          createdAt: now, updatedAt: now,
        }).onConflictDoNothing();
        return findUser(tx, identity.objectId);
      });
    }
    if (!user) throw new Error("Unable to persist Entra identity");
    return { session: { id: `easy-auth:${user.id}`, userId: user.id }, user };
  }

  const handler: RequestHandler = (req, res) => {
    if (req.method === "POST" && req.path === "/api/auth/sign-out") {
      if (req.get("origin") !== config.publicOrigin) {
        res.status(403).json({ error: "Untrusted sign-out origin" });
        return;
      }
      res.json({ success: true, redirectTo: "/.auth/logout" });
      return;
    }
    res.status(403).json({ error: "Local authentication is disabled; use Microsoft Entra sign-in" });
  };
  return { handler, resolveSessionFromHeaders };
}
