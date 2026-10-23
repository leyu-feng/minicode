import { z } from "zod";
import { forbidden } from "../errors.js";
import { authenticateEntraApplication, type EntraApplicationIdentity } from "./entra-application.js";

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

export type EntraRoutineWebhookIdentity = EntraApplicationIdentity;

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
  return authenticateEntraApplication(configuration, companyGrants, authorizationHeader);
}
