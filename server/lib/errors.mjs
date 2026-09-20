export class HttpError extends Error {
  constructor(message, status = 500, code = "INTERNAL_ERROR") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message, code = "INVALID_REQUEST") => new HttpError(message, 400, code);
export const unauthorized = (message, code = "UNAUTHORIZED") => new HttpError(message, 401, code);
export const notFound = (message, code = "NOT_FOUND") => new HttpError(message, 404, code);
export const badGateway = (message, code = "UPSTREAM_ERROR") => new HttpError(message, 502, code);
export const unavailable = (message, code = "UNAVAILABLE") => new HttpError(message, 503, code);

export function toHttpError(error) {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return new HttpError(message || "服务器内部错误", 500, "INTERNAL_ERROR");
}
