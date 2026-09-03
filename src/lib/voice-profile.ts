import { getStore } from "./store";

// Server-side storage of a rep's voiceprint, keyed by their login. This is the rep's OWN voice
// EMBEDDING — a 192-number vector, never any audio and never a customer's voice — so it sits fully
// inside the privacy promise (raw transcript never persisted; customer quotes 24 h). It is not session
// state, so it gets a ~10-year TTL like kb:custom, and it survives deploys. The model identifier is
// stored with it so a future model swap can invalidate stale profiles (a new model embeds into a
// different space). Same Store seam as everything else (Redis, or the in-process Map).

const key = (username: string) => `rep:voice:${username}`;
const TTL = 60 * 60 * 24 * 3650; // ~10 years — rep data, not session state
export const MAX_PROFILE_BYTES = 4096; // ~1 KB expected; a generous cap that still rejects abuse
export const PROFILE_DIMS = 192;

export type StoredVoiceProfile = { profile: string; dims: 192; model: string; updatedAt: number };

export async function saveVoiceProfile(username: string, base64: string, model: string): Promise<StoredVoiceProfile> {
  if (base64.length > MAX_PROFILE_BYTES) throw new Error("Voice profile is too large.");
  const record: StoredVoiceProfile = { profile: base64, dims: PROFILE_DIMS, model, updatedAt: Date.now() };
  await getStore().set(key(username), record, TTL);
  return record;
}

export async function loadVoiceProfile(username: string): Promise<StoredVoiceProfile | null> {
  return (await getStore().get<StoredVoiceProfile>(key(username))) ?? null;
}

export async function deleteVoiceProfile(username: string): Promise<void> {
  await getStore().del(key(username));
}
