import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "pru_session";

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set in .env.local");
  // jose does not enforce a minimum HMAC key length, and a short secret makes every session
  // token brute-forceable. Generate one with: openssl rand -hex 32
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
    // Pin the algorithm and require an expiry: the 8-hour lifetime is otherwise enforced only by
    // the signer, so any token minted without `exp` would be a session that never ends.
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
      requiredClaims: ["exp", "sub"],
    });
    return payload;
  } catch {
    return null;
  }
}

// The signed-in representative for the current request, or null. Route handlers use this instead
// of reading the cookie themselves so every protected route enforces the check the same way.
export async function currentRep(): Promise<JWTPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? verifySessionToken(token) : null;
}
