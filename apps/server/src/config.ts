import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(z.string().url().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  MONGODB_URI: optionalUrl,
  REDIS_URL: optionalUrl,
  JWT_SECRET: z.string().min(10).default("pixel-turf-default-jwt-secret"),
  COOKIE_SECURE: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === "true" || v === "1"),
});

const rawEnv = envSchema.parse(process.env);

const CLIENT_ORIGINS = rawEnv.CLIENT_ORIGIN.split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

export const env = {
  ...rawEnv,
  CLIENT_ORIGINS:
    CLIENT_ORIGINS.length > 0 ? CLIENT_ORIGINS : ["http://localhost:5173"],
};
