import { Channel, invoke, isTauri } from "./runtime";
import { microphoneAdapter } from "./microphone";
import type { MultiplayerPlayer } from "@/types/MultiplayerPlayer";
import type { AppConfig } from "@/types/AppConfig";
import type { PitchFrame } from "@/types/PitchFrame";
import type { MultiplayerScore } from "@/types/MultiplayerScore";
import type { MultiplayerMicrophone } from "@/lib/multiplayer";

export type MultiplayerEvent =
  | { type: "pitch"; player_id: string; frame: PitchFrame }
  | { type: "error"; player_id: string; message: string };
let operations: Promise<unknown> = Promise.resolve();
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.catch(() => {}).then(operation);
  operations = result;
  return result;
}

export const listMultiplayerMicrophones = (): Promise<MultiplayerMicrophone[]> =>
  isTauri ? invoke("list_multiplayer_microphones") : Promise.resolve([]);
export const saveMultiplayerPlayers = (players: MultiplayerPlayer[]): Promise<AppConfig> =>
  invoke("save_multiplayer_players", { players });
export const addMultiplayerScores = (
  songHash: string,
  scores: MultiplayerScore[],
  difficulty: string,
  pitchToleranceFactor: number,
): Promise<void> =>
  invoke("add_multiplayer_scores", { songHash, scores, difficulty, pitchToleranceFactor });

export function startMultiplayerCapture(
  players: MultiplayerPlayer[],
  onEvent: (event: MultiplayerEvent) => void,
): Promise<() => Promise<void>> {
  return enqueue(async () => {
    if (!isTauri) throw new Error("Multiplayer microphone capture requires the desktop app.");
    await microphoneAdapter.stopCapture();
    const sessionId = crypto.randomUUID();
    const channel = new Channel<MultiplayerEvent>();
    channel.onmessage = onEvent;
    try {
      await invoke("start_multiplayer_capture", { sessionId, players, onEvent: channel });
    } catch (error) {
      void invoke("stop_multiplayer_capture", { sessionId });
      throw error;
    }
    return () =>
      enqueue(async () => {
        await invoke("stop_multiplayer_capture", { sessionId });
        channel.onmessage = () => {};
      });
  });
}
