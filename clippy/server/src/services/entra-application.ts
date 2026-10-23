import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import { forbidden, unauthorized } from "../errors.js";

export interface EntraApplicationIdentity {
  clientId: string;
  principalId: string;
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticateEntraApplication(
  configuration: { tenantId: string; applicationId: string; audience: string },
  identities: EntraApplicationIdentity[],
  authorizationHeader: string | null | undefined,
): Promise<EntraApplicationIdentity> {
  const token = /^Bearer ([^\s]+)$/i.exec(authorizationHeader ?? "")?.[1];
  if (!token) throw unauthorized("An Entra application access token is required");
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
      issuer: [`https://sts.windows.net/${tenantId}/`, `https://login.microsoftonline.com/${tenantId}/v2.0`],
      audience: [configuration.audience, configuration.applicationId],
      requiredClaims: ["exp", "iat", "tid", "oid", "roles"],
    }));
  } catch (error) {
    if (
      error instanceof errors.JWTExpired || error instanceof errors.JWTClaimValidationFailed
      || error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JWSInvalid
      || error instanceof errors.JWTInvalid || error instanceof errors.JOSEAlgNotAllowed
      || error instanceof errors.JWKSNoMatchingKey
    ) throw unauthorized("Invalid or expired Entra application access token");
    throw error;
  }
  if (payload.tid !== tenantId || payload.scp !== undefined
    || !Array.isArray(payload.roles) || !payload.roles.includes("AdoPipelines")) {
    throw forbidden("An application token with the AdoPipelines role is required");
  }
  const clientId = payload.ver === "2.0" ? payload.azp : payload.appid;
  const principalId = payload.oid;
  if (typeof clientId !== "string" || typeof principalId !== "string"
    || !identities.some((identity) => identity.clientId.toLowerCase() === clientId.toLowerCase()
      && identity.principalId.toLowerCase() === principalId.toLowerCase())) {
    throw forbidden("The calling application identity is not authorized");
  }
  return { clientId, principalId };
}
