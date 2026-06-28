export class WrapperError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'WrapperError';
    this.cause = options.cause;
  }
}

export function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}
