import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const state = JSON.parse(readFileSync(resolve(project, "tmp/e2e-server.json"), "utf8"));

async function waitForRealtimeReady(page: Page) {
  await expect(page.locator(".live-bar")).toHaveAttribute("data-live-state", "live", { timeout: 5000 });
}

async function login(page: Page, account: string) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(account);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("button", { name: /Уведомления: непрочитанных/ })).toBeVisible();
  await waitForRealtimeReady(page);
}

async function auth(request: APIRequestContext) {
  const response = await request.post("/api/v1/auth/login", {
    data: { login: state.master_login, secret: state.secret },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).access_token as string;
}

async function issue(request: APIRequestContext, token: string) {
  const description = "Realtime проверка " + crypto.randomUUID().slice(0, 8);
  const response = await request.post("/api/v1/work-orders", {
    headers: { Authorization: "Bearer " + token, "Idempotency-Key": crypto.randomUUID() },
    data: {
      work_type: "unplanned",
      priority: "emergency",
      description,
      area_id: state.area_id,
      equipment_id: state.equipment_id,
      executor_id: state.selected_executor_id,
      deadline: new Date(Date.now() + 3600000).toISOString(),
    },
  });
  expect(response.status()).toBe(201);
  const id = (await response.json()).order_id as string;
  const detail = await request.get("/api/v1/work-orders/" + id, {
    headers: { Authorization: "Bearer " + token },
  });
  return { id, description, detail: await detail.json() };
}

test("two clients: issue and open-card status within 5s, urgent receipt, reconnect", async ({
  page,
  browser,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const executor = await context.newPage();
  executor.on("pageerror", (error) => errors.push(error.message));
  try {
    await login(page, state.master_login);
    await login(executor, state.executor_login);
    const token = await auth(request);
    const issuedAt = Date.now();
    const order = await issue(request, token);
    await expect(executor.getByText(order.description, { exact: true })).toBeVisible({ timeout: 5000 });
    const issueMs = Date.now() - issuedAt;
    expect(issueMs).toBeLessThanOrEqual(5000);
    await expect(page.getByText(order.description, { exact: true })).toBeVisible({ timeout: 5000 });
    await page.getByText(order.description, { exact: true }).click();
    await executor.getByRole("button", { name: /Уведомления: непрочитанных/ }).click();
    const inbox = executor.getByRole("dialog");
    const notification = inbox.locator(".notification-item").filter({ hasText: order.detail.number }).first();
    await expect(notification).toBeVisible();
    await expect(notification).toHaveClass(/urgent/);
    await notification.getByRole("button", { name: "Подтвердить получение" }).click();
    await expect(notification.getByRole("button", { name: "Подтвердить получение" })).toHaveCount(0);
    const afterAck = await request.get("/api/v1/work-orders/" + order.id, {
      headers: { Authorization: "Bearer " + token },
    });
    expect((await afterAck.json()).status).toBe("issued");
    await executor.screenshot({ path: info.outputPath("urgent-inbox-mobile.png"), fullPage: true });
    expect(await executor.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await notification.getByRole("button", { name: "Открыть наряд" }).click();
    const acceptedAt = Date.now();
    await executor.getByRole("dialog").getByRole("button", { name: "Принять", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: /· Принят$/ })).toBeVisible({
      timeout: 5000,
    });
    const acceptMs = Date.now() - acceptedAt;
    expect(acceptMs).toBeLessThanOrEqual(5000);
    await page.screenshot({ path: info.outputPath("realtime-master-detail.png"), fullPage: true });
    writeFileSync(info.outputPath("realtime-latency.json"), JSON.stringify({ issueMs, acceptMs }));
    await info.attach("realtime-latency", {
      body: JSON.stringify({ issueMs, acceptMs }),
      contentType: "application/json",
    });
    await executor.keyboard.press("Escape");
    await context.setOffline(true);
    const missed = await issue(request, token);
    await context.setOffline(false);
    await waitForRealtimeReady(executor);
    await expect(executor.getByText(missed.description, { exact: true })).toBeVisible();
    await expect(executor.getByRole("button", { name: /Уведомления: непрочитанных/ })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("actual service worker displays native urgent notification from injected push event", async ({
  browser,
}, info) => {
  const isolated = await browser.browserType().launch({ channel: info.project.use.channel, headless: true });
  const context = await isolated.newContext({
    baseURL: info.project.use.baseURL,
    permissions: ["notifications"],
  });
  const page = await context.newPage();
  const origin = new URL(info.project.use.baseURL!).origin;
  const scopeURL = new URL("/", origin).href;
  const scriptURL = new URL("/sw.js", origin).href;
  let registrationId = "";
  const lifecycleEvents: Array<Record<string, unknown>> = [];
  try {
    const cdp = await context.newCDPSession(page);
    const registrations = new Map<string, { scopeURL: string; isDeleted: boolean }>();
    const versions = new Map<
      string,
      { registrationId: string; scriptURL: string; status: string; runningStatus: string }
    >();
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations: updated }) => {
      for (const registration of updated) {
        if (registration.isDeleted) registrations.delete(registration.registrationId);
        else registrations.set(registration.registrationId, registration);
      }
      lifecycleEvents.push({
        type: "registration",
        registrations: updated.map((registration) => ({
          registrationId: registration.registrationId,
          scopeURL: registration.scopeURL,
          isDeleted: registration.isDeleted,
        })),
      });
    });
    cdp.on("ServiceWorker.workerVersionUpdated", ({ versions: updated }) => {
      for (const version of updated) versions.set(version.versionId, version);
      lifecycleEvents.push({
        type: "version",
        versions: updated.map((version) => ({
          versionId: version.versionId,
          registrationId: version.registrationId,
          scriptURL: version.scriptURL,
          status: version.status,
          runningStatus: version.runningStatus,
        })),
      });
    });
    await cdp.send("ServiceWorker.enable");
    await page.goto("/");
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          return Boolean(registration.active && navigator.serviceWorker.controller);
        }),
      )
      .toBe(true);
    await expect
      .poll(async () => {
        const ready = await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          return { scope: registration.scope, activeScript: registration.active?.scriptURL ?? null };
        });
        const matching = [...registrations.entries()].filter(
          ([, registration]) => !registration.isDeleted && registration.scopeURL === ready.scope,
        );
        if (ready.scope !== scopeURL || ready.activeScript !== scriptURL || matching.length !== 1)
          return false;
        registrationId = matching[0][0];
        return true;
      })
      .toBe(true);
    await cdp.send("ServiceWorker.startWorker", { scopeURL });
    await expect
      .poll(() =>
        [...versions.values()].some(
          (version) =>
            version.registrationId === registrationId &&
            version.scriptURL === scriptURL &&
            version.status === "activated" &&
            version.runningStatus === "running",
        ),
      )
      .toBe(true);
    const notificationId = crypto.randomUUID();
    const payload = {
      notification_id: notificationId,
      title: "Аварийный наряд",
      body: "Новое служебное уведомление. Откройте приложение.",
      urgent: true,
      url: "/?notification=" + notificationId,
    };
    await cdp.send("ServiceWorker.deliverPushMessage", {
      origin: new URL(info.project.use.baseURL!).origin,
      registrationId,
      data: JSON.stringify(payload),
    });
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          const notifications = await registration.getNotifications();
          return notifications.map((note) => ({
            title: note.title,
            data: note.data,
            requireInteraction: note.requireInteraction,
            icon: note.icon,
            badge: note.badge,
          }));
        }),
      )
      .toEqual([
        {
          title: payload.title,
          data: { url: payload.url },
          requireInteraction: true,
          icon: new URL("/icon-192.png", info.project.use.baseURL!).href,
          badge: new URL("/notification-badge.png", info.project.use.baseURL!).href,
        },
      ]);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      for (const notification of await registration.getNotifications()) notification.close();
    });
    await cdp.detach();
  } finally {
    await info.attach("service-worker-lifecycle", {
      body: JSON.stringify({ origin, scopeURL, registrationId, lifecycleEvents }),
      contentType: "application/json",
    });
    await isolated.close();
  }
});
