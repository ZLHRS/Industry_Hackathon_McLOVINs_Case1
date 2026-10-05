import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const target = process.env.NARYADAI_API_TARGET ?? "http://127.0.0.1:8000";
function shellWorker(): Plugin {
  let assets: string[] = [];
  return {
    name: "naryadai-shell-worker",
    apply: "build",
    generateBundle(_, bundle) {
      assets = [
        "/",
        "/index.html",
        "/manifest.webmanifest",
        "/icon.svg",
        ...Object.keys(bundle)
          .filter((file) => file.startsWith("assets/"))
          .map((file) => `/${file}`),
      ];
    },
    closeBundle() {
      const version = createHash("sha256")
        .update(
          assets.join("|") +
            assets
              .filter((asset) => asset !== "/")
              .map((asset) => readFileSync(resolve("dist", asset.startsWith("/") ? asset.slice(1) : asset)))
              .join("|"),
        )
        .digest("hex")
        .slice(0, 12);
      const source = `const SHELL="naryadai-shell-${version}";const ASSETS=${JSON.stringify(assets)};self.addEventListener("install",e=>e.waitUntil(caches.open(SHELL).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith("naryadai-shell-")&&k!==SHELL).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));self.addEventListener("fetch",e=>{const r=e.request,u=new URL(r.url),allowed=ASSETS.includes(u.pathname)||u.pathname.startsWith("/assets/");if(r.method!=="GET"||r.headers.has("Authorization")||u.origin!==self.location.origin||!allowed)return;e.respondWith(caches.open(SHELL).then(c=>c.match(r,{ignoreVary:true})).then(hit=>hit||fetch(r).then(res=>{if(!res.ok)return res;const copy=res.clone();void caches.open(SHELL).then(c=>c.put(r,copy));return res;})));});`;
      writeFileSync(resolve("dist/sw.js"), source);
    },
  };
}
export default defineConfig({
  plugins: [react(), shellWorker()],
  server: { proxy: { "/api": target } },
  preview: { proxy: { "/api": target } },
});
