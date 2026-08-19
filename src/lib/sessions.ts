import { randomBytes } from "crypto";
import { getStore } from "./store";

// Advisory session registry.
//
// Backed by the shared Store rather than a Map, so the rep's serverless instance and the
// customer's can see the same session (see store.ts). The room record is the single source of
// truth; the join token is a pointer to it, so ending a session can't leave the two disagreeing.

export type SessionContext = { productArea: string; focus: string[] };
export type Session = {
  joinToken: string; // unguessable — embedded in the customer link
  roomId: string; // unguessable — the LiveKit room
  repName: string;
  context: SessionContext;
  startedAt: string;
  active: boolean;
};

const roomKey = (roomId: string) => `sess:room:${roomId}`;
const tokenKey = (token: string) => `sess:tok:${token}`;

export async function createSession(repName: string, context: SessionContext): Promise<Session> {
  const session: Session = {
    joinToken: randomBytes(12).toString("base64url"),
    roomId: "pru-" + randomBytes(9).toString("base64url"),
    repName,
    context,
    startedAt: new Date().toISOString(),
    active: true,
  };
  const store = getStore();
  await store.set(roomKey(session.roomId), session);
  await store.set(tokenKey(session.joinToken), session.roomId);
  return session;
}

export async function getByRoom(roomId: string): Promise<Session | null> {
  return getStore().get<Session>(roomKey(roomId));
}

export async function getByToken(token: string): Promise<Session | null> {
  const roomId = await getStore().get<string>(tokenKey(token));
  return roomId ? getByRoom(roomId) : null;
}

export async function endSession(roomId: string): Promise<Session | null> {
  const session = await getByRoom(roomId);
  if (!session) return null;
  const ended = { ...session, active: false };
  await getStore().set(roomKey(roomId), ended);
  return ended;
}
