import pkg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pkg;

export const pg = new Pool({
  connectionString: process.env.REMOTE_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

pg.on("error", (err) => {
  console.error("DB pool error:", err.message);
});

export const startHeartbeat = (intervalMs = 4 * 60 * 1000) => {
  setInterval(async () => {
    try {
      await pg.query("SELECT 1");
    } catch (err) {
      console.error("DB heartbeat falhou:", err.message);
    }
  }, intervalMs);
};

try {
  await pg.query("SELECT 1");
  console.log("connected to the database");
} catch (err) {
  console.error("DB unavailable at startup:", err.message);
}
