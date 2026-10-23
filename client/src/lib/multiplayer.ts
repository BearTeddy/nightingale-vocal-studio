import type { MultiplayerPlayer } from "@/types/MultiplayerPlayer";

export const PLAYER_COLORS = ["#67e8f9", "#f9a8d4", "#fde047", "#a7f3d0"] as const;
export interface MultiplayerMicrophone {
  name: string;
  label: string;
  channels: number;
}

export function multiplayerSetupError(
  players: readonly MultiplayerPlayer[],
  devices?: readonly MultiplayerMicrophone[],
): string | null {
  if (players.length < 2 || players.length > 4) return "Choose two to four singers.";
  for (let index = 0; index < players.length; index += 1) {
    const player = players[index];
    if (!player.profile.trim() || player.profile.length > 40)
      return `Player ${index + 1}: enter a name (up to 40 characters).`;
    if (!player.microphone) return `Choose a microphone for ${player.profile}.`;
    const device = devices?.find((device) => device.name === player.microphone);
    if (devices && !device)
      return `${player.profile}: reconnect ${player.microphone} or choose another microphone.`;
    if (
      player.channel != null &&
      (!Number.isInteger(player.channel) ||
        player.channel < 0 ||
        (device && player.channel >= device.channels))
    )
      return `${player.profile}: select an available channel.`;
    for (const other of players.slice(0, index)) {
      if (other.id === player.id || other.profile.trim() === player.profile.trim())
        return "Each singer needs a different name.";
      if (
        other.microphone === player.microphone &&
        (other.channel == null || player.channel == null || other.channel === player.channel)
      ) {
        return "Assign a different microphone or separate input channel to each singer.";
      }
    }
  }
  return null;
}
