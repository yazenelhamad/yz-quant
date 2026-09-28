export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
  }
}
export const unauthorized = (msg = "Authentication required") => new HttpError(401, "unauthenticated", msg);
export const forbidden = (msg = "Forbidden") => new HttpError(403, "forbidden", msg);
export const notFound = (msg = "Not found") => new HttpError(404, "not_found", msg);
export const conflict = (msg: string) => new HttpError(409, "conflict", msg);
export const validation = (msg: string, detail?: unknown) => new HttpError(422, "validation", msg, detail);
export const locked = (msg: string) => new HttpError(423, "locked", msg);
export const stepUpRequired = () => new HttpError(428, "step_up_required", "Please confirm your password (and MFA code) to continue");
export const unavailable = (msg: string) => new HttpError(503, "unavailable", msg);
