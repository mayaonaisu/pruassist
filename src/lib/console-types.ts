export type SessionInfo = {
  joinToken: string;
  roomId: string;
  joinPath: string;
  productArea: string;
  focus: string[];
};

export type Stats = { surfaced: number; used: number; flags: number; docs: number };

export type SummaryData = {
  concerns: string[];
  talkingPoints: string[];
  followUps: string[];
  notes: string;
  stats: Stats;
  durationMin: number;
};
