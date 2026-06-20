export const SESSION_ID_MAX_LENGTH = 128;
const SESSION_ID_RE = /^[\w.-]+$/;

export function isValidSessionId(sessionId: string): boolean {
  return sessionId.length <= SESSION_ID_MAX_LENGTH && SESSION_ID_RE.test(sessionId);
}
