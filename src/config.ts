import * as dotenv from "dotenv";

dotenv.config();

export const CONFIG = {
  // Ring authentication (use refresh token if available)
  RING_REFRESH_TOKEN: process.env.RING_REFRESH_TOKEN ?? "",
  // Optional client credentials (if using OAuth client flow)
  RING_CLIENT_ID: process.env.RING_CLIENT_ID ?? "",
  RING_CLIENT_SECRET: process.env.RING_CLIENT_SECRET ?? "",
  RING_HMAC_SIGNATURE_KEY: process.env.RING_HMAC_SIGNATURE_KEY ?? "",
  RING_OAUTH_AUTHORIZE_URL: process.env.RING_OAUTH_AUTHORIZE_URL ?? "",
  RING_OAUTH_TOKEN_URL: process.env.RING_OAUTH_TOKEN_URL ?? "",
  PUBLIC_APP_URL: (process.env.PUBLIC_APP_URL ?? "https://ring-visitor-recognizer.onrender.com").replace(/\/$/, ""),

  // AWS SNS configuration
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "",
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "",
  AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION ?? "us-east-1",
  AWS_SNS_TOPIC_ARN: process.env.AWS_SNS_TOPIC_ARN ?? "",
  VISITOR_SMS_PHONE: process.env.VISITOR_SMS_PHONE ?? "",

  // Application settings
  PORT: Number(process.env.PORT) || 3000,
  VISITOR_DB_PATH: process.env.VISITOR_DB_PATH ?? "./data/visitors.json",
  EVENT_DB_PATH: process.env.EVENT_DB_PATH ?? "./data/events.json",
  RECOGNITION_THRESHOLD: Number(process.env.RECOGNITION_THRESHOLD) ?? 0.75,
};
