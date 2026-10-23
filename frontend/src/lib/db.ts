import { Pool } from "pg";

// Direct connection to Supabase PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    "postgresql://postgres.clvmribjdecelazooiyo:%2Bd%3FPjHU3hUNh%21K-@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres",
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

export default pool;
