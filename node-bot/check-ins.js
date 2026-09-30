// Part of #700: gentle check-ins. My affect (acp-memory-store's userAffect)
// comes from keywords, so gamer talk like "ugh, this boss is killing me"
// reads as negative; only a run of low turns (lowTurns, which needs three
// negative turns to start) counts. While it lasts, her reply prompt gets a
// "be gentle, don't pry" line (gentleHint). Once the chat has gone quiet
// she may check in: at most once a day and once per low stretch, through
// the proactive engine (a toast she also says), never while I'm gaming or
// in quiet time.
// MANA_CHECK_INS=0 in node-bot/.env, or the Settings toggle (passed as
// MANA_LAUNCHER_CHECK_INS=0), turns the check-in off; the hint stays.
const LOW_TURNS = 3;
// She waits until I've stopped chatting; a check-in mid-conversation is
// the prompt hint's job. The low read decays within a few hours, so a
// check-in never arrives the next day about yesterday.
const QUIET_CHAT_MS = 30 * 60 * 1000;
// ponytail: fixed 1am-9am (#697's default quiet-hours window); read #697's
// quiet-hours setting (and #705's stream mode) here once they exist.
const QUIET_FROM_HOUR = 1;
const QUIET_UNTIL_HOUR = 9;

const GENTLE_HINT =
  "They've seemed down for a few messages now: be gentle and warm and ease off the teasing. Don't pry or ask what's wrong; if they want to talk about it, just listen.";

const CHECK_IN_TEXT = "Just checking in. I hope you're doing okay. No need to reply, I'm here if you want to talk.";

function isLow(state) {
  return Boolean(state) && state.lowTurns >= LOW_TURNS;
}

// The system-message line for one reply, or null. Coding/developer replies
// are left alone, the same as moodPromptBlock.
function gentleHint(state, mode) {
  if (mode === "coding" || mode === "developer") return null;
  return isLow(state) ? GENTLE_HINT : null;
}

// store: getUserAffectState/recordCheckIn (acp-memory-store). offer: the
// proactive engine's. env: where the opt-out is read.
function createCheckIns({ store, offer, isGaming = () => false, env = process.env, now = Date.now }) {
  const enabled = env.MANA_CHECK_INS !== "0" && env.MANA_LAUNCHER_CHECK_INS !== "0";

  // Called on a timer; returns the proactive engine's answer, or null when
  // she doesn't check in.
  function maybeCheckIn() {
    const t = now();
    const hour = new Date(t).getHours();
    if (!enabled || isGaming() || (hour >= QUIET_FROM_HOUR && hour < QUIET_UNTIL_HOUR)) return null;
    const state = store.getUserAffectState(new Date(t).toISOString());
    const lastTurn = Date.parse(state.lastTurnAt);
    if (!isLow(state) || !(t - lastTurn >= QUIET_CHAT_MS)) return null;
    const lastCheckIn = state.lastCheckInAt ? Date.parse(state.lastCheckInAt) : null;
    if (lastCheckIn !== null && (lastCheckIn >= lastTurn || new Date(lastCheckIn).toDateString() === new Date(t).toDateString())) {
      return null;
    }
    store.recordCheckIn(new Date(t).toISOString());
    return offer({
      reason: "check-in",
      // A toast, and spoken like a reminder: in her voice once she's idle,
      // calm (the launcher's AnnouncementEmotion "check-in" kind).
      payload: {
        type: "cron",
        kind: "check-in",
        title: "Checking in",
        text: CHECK_IN_TEXT,
        speak: CHECK_IN_TEXT,
        at: new Date(t).toISOString(),
      },
    });
  }

  return { maybeCheckIn };
}

module.exports = { createCheckIns, gentleHint, GENTLE_HINT };
