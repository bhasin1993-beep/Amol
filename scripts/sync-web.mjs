#!/usr/bin/env node
/* Copies the canonical web-app files (repo root) into www/ which Capacitor
   bundles into the Android app. Root stays the source of truth so GitHub
   Pages keeps serving the PWA from "/". Run before `npx cap sync`. */
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const www = join(root, "www");
const FILES = [
  "index.html",
  "paisa-auto.js",
  "paisa-invest.js",
  "paisa-coach.js",
  "paisa-cards.js",
  "manifest.json",
  "sw.js",
  "icon-192.png",
  "icon-512.png",
  "icon-512-maskable.png",
];

mkdirSync(www, { recursive: true });
let n = 0;
for (const f of FILES) {
  const src = join(root, f);
  if (!existsSync(src)) { console.warn("skip (missing):", f); continue; }
  copyFileSync(src, join(www, f));
  n++;
}
console.log(`synced ${n} files -> www/`);
