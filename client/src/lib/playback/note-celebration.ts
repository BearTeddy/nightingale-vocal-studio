export interface NoteCelebration {
  headline: string;
  detail: string;
  accent: string;
  particleCount: number;
}

export function noteCelebrationForStreak(streak: number): NoteCelebration {
  const combo = Math.max(1, Math.floor(streak));
  const detail = combo === 1 ? "ON PITCH" : `${combo} NOTE COMBO`;

  if (combo >= 20) {
    return { headline: "LEGENDARY!", detail, accent: "#f9a8d4", particleCount: 30 };
  }
  if (combo >= 10) {
    return { headline: "SUPERSTAR!", detail, accent: "#fde047", particleCount: 28 };
  }
  if (combo >= 5) {
    return { headline: "AMAZING!", detail, accent: "#c4b5fd", particleCount: 24 };
  }
  if (combo >= 3) {
    return { headline: "GREAT!", detail, accent: "#67e8f9", particleCount: 20 };
  }
  if (combo >= 2) {
    return { headline: "NICE!", detail, accent: "#a7f3d0", particleCount: 16 };
  }
  return { headline: "NOTE HIT!", detail, accent: "#67e8f9", particleCount: 12 };
}
