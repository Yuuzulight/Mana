class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}

function isMissing(value) {
  return value === undefined || value === null || value === "";
}

function cleanLabel(label) {
  return String(label || "value").trim() || "value";
}

function requireString(value, label) {
  const field = cleanLabel(label);
  if (typeof value !== "string") {
    throw new ValidationError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError(`${field} is required`);
  }
  return trimmed;
}

function optionalString(value, label, defaultValue = "") {
  const field = cleanLabel(label);
  if (isMissing(value)) {
    return defaultValue;
  }
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`);
  }
  return value.trim();
}

function optionalInteger(value, label, options = {}) {
  const field = cleanLabel(label);
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
  if (isMissing(value)) {
    return options.defaultValue;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new ValidationError(`${field} must be an integer`);
  }
  if (number < min || number > max) {
    throw new ValidationError(`${field} must be between ${min} and ${max}`);
  }
  return number;
}

function optionalBoolean(value, label, defaultValue = false) {
  const field = cleanLabel(label);
  if (isMissing(value)) {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  throw new ValidationError(`${field} must be true or false`);
}

function requireFile(file, label = "file") {
  const field = cleanLabel(label);
  if (!file) {
    throw new ValidationError(`${field} is required`);
  }
  return file;
}

function requireOneOf(fields) {
  const found = fields.find((field) => !isMissing(field.value));
  if (found) {
    return found.value;
  }
  const labels = fields.map((field) => cleanLabel(field.label));
  const joined = labels.length === 2 ? labels.join(" or ") : labels.join(", ");
  throw new ValidationError(`${joined} is required`);
}

function sendValidationError(res, error, fallbackMessage = "invalid request") {
  const statusCode = error instanceof ValidationError ? error.statusCode : 400;
  const message = error instanceof Error && error.message ? error.message : fallbackMessage;
  return res.status(statusCode).json({ error: message });
}

module.exports = {
  ValidationError,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireFile,
  requireOneOf,
  requireString,
  sendValidationError,
};
