import type { RecordRow } from "./agent/types";

export type SessionInfo = {
  joinToken: string;
  roomId: string;
  joinPath: string;
  productArea: string;
  focus: string[];
};

export type Stats = { surfaced: number; used: number; flags: number; docs: number };

// What the live console knows about comprehension, handed to the brief when the session ends.
export type Comprehension = Pick<SummaryData, "record" | "customerName">;

export type SummaryData = {
  concerns: string[];
  talkingPoints: string[];
  followUps: string[];
  notes: string;
  stats: Stats;
  durationMin: number;
  // The Understanding Record: one row per material concept, with the customer's own words as
  // evidence. Empty when the shared store was unavailable during the session.
  record: RecordRow[];
  customerName: string;
  signedBy: string;
};
