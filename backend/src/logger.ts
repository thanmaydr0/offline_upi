import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "*.token",
      "*.password",
      "*.secret",
      "*.signature",
      "*.privateKey",
      "req.headers.authorization",
      "req.headers.cookie",
      "authorization",
      "cookie",
    ],
    censor: "[Redacted]",
  },
});
