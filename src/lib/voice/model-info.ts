// The current speaker-embedding model, named in one place so a swap is a one-line change (§3 of the
// design). VOICE_MODEL is stored alongside each rep's profile; if it later differs from a stored
// profile's `model`, useVoiceProfile treats that profile as stale and prompts re-enrolment (a new model
// produces embeddings in a different space, so old vectors are meaningless against it).
export const VOICE_MODEL = "next-tdnn-c128";
export const VOICE_MODEL_URL = "/models/next-tdnn-c128.onnx";
