import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "pru_session";

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set in .env.local");
  // A short secret makes every session token brute-forceable: openssl rand -hex 32
  if (s.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters (openssl rand -hex 32)");
  return new TextEncoder().encode(s);
}

// Sign a session token for an authenticated representative.
export async function createSessionToken(username: string): Promise<string> {
  return new SignJWT({ role: "rep", name: username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(username)
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(secret());
}

// Verify a session token; returns the payload, or null if invalid/expired.
export async function verifySessionToken(token: string): Promise<JWTPayload | null> {
  try {
    // Pin the algorithm and require exp, or a token minted without one never expires.
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
      requiredClaims: ["exp", "sub"],
    });
    return payload;
  } catch {
    return null;
  }
}

// The signed-in representative for the current request, or null.
export async function currentRep(): Promise<JWTPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? verifySessionToken(token) : null;
}
