// Frame-by-frame capture of token_connect.html through the Chrome DevTools Protocol.
// node capture.mjs <fps> <outDir> [singleTime outPng]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9337;
const [fps = "30", outDir = join(HERE, "frames"), single, singleOut] = process.argv.slice(2);
const profile = join(HERE, "chrome-profile");
rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1280,720", "about:blank"], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 60; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {}
  await sleep(250);
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method) events.push(msg.method);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: pathToFileURL(join(HERE, "token_connect.html")).href });
for (let i = 0; i < 100 && (await evaluate("document.title").catch(() => "")) !== "READY"; i++) await sleep(100);
if ((await evaluate("document.title")) !== "READY") throw new Error("page not ready");
const T = await evaluate("T");

const shot = async (t, file) => {
  await evaluate(`render(${t})`);
  const { data } = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(file, Buffer.from(data, "base64"));
};

if (single !== undefined) {
  await shot(Number(single), singleOut);
} else {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const n = Math.round(T * Number(fps));
  for (let i = 0; i < n; i++) await shot(i / Number(fps), join(outDir, `f_${String(i).padStart(4, "0")}.png`));
  console.log(`captured ${n} frames, T=${T}s`);
}
ws.close();
chrome.kill();
