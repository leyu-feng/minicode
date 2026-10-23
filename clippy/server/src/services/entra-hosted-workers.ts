import { z } from "zod";
import { hostedWorkerConfigSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { authenticateEntraApplication } from "./entra-application.js";

const configurationSchema = z.object({
  tenantId: z.string().guid(),
  applicationId: z.string().guid(),
  audience: z.string().min(1),
  providers: z.array(hostedWorkerConfigSchema.extend({
    clientId: z.string().guid(),
    principalId: z.string().guid(),
  }).strict()).min(1).max(100),
}).strict();

export type HostedWorkerProviderGrant = z.infer<typeof configurationSchema>["providers"][number];

export async function authenticateHostedWorkerProvider(authorizationHeader: string | undefined): Promise<HostedWorkerProviderGrant> {
  const raw = process.env.PAPERCLIP_ENTRA_HOSTED_WORKERS;
  if (!raw) throw forbidden("Managed Hosted worker registration is not configured");
  const configuration = configurationSchema.parse(JSON.parse(raw));
  const identity = await authenticateEntraApplication(configuration, configuration.providers, authorizationHeader);
  return configuration.providers.find((provider) =>
    provider.clientId.toLowerCase() === identity.clientId.toLowerCase()
    && provider.principalId.toLowerCase() === identity.principalId.toLowerCase())!;
}
