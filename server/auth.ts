import type { AuthenticatedUser } from "../shared/models.js";

const TOKEN_PREFIX = "dev.";

export function createDevToken(user: AuthenticatedUser): string {
  const payload = Buffer.from(JSON.stringify(user), "utf8").toString("base64url");
  return `${TOKEN_PREFIX}${payload}`;
}

export function decodeDevToken(token: string): AuthenticatedUser | null {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return null;
  }

  try {
    const payload = token.slice(TOKEN_PREFIX.length);
    const raw = Buffer.from(payload, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as Partial<AuthenticatedUser>;

    if (typeof parsed.userId !== "string" || typeof parsed.displayName !== "string") {
      return null;
    }

    const userId = parsed.userId.trim();
    const displayName = parsed.displayName.trim();

    if (!userId || !displayName) {
      return null;
    }

    return {
      userId,
      displayName,
    };
  } catch {
    return null;
  }
}

export function readAuthUserFromHeader(authHeader?: string): AuthenticatedUser | null {
  if (!authHeader) {
    return null;
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return decodeDevToken(token);
}
