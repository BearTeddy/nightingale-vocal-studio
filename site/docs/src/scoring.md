# Pitch Scoring

Nightingale includes real-time pitch scoring to gamify the karaoke experience.

## How It Works

1. **Microphone input** — select your microphone and toggle it on with `M`
2. **Pitch detection** — your vocal pitch is analyzed in real-time
3. **Comparison** — your pitch is compared against eligible melody notes. Songs without a reliable melody map show your voice trace without awarding a fallback score.
4. **Scoring** — accuracy is tracked throughout the song

## Pitch Catching: Hard to Easy

Use **Settings → General → Pitch catching**, or click **Pitch 1.00×** in the singing screen. The factor runs from **0.50×** (harder) to **2.00×** (easier), in 0.05 steps, and is saved for future songs.

The factor multiplies the pitch window of your Forgiving, Balanced, or Precision preset. At Balanced, full pitch credit requires ±12.5 cents at 0.50×, ±25 cents at 1.00×, or ±50 cents at 2.00×. Scores taper off outside this full-credit window. One semitone is 100 cents.

Release the slider to apply it during a song. The whole current run is recalculated from its captured pitches; your microphone, recording, and actual pitch trace do not change. Timing and stability requirements are unchanged. Missing or clipped input cannot earn credit.

Personal bests and leaderboards compare only the same preset and factor. Old scores retain their original 1.00× setting. More forgiving performances count as practice, not independent skill mastery.

## Star Ratings

At the end of each song, you receive a star rating based on your overall pitch accuracy. Ratings are saved to your profile's scoreboard.

<!-- TODO: screenshot of the end-of-song results screen with star rating -->
![Star rating](images/stars.png)

## Results

The results screen appears at the end of a song whenever your score is above 0. If an active profile is set, the score is saved to the leaderboard.

## Microphone Selection

- Press `M` to toggle the microphone on/off
- Press `N` to cycle through available microphones
- Press `R` to toggle mic monitoring during playback
- Select a preferred microphone in **Settings → General**
- The active microphone is shown in the HUD during playback

## Latency Calibration

Use **Settings → General → Mic latency** to compensate for speaker-to-microphone delay. The test plays a short beep, listens for it through the selected microphone, and saves `mic_latency_compensation_sec`. You can also adjust the value manually if your room or audio device needs extra tuning.

## Per-Song Scoreboards

Each song maintains a scoreboard of past performances. Scores are tracked per profile, so multiple singers can compete on the same songs.
