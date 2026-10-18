import type { NextFunction, Request, Response } from "express";
import { ZodError, z } from "zod";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, "INVALID_INPUT", result.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "));
  return result.data;
}

export function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof ZodError) {
    response.status(400).json({ error: "INVALID_INPUT", message: "Request data failed validation." });
    return;
  }
  response.status(500).json({ error: "INTERNAL_ERROR", message: "The request could not be completed." });
}

export const uuidSchema = z.string().uuid();
