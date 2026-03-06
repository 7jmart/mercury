import jwt from "jsonwebtoken";

import type { V1AuthUser } from "../shared/v1.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-mercury-jwt-secret";
const ACCESS_TTL_SECONDS = Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900);
const REFRESH_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_MS ?? 1000 * 60 * 60 * 24 * 30);
const MEDIA_TOKEN_TTL_SECONDS = Number(process.env.MEDIA_TOKEN_TTL_SECONDS ?? 600);

export interface AccessTokenClaims {
  sub: string;
  phoneNumber: string;
  displayName: string;
  tokenType: "access";
}

export function getRefreshTtlMs(): number {
  return REFRESH_TTL_MS;
}

export function createAccessToken(user: V1AuthUser): { token: string; expiresAt: string } {
  const expiresAt = new Date(Date.now() + ACCESS_TTL_SECONDS * 1000).toISOString();

  const payload: AccessTokenClaims = {
    sub: user.userId,
    phoneNumber: user.phoneNumber,
    displayName: user.displayName,
    tokenType: "access",
  };

  const token = jwt.sign(payload, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: ACCESS_TTL_SECONDS,
  });

  return {
    token,
    expiresAt,
  };
}

export function verifyAccessToken(token: string): V1AuthUser | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload & Partial<AccessTokenClaims>;
    if (decoded.tokenType !== "access" || typeof decoded.sub !== "string") {
      return null;
    }

    if (typeof decoded.phoneNumber !== "string" || typeof decoded.displayName !== "string") {
      return null;
    }

    return {
      userId: decoded.sub,
      phoneNumber: decoded.phoneNumber,
      displayName: decoded.displayName,
    };
  } catch {
    return null;
  }
}

export function readBearerToken(authHeader?: string): string | null {
  if (!authHeader) {
    return null;
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

export function createLiveKitMediaToken(params: {
  roomId: string;
  userId: string;
  displayName: string;
}): { provider: "livekit" | "mock"; token: string; expiresAt: string } {
  const expiresAt = new Date(Date.now() + MEDIA_TOKEN_TTL_SECONDS * 1000).toISOString();

  const livekitApiKey = process.env.LIVEKIT_API_KEY;
  const livekitApiSecret = process.env.LIVEKIT_API_SECRET;

  if (!livekitApiKey || !livekitApiSecret) {
    const mockToken = jwt.sign(
      {
        roomId: params.roomId,
        userId: params.userId,
        displayName: params.displayName,
        tokenType: "mock_media",
      },
      JWT_SECRET,
      {
        expiresIn: MEDIA_TOKEN_TTL_SECONDS,
      },
    );

    return {
      provider: "mock",
      token: mockToken,
      expiresAt,
    };
  }

  const token = jwt.sign(
    {
      iss: livekitApiKey,
      sub: params.userId,
      name: params.displayName,
      video: {
        room: params.roomId,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      },
    },
    livekitApiSecret,
    {
      algorithm: "HS256",
      expiresIn: MEDIA_TOKEN_TTL_SECONDS,
    },
  );

  return {
    provider: "livekit",
    token,
    expiresAt,
  };
}
