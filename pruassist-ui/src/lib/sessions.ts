import { randomBytes } from "crypto";

// Demo-grade in-memory session registry (resets when the server restarts).
// In production this would be a database row per advisory session.

export type SessionContext = { productArea: string; focus: string[] };
export type Session = {
  joinToken: string; // unguessable — embedded in the customer link
  roomId: string; // unguessable — the LiveKit room
  repName: string;
  context: SessionContext;
  startedAt: string;
  active: boolean;
};

const byToken = new Map<string, Session>();
const byRoom = new Map<string, Session>();

export function createSession(repName: string, context: SessionContext): Session {
  const session: Session = {
    joinToken: randomBytes(12).toString("base64url"),
    roomId: "pru-" + randomBytes(9).toString("base64url"),
    repName,
    context,
    startedAt: new Date().toISOString(),
    active: true,
  };
  byToken.set(session.joinToken, session);
  byRoom.set(session.roomId, session);
  return session;
}

export function getByToken(token: string): Session | null {
  return byToken.get(token) ?? null;
}
export function getByRoom(roomId: string): Session | null {
  return byRoom.get(roomId) ?? null;
}
export function endSession(roomId: string): Session | null {
  const s = byRoom.get(roomId);
  if (s) s.active = false;
  return s ?? null;
}
