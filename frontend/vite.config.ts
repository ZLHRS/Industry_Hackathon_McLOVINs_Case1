import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const target = process.env.NARYADAI_API_TARGET ?? "http://127.0.0.1:8000";
// Set only for this process by scripts/phone_tunnel.py; never allow arbitrary hosts.
const publicHost = process.env.NARYADAI_PUBLIC_HOST;
if (publicHost !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(publicHost)) {
  throw new Error("NARYADAI_PUBLIC_HOST must be one exact Quick Tunnel hostname");
}
const allowedHosts = publicHost ? [publicHost] : [];
// Preserve both Host and Origin: the API independently validates the public origin.
const proxy = { "/api": { target, ws: true } };
const workerLogic = readFileSync(resolve("service-worker.js"), "utf8");

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
        "/icon-192.png",
        "/icon-512.png",
        "/notification-badge.png",
        ...Object.keys(bundle)
          .filter((file) => file.startsWith("assets/"))
          .map((file) => `/${file}`),
      ];
    },
    closeBundle() {
      const version = createHash("sha256")
        .update(
          workerLogic +
            assets.join("|") +
            assets
              .filter((asset) => asset !== "/")
              .map((asset) => readFileSync(resolve("dist", asset.slice(1))))
              .join("|"),
        )
        .digest("hex")
        .slice(0, 12);
      const source = `const SHELL="naryadai-shell-${version}";${workerLogic.replace("__ASSETS__", JSON.stringify(assets))}`;
      writeFileSync(resolve("dist/sw.js"), source);
    },
  };
}

export default defineConfig({
  plugins: [react(), shellWorker()],
  server: { allowedHosts, proxy },
  preview: { allowedHosts, proxy },
});
