// "Stop ADB when quitting" as the native side last confirmed it. It lives here
// rather than in the Devices page so every instance of that page shares one
// view: a reply that lands after its page has closed still counts, and an older
// reply can never replace a newer one, on screen or in the saved choice.
import { api } from "$lib/api";
import { getStopAdbOnQuit, setStopAdbOnQuit } from "$lib/prefs";
import type { StopAdbOnQuit } from "$lib/types";

export const stopOnQuit = $state({
  /// null whenever the setting is unconfirmed: before the first read, while a
  /// change is on its way, and after a read fails. The stop may be on then.
  setting: null as StopAdbOnQuit | null,
  /// Reads and changes still waiting for their reply.
  pending: 0,
  error: "",
});

// Every applied change raises the native generation, so the reply carrying
// the highest one is the newest state, whatever order replies arrive in.
let newest = 0;
let reading: Promise<void> | null = null;

function adopt(next: StopAdbOnQuit) {
  if (next.generation < newest) return;
  newest = next.generation;
  stopOnQuit.setting = next;
  setStopAdbOnQuit(next.enabled);
}

async function read() {
  stopOnQuit.pending++;
  try {
    let current = await api.stopAdbOnQuit();
    // The native setting starts off with every launch; hand the saved choice
    // back the first time this run is read.
    if (current.generation === 0 && getStopAdbOnQuit()) {
      current = await api.setStopAdbOnQuit(true, current.generation);
    }
    adopt(current);
  } catch (e) {
    stopOnQuit.setting = null;
    stopOnQuit.error = `Couldn't read Stop ADB when quitting, so it may still be on: ${e}`;
  } finally {
    stopOnQuit.pending--;
  }
}

function readOnce(): Promise<void> {
  reading ??= read().finally(() => {
    reading = null;
  });
  return reading;
}

export function refreshStopOnQuit(): Promise<void> {
  stopOnQuit.error = "";
  return readOnce();
}

export async function toggleStopOnQuit() {
  const from = stopOnQuit.setting;
  if (!from) return;
  stopOnQuit.setting = null;
  stopOnQuit.error = "";
  stopOnQuit.pending++;
  try {
    adopt(await api.setStopAdbOnQuit(!from.enabled, from.generation));
  } catch (e) {
    stopOnQuit.error = `Couldn't change Stop ADB when quitting: ${e}`;
    // The change may or may not have landed, so ask where it stands.
    await readOnce();
  } finally {
    stopOnQuit.pending--;
  }
}
