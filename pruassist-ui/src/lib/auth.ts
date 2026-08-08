import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export const SESSION_COOKIE = "pru_session";

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set in .env.local");
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
    const { payload } = await jwtVerify(token, secret());
    return payload;
  } catch {
    return null;
  }
}
