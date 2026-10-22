import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import { forbidden, unauthorized } from "../errors.js";

const configurationSchema = z.object({
  tenantId: z.string().guid(),
  applicationId: z.string().guid(),
  audience: z.string().min(1),
  grants: z.array(z.object({
    publicId: z.string().regex(/^[a-f0-9]{24}$/),
    companyId: z.string().guid(),
    clientId: z.string().guid(),
    principalId: z.string().guid(),
  }).strict()).max(100),
}).strict();

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export interface EntraRoutineWebhookIdentity {
  clientId: string;
  principalId: string;
}

export async function authenticateEntraRoutineWebhook(
  publicId: string,
  companyId: string,
  authorizationHeader: string | null | undefined,
): Promise<EntraRoutineWebhookIdentity | null> {
  const rawConfiguration = process.env.PAPERCLIP_ENTRA_ROUTINE_WEBHOOKS;
  if (!rawConfiguration) return null;
  const configuration = configurationSchema.parse(JSON.parse(rawConfiguration));
  const grants = configuration.grants.filter((grant) => grant.publicId === publicId);
  if (grants.length === 0) return null;

  const companyGrants = grants.filter((grant) => grant.companyId === companyId);
  if (companyGrants.length === 0) throw forbidden("Entra webhook grant does not match the routine company");
  const token = /^Bearer ([^\s]+)$/i.exec(authorizationHeader ?? "")?.[1];
  if (!token) throw unauthorized("An Entra access token is required for this webhook");

  const tenantId = configuration.tenantId.toLowerCase();
  let keySet = keySets.get(tenantId);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
    keySets.set(tenantId, keySet);
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keySet, {
      algorithms: ["RS256"],
      issuer: [
        `https://sts.windows.net/${tenantId}/`,
        `https://login.microsoftonline.com/${tenantId}/v2.0`,
      ],
      audience: [configuration.audience, configuration.applicationId],
      requiredClaims: ["exp", "iat", "tid", "oid", "roles"],
    }));
  } catch (error) {
    if (
      error instanceof errors.JWTExpired
      || error instanceof errors.JWTClaimValidationFailed
      || error instanceof errors.JWSSignatureVerificationFailed
      || error instanceof errors.JWSInvalid
      || error instanceof errors.JWTInvalid
      || error instanceof errors.JOSEAlgNotAllowed
      || error instanceof errors.JWKSNoMatchingKey
    ) {
      throw unauthorized("Invalid or expired Entra webhook access token");
    }
    throw error;
  }

  if (
    payload.tid !== tenantId
    || payload.scp !== undefined
    || !Array.isArray(payload.roles)
    || !payload.roles.includes("AdoPipelines")
  ) {
    throw forbidden("An application token with the AdoPipelines role is required");
  }
  const clientId = payload.ver === "2.0" ? payload.azp : payload.appid;
  const principalId = payload.oid;
  if (
    typeof clientId !== "string"
    || typeof principalId !== "string"
    || !companyGrants.some((grant) =>
      grant.clientId.toLowerCase() === clientId.toLowerCase()
      && grant.principalId.toLowerCase() === principalId.toLowerCase())
  ) {
    throw forbidden("The calling identity is not authorized for this routine");
  }

  return { clientId, principalId };
}
