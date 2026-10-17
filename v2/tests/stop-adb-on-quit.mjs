// "Stop ADB when quitting" stops the adb server for every tool on the
// computer, so the checkbox must never read off while quitting would still
// stop it. It shows only what the native side confirmed: until then, and
// after a read fails, it reads unknown; a change that fails or loses a race
// leaves the box where the setting really is; and a late reply, even one
// asked for by a Devices page that has since closed, can't replace a newer
// one on screen or in the saved choice. The native setting outlives a page
// change and a webview reload, starts off with every launch, and gets the
// saved choice back on the first read.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const V2 = join(HERE, "..");
const SAVED = "shieldopt.stopAdbOnQuit";

function serverURL(server) {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

function setHarnessEnvironment() {
  const keys = ["VITE_DEMO", "TAURI_DEV_HOST"];
  const previous = new Map(keys.map((k) => [k, { present: Object.hasOwn(process.env, k), value: process.env[k] }]));
  process.env.VITE_DEMO = "1";
  delete process.env.TAURI_DEV_HOST;
  return () => {
    for (const [k, prior] of previous) {
      if (prior.present) process.env[k] = prior.value;
      else delete process.env[k];
    }
  };
}

async function exercise({ browser, base }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto(base, { waitUntil: "networkidle" });

  const box = page.getByRole("checkbox", { name: "Stop ADB when quitting" });
  const warning = page.locator(".quit-warning");
  const problem = page.locator(".quit-error");
  const saved = () => page.evaluate((key) => localStorage.getItem(key), SAVED);
  const flag = (name, on) =>
    page.evaluate(
      ([key, value]) => (value ? localStorage.setItem(key, "1") : localStorage.removeItem(key)),
      [`shieldopt.demo.${name}`, on],
    );
  const shown = () =>
    box.evaluate((el) => ({ checked: el.checked, unknown: el.indeterminate, disabled: el.disabled }));
  const confirmed = async () => {
    await box.waitFor();
    await page.waitForFunction((el) => el && !el.disabled, await box.elementHandle());
  };
  // Every click waits for its reply before the next assertion.
  const click = async () => {
    await box.click();
    await confirmed();
  };
  const held = () => page.evaluate(() => window.__demoHeldReplies.count());
  const release = (which) => page.evaluate((w) => window.__demoHeldReplies.release(w), which);
  const relaunch = async () => {
    await page.evaluate(() => sessionStorage.removeItem("shieldopt.demo.native.stopAdbOnQuit"));
    await page.reload({ waitUntil: "networkidle" });
    await confirmed();
  };
  const remount = async () => {
    await page.getByRole("link", { name: "Snapshots" }).click();
    await page.waitForURL("**/snapshots");
    await page.getByRole("link", { name: "Devices" }).click();
    await box.waitFor();
  };

  await confirmed();
  assert.equal(await box.isChecked(), false, "the stop is off until someone turns it on");
  assert.equal(await warning.count(), 0, "and there is nothing to warn about yet");

  await click();
  assert.equal(await box.isChecked(), true, "a confirmed change ticks the box");
  assert.match(await warning.innerText(), /Android Studio, scrcpy/, "turning it on names who else loses adb");
  assert.equal(await saved(), "true", "and the confirmed choice is saved");

  // A fresh launch: the native side starts off again, and the saved choice
  // is handed back to it.
  await relaunch();
  assert.equal(await box.isChecked(), true, "a saved choice survives a relaunch");

  // A change that fails leaves the box on, because the stop still is.
  await flag("stopAdbOnQuitFails", true);
  await click();
  assert.equal(await box.isChecked(), true, "a failed change cannot make the box read off");
  assert.equal(await warning.count(), 1, "and the warning stays up with it");
  assert.match(await problem.innerText(), /Couldn't change Stop ADB when quitting/);
  assert.equal(await saved(), "true", "nothing unconfirmed is saved");
  await flag("stopAdbOnQuitFails", false);

  // Off always lands, even from an outdated view.
  await flag("stopAdbOnQuitRaced", true);
  await click();
  assert.equal(await box.isChecked(), false, "turning the stop off is never refused");
  assert.equal(await saved(), "false");

  // On from an outdated view is refused, and the box shows the refusal.
  await click();
  assert.equal(await box.isChecked(), false, "a refused change leaves the box where the setting is");
  assert.equal(await saved(), "false");
  await flag("stopAdbOnQuitRaced", false);

  await click();
  assert.equal(await box.isChecked(), true, "with the race gone, the change goes through");

  // The webview reloads while the stop is on. Until the read answers, the
  // box says it doesn't know rather than reading off.
  await flag("stopAdbOnQuitHeld", true);
  await page.reload({ waitUntil: "networkidle" });
  await box.waitFor();
  assert.deepEqual(await shown(), { checked: false, unknown: true, disabled: true }, "an unanswered read is unknown, not off");
  assert.match(await page.locator(".quit-toggle").innerText(), /checking/);
  await release("oldest");
  await confirmed();
  assert.deepEqual(await shown(), { checked: true, unknown: false, disabled: false }, "then shows the stop is on");
  assert.equal(await warning.count(), 1);
  await flag("stopAdbOnQuitHeld", false);

  // A read that fails after a reload stays unknown, with a way to ask again.
  await flag("stopAdbOnQuitReadFails", true);
  await page.reload({ waitUntil: "networkidle" });
  await problem.waitFor();
  assert.deepEqual(await shown(), { checked: false, unknown: true, disabled: true }, "a failed read never reads off");
  assert.match(await problem.innerText(), /Couldn't read Stop ADB when quitting, so it may still be on/);
  await flag("stopAdbOnQuitReadFails", false);
  await page.getByRole("button", { name: "Check again" }).click();
  await confirmed();
  assert.equal(await box.isChecked(), true, "asking again finds the stop still on");
  assert.equal(await problem.count(), 0, "and the failure is gone");

  // Coming back to Devices while the stop is on shows it straight away, even
  // before the new page's read is answered.
  await flag("stopAdbOnQuitHeld", true);
  await remount();
  assert.deepEqual(await shown(), { checked: true, unknown: false, disabled: false }, "a page change keeps the confirmed state");
  assert.equal(await warning.count(), 1);
  await release("oldest");
  assert.equal(await held(), 0);
  await flag("stopAdbOnQuitHeld", false);

  // Turn it off, then ask for On and leave the page before the reply comes.
  await click();
  assert.equal(await saved(), "false");
  await flag("stopAdbOnQuitHeld", true);
  await box.click();
  assert.equal(await held(), 1, "the On request has been answered natively but not delivered");
  await remount();
  assert.deepEqual(await shown(), { checked: false, unknown: true, disabled: true }, "a change on its way is unknown");
  // The new page's read sees the On that landed natively.
  await release("newest");
  await confirmed();
  assert.equal(await box.isChecked(), true, "the new page shows the On that landed");
  // Turned off on the new page, and that reply arrives.
  await box.click();
  await release("newest");
  await confirmed();
  assert.equal(await box.isChecked(), false);
  assert.equal(await saved(), "false");
  // Only now does the old page's reply arrive.
  await release("oldest");
  assert.equal(await held(), 0);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  assert.equal(await box.isChecked(), false, "a late reply cannot turn the box back on");
  assert.equal(await saved(), "false", "or save the older On");
  await flag("stopAdbOnQuitHeld", false);
  await relaunch();
  assert.equal(await box.isChecked(), false, "so the next launch keeps the stop off");

  console.log(
    "Stop ADB when quitting passed: the box only shows confirmed changes and reads unknown until it has one, a failed or outdated change never reads off while the stop is on, a late reply from a closed page can't bring back an older choice, and the saved choice comes back on relaunch.",
  );
}

async function main() {
  const restore = setHarnessEnvironment();
  let server, browser;
  try {
    const { createServer } = await import("vite");
    const { chromium } = await import("playwright");
    server = await createServer({ root: V2, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
    await server.listen();
    browser = await chromium.launch();
    await exercise({ browser, base: serverURL(server) });
  } finally {
    await browser?.close().catch((e) => console.error("browser cleanup failed", e));
    await server?.close().catch((e) => console.error("Vite cleanup failed", e));
    restore();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
