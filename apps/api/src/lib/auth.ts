import { SignJWT, jwtVerify } from "jose";
import crypto from "node:crypto";

export type SessionPayload = {
  userId: string;
  orgId: string;
  role: string;
  userType?: string;
  partyId?: string;
  /**
   * Server-resolved permission state. These fields are never minted into the
   * JWT; authMiddleware adds them after reloading the current operator record
   * from the database on every request.
   */
  permissionOverrides?: Record<string, boolean>;
  permissionsResolved?: boolean;
  iat?: number;
  absoluteExp?: number;
};

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET environment variable is required for API auth");
}

const SECRET_KEY = new TextEncoder().encode(SESSION_SECRET);

export async function createSessionToken(
  userId: string,
  orgId: string,
  role: string,
  extra?: { userType?: string; partyId?: string; absoluteExp?: number; iss?: string; aud?: string },
  expiresIn: string = "24h",
): Promise<string> {
  const claims: Record<string, unknown> = {
    userId,
    orgId,
    role,
    userType: extra?.userType ?? "operator",
    partyId: extra?.partyId,
  };
  if (extra?.absoluteExp) {
    claims.absoluteExp = extra.absoluteExp;
  }
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn);
  if (extra?.iss) jwt.setIssuer(extra.iss);
  if (extra?.aud) jwt.setAudience(extra.aud);
  return jwt.sign(SECRET_KEY);
}

export async function verifySessionToken(
  token: string,
  options?: { issuer?: string; audience?: string },
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET_KEY, {
      issuer: options?.issuer,
      audience: options?.audience,
    });
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(`scrypt:${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const parts = hash.split(":");
    const salt = parts.length === 3 ? parts[1] : parts[0];
    const key = parts.length === 3 ? parts[2] : parts[1];
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(derivedKey.toString("hex") === key);
    });
  });
}
