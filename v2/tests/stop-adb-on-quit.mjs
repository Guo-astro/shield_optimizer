// "Stop ADB when quitting" stops the adb server for every tool on the
// computer, so the checkbox must never read off while quitting would still
// stop it. It shows only what the native side confirmed: a change that fails
// or loses a race leaves the box where the setting really is. The native
// setting starts off with every launch, and the saved choice is handed back
// to it on load.
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
  const saved = () => page.evaluate((key) => localStorage.getItem(key), SAVED);
  const flag = (name, on) =>
    page.evaluate(
      ([key, value]) => (value ? localStorage.setItem(key, "1") : localStorage.removeItem(key)),
      [`shieldopt.demo.${name}`, on],
    );
  // Every click waits for its reply before the next assertion.
  const click = async () => {
    await box.click();
    await page.waitForFunction(
      (el) => el && !el.disabled,
      await box.elementHandle(),
    );
  };

  await box.waitFor();
  assert.equal(await box.isChecked(), false, "the stop is off until someone turns it on");
  assert.equal(await warning.count(), 0, "and there is nothing to warn about yet");

  await click();
  assert.equal(await box.isChecked(), true, "a confirmed change ticks the box");
  assert.match(await warning.innerText(), /Android Studio, scrcpy/, "turning it on names who else loses adb");
  assert.equal(await saved(), "true", "and the confirmed choice is saved");

  // A fresh launch: the native side starts off again, and the saved choice
  // is handed back to it.
  await page.reload({ waitUntil: "networkidle" });
  await box.waitFor();
  await page.waitForFunction((el) => el?.checked, await box.elementHandle());
  assert.equal(await box.isChecked(), true, "a saved choice survives a relaunch");

  // A change that fails leaves the box on, because the stop still is.
  await flag("stopAdbOnQuitFails", true);
  await click();
  assert.equal(await box.isChecked(), true, "a failed change cannot make the box read off");
  assert.equal(await warning.count(), 1, "and the warning stays up with it");
  assert.match(await page.locator(".connect-form").innerText(), /Couldn't change Stop ADB when quitting/);
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

  console.log(
    "Stop ADB when quitting passed: the box only shows confirmed changes, a failed or outdated change never reads off while the stop is on, and the saved choice comes back on relaunch.",
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
