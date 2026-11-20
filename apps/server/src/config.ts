import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(z.string().url().optional());

const DEFAULT_PROD_CLIENT_ORIGIN = "https://pixel-turf-teal.vercel.app";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z
    .string()
    .default(`http://localhost:5173,${DEFAULT_PROD_CLIENT_ORIGIN}`),
  MONGODB_URI: optionalUrl,
  REDIS_URL: optionalUrl,
  JWT_SECRET: z.string().min(10).default("pixel-turf-default-jwt-secret"),
  COOKIE_SECURE: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === "true" || v === "1"),
});

const rawEnv = envSchema.parse(process.env);

const parsedOrigins = rawEnv.CLIENT_ORIGIN.split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const CLIENT_ORIGINS = Array.from(
  new Set([
    ...(parsedOrigins.length > 0 ? parsedOrigins : ["http://localhost:5173"]),
    DEFAULT_PROD_CLIENT_ORIGIN,
  ])
);

export const env = {
  ...rawEnv,
  CLIENT_ORIGINS,
};
