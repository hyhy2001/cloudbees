/**
 * CloudBees API exceptions — 1:1 port of legacy/cb/api/exceptions.py
 */

/** Base exception for all CB errors. */
export class CBError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "CBError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** HTTP error with a status code. toString() → "HTTP {status}: {msg}" */
export class APIError extends CBError {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(`HTTP ${statusCode}: ${message}`);
    this.name = "APIError";
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when credentials are missing or invalid (401/403). */
export class AuthError extends CBError {
  readonly statusCode: number;

  constructor(statusCodeOrMessage?: number | string, message?: string) {
    const isNumeric = typeof statusCodeOrMessage === "number";
    super(isNumeric ? message : statusCodeOrMessage);
    this.name = "AuthError";
    this.statusCode = isNumeric ? statusCodeOrMessage : 0;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when a resource does not exist (404). */
export class NotFoundError extends CBError {
  constructor(message?: string) {
    super(message);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when the server is unreachable. */
export class CBConnectionError extends CBError {
  constructor(message?: string) {
    super(message);
    this.name = "CBConnectionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Alias that matches Python's `ConnectionError` name without clashing with the global. */
export { CBConnectionError as ConnectionError };

/**
 * Raised when user-supplied input fails validation before hitting the server
 * (e.g. invalid store name, mutually-exclusive flags, missing required option).
 * Lets callers distinguish "bad user input" from server/network errors.
 */
export class ValidationError extends CBError {
  constructor(message?: string) {
    super(message);
    this.name = "ValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Raised when the local environment/configuration is broken
 * (e.g. cannot detect bee root directory, missing secret file).
 * Distinct from ValidationError (user input) and CBConnectionError (network).
 */
export class ConfigError extends CBError {
  constructor(message?: string) {
    super(message);
    this.name = "ConfigError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
