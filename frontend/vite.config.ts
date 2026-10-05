import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const target = process.env.NARYADAI_API_TARGET ?? "http://127.0.0.1:8000";
const workerLogic = String.raw`const ASSETS=__ASSETS__;const notificationPath=/^\/?\?notification=[0-9a-f-]{36}$/i;const notificationId=/^[0-9a-f-]{36}$/i;self.addEventListener("install",event=>event.waitUntil(caches.open(SHELL).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith("naryadai-shell-")&&key!==SHELL).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));self.addEventListener("fetch",event=>{const request=event.request,url=new URL(request.url),shellAsset=ASSETS.includes(url.pathname);if(request.method!=="GET"||request.headers.has("Authorization")||url.origin!==self.location.origin||!shellAsset)return;event.respondWith(caches.open(SHELL).then(cache=>cache.match(request,{ignoreVary:true})).then(hit=>hit||fetch(request).then(response=>{if(!response.ok)return response;const copy=response.clone();void caches.open(SHELL).then(cache=>cache.put(request,copy));return response;})));});self.addEventListener("push",event=>{let data={notification_id:"",title:"НАРЯДAI",body:"Новое уведомление",urgent:false,url:"/"};try{const incoming=event.data.json();if(incoming&&typeof incoming==="object")data={...data,...incoming}}catch{}const id=typeof data.notification_id==="string"&&notificationId.test(data.notification_id)?data.notification_id:"naryadai";const title=typeof data.title==="string"?data.title.slice(0,120):"НАРЯДAI";const body=typeof data.body==="string"?data.body.slice(0,240):"Новое уведомление";const urgent=data.urgent===true;const url=typeof data.url==="string"&&notificationPath.test(data.url)?data.url:"/";event.waitUntil(self.registration.showNotification(title,{body,tag:id,renotify:urgent,requireInteraction:urgent,data:{url},...(urgent?{vibrate:[100,80,100]}:{})}))});self.addEventListener("notificationclick",event=>{event.notification.close();const path=typeof event.notification.data?.url==="string"&&notificationPath.test(event.notification.data.url)?event.notification.data.url:"/";const destination=new URL(path,self.location.origin).href;event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{const existing=list.find(client=>new URL(client.url).origin===self.location.origin);return existing?existing.navigate(destination).then(()=>existing.focus()):clients.openWindow(destination)}))});`;

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
  server: { proxy: { "/api": { target, ws: true } } },
  preview: { proxy: { "/api": { target, ws: true } } },
});
