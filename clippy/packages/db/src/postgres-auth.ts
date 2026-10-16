import { DefaultAzureCredential } from "@azure/identity";

const AZURE_POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";
let credential: DefaultAzureCredential | undefined;

function azurePostgresUrl(connectionString: string): URL | null {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch (error) {
    // Preserve postgres.js support for empty URLs and PG* environment settings.
    if (error instanceof TypeError && (error as NodeJS.ErrnoException).code === "ERR_INVALID_URL") return null;
    throw error;
  }
  return (url.protocol === "postgres:" || url.protocol === "postgresql:")
    && url.hostname.endsWith(".postgres.database.azure.com")
    && !url.password
    ? url
    : null;
}

async function azurePostgresPassword(): Promise<string> {
  credential ??= new DefaultAzureCredential({
    managedIdentityClientId: process.env.AZURE_CLIENT_ID,
  });
  const token = await credential.getToken(AZURE_POSTGRES_SCOPE);
  if (!token?.token) throw new Error("Azure PostgreSQL authentication returned no access token.");
  return token.token;
}

export function resolvePostgresAuthOptions(connectionString: string): {
  password?: () => Promise<string>;
  ssl?: "verify-full";
} {
  return azurePostgresUrl(connectionString)
    ? { password: azurePostgresPassword, ssl: "verify-full" }
    : {};
}

export async function resolvePostgresCliConnection(connectionString: string): Promise<{
  connectionString: string;
  env: NodeJS.ProcessEnv;
}> {
  const url = azurePostgresUrl(connectionString);
  if (!url) return { connectionString, env: { ...process.env } };

  url.searchParams.set("sslmode", "verify-full");
  if (!url.searchParams.has("sslrootcert") && !process.env.PGSSLROOTCERT) {
    url.searchParams.set("sslrootcert", "system");
  }
  return {
    connectionString: url.toString(),
    env: { ...process.env, PGPASSWORD: await azurePostgresPassword() },
  };
}
