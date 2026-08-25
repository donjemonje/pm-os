import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const logLevels: ("error" | "warn")[] =
  process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"];

/**
 * Builds the Prisma client backed by a Postgres driver adapter.
 *
 * In production (Cloud SQL) we connect through the Cloud SQL Node connector,
 * which authenticates with Application Default Credentials (the App Hosting
 * runtime service account) and secures the connection to the instance's public
 * IP. This needs no VPC, no static-IP allowlisting, and survives App Hosting
 * rollouts. Set INSTANCE_CONNECTION_NAME (plus DB_USER / DB_PASSWORD / DB_NAME)
 * to enable it.
 *
 * Everywhere else (local dev, migrations via the Cloud SQL Auth Proxy) we use
 * the DATABASE_URL connection string directly.
 */
async function createPrismaClient(): Promise<PrismaClient> {
  const instanceConnectionName = process.env.INSTANCE_CONNECTION_NAME?.trim();

  if (instanceConnectionName) {
    const { Connector, IpAddressTypes } = await import(
      "@google-cloud/cloud-sql-connector"
    );
    const { Pool } = await import("pg");

    const connector = new Connector();
    const clientOpts = await connector.getOptions({
      instanceConnectionName,
      ipType:
        process.env.DB_IP_TYPE === "PRIVATE"
          ? IpAddressTypes.PRIVATE
          : IpAddressTypes.PUBLIC,
    });

    const pool = new Pool({
      ...clientOpts,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      max: Number(process.env.DB_POOL_MAX ?? 5),
    });

    const adapter = new PrismaPg(pool);
    return new PrismaClient({ adapter, log: logLevels });
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter, log: logLevels });
}

export const db = globalForPrisma.prisma ?? (await createPrismaClient());

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
