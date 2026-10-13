import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NotificationItem } from "../src/types";

const state = JSON.parse(readFileSync(resolve("../tmp/e2e-server.json"), "utf8"));

for (const width of [390, 700, 1440]) {
  test(`grouped inbox preserves receipts, unread filter and navigation at ${width}px`, async ({
    page,
    request,
  }, info) => {
    const login = await request.post("/api/v1/auth/login", {
      data: { login: state.master_login, secret: state.secret },
    });
    const token = (await login.json()).access_token;
    const orders = await request.get("/api/v1/work-orders?limit=1", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const order = (await orders.json()).items[0];
    const base: NotificationItem = {
      id: "notice-a",
      order_id: order.id,
      fault_report_id: null,
      kind: "overdue",
      title: `Просрочен наряд ${order.number}`,
      body: "Проверьте состояние оборудования и обновите статус работ.",
      urgent: true,
      action_required: true,
      created_at: "2026-10-12T10:00:00Z",
      read_at: null,
      acknowledged_at: null,
      payload: { number: order.number, order_description: order.description },
    };
    let items: NotificationItem[] = [
      base,
      { ...base, id: "notice-b", urgent: false, title: `Наряд ${order.number} не принят` },
    ];
    let fail = false;
    await page.route(/\/api\/v1\/notifications(?:\/|\?|$)/, async (route) => {
      const url = new URL(route.request().url());
      if (!/^\/api\/v1\/notifications(?:\/[^/]+\/(?:read|ack))?$/.test(url.pathname)) return route.continue();
      if (route.request().method() === "GET") {
        if (fail) return route.fulfill({ status: 503, json: { detail: "unavailable" } });
        const visible =
          url.searchParams.get("unread_only") === "true" ? items.filter((item) => !item.read_at) : items;
        return route.fulfill({
          json: {
            items: visible.slice(
              Number(url.searchParams.get("offset") ?? 0),
              Number(url.searchParams.get("offset") ?? 0) + 50,
            ),
            total: visible.length,
            unread_count: items.filter((item) => !item.read_at).length,
          },
        });
      }
      const id = url.pathname.split("/")[4];
      const item = items.find((entry) => entry.id === id)!;
      const next = {
        ...item,
        read_at: "2026-10-12T11:00:00Z",
        acknowledged_at: url.pathname.endsWith("/ack") ? "2026-10-12T11:00:00Z" : item.acknowledged_at,
      };
      items = items.map((entry) => (entry.id === id ? next : entry));
      return route.fulfill({ json: next });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
    await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await page.getByRole("button", { name: /Уведомления: непрочитанных/ }).click();
    const inbox = page.getByRole("dialog");
    await expect(inbox.locator(".notification-group")).toHaveCount(1);
    await expect(inbox.locator(".notification-item")).toHaveCount(2);
    const group = inbox.locator(".notification-group");
    const toggle = group.locator("summary");
    await expect(toggle).toContainText(order.description);
    await expect(group).not.toHaveAttribute("open");
    await expect(inbox.locator(".notification-item").first()).toBeHidden();
    await expect(inbox.getByText("Событий: 2 · непрочитано: 2", { exact: true })).toBeVisible();
    await expect(inbox.getByText("Требуется подтверждение", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`notifications-collapsed-${width}.png`) });
    await toggle.click();
    await expect(group).toHaveAttribute("open", "");
    await expect(inbox.locator(".notification-item").first()).toBeVisible();
    // The summary keeps focus and supports native keyboard disclosure.
    await toggle.press("Enter");
    await expect(group).not.toHaveAttribute("open");
    await toggle.press("Space");
    await expect(group).toHaveAttribute("open", "");
    expect(items.every((item) => !item.read_at)).toBe(true);
    expect(await inbox.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const buttons = await inbox.locator(".notification-actions button").evaluateAll((elements) =>
      elements.map((element) => {
        const r = element.getBoundingClientRect();
        const dialog = element.closest("dialog")!.getBoundingClientRect();
        return r.left >= dialog.left && r.right <= dialog.right;
      }),
    );
    expect(buttons.every(Boolean)).toBe(true);
    await page.screenshot({ path: info.outputPath(`notifications-${width}.png`) });
    await inbox.getByRole("button", { name: "Подтвердить получение", exact: true }).click();
    await expect(inbox.getByText("Событий: 2 · непрочитано: 1", { exact: true })).toBeVisible();
    await expect(group).toHaveAttribute("open", "");
    await expect(inbox.getByText("Требуется подтверждение", { exact: true })).toHaveCount(0);
    await expect(inbox.getByRole("button", { name: "Подтвердить получение", exact: true })).toHaveCount(0);
    await inbox.getByLabel("Только непрочитанные", { exact: true }).check();
    await expect(inbox.locator(".notification-item")).toHaveCount(1);
    await expect(group).not.toHaveAttribute("open");
    await toggle.click();
    await inbox.getByRole("button", { name: "Прочитано", exact: true }).click();
    await expect(inbox.getByText("Уведомлений нет.", { exact: true })).toBeVisible();
    fail = true;
    await inbox.getByLabel("Только непрочитанные", { exact: true }).uncheck();
    await expect(inbox.getByRole("alert")).toContainText("Не удалось получить уведомления.");
    fail = false;
    await inbox.getByRole("button", { name: "Повторить", exact: true }).click();
    await expect(inbox.locator(".notification-item")).toHaveCount(2);
    await expect(group).not.toHaveAttribute("open");
    await toggle.click();
    {
      items = Array.from({ length: 51 }, (_, index) => ({ ...base, id: `page-${index}`, urgent: false }));
      await inbox.getByLabel("Только непрочитанные", { exact: true }).check();
      await expect(inbox.locator(".notification-item")).toHaveCount(50);
      await expect(inbox.getByText("На этой странице: 50 из 51 уведомлений.", { exact: true })).toBeVisible();
      await expect(inbox.getByText("Страница 1 из 2", { exact: true })).toBeVisible();
      await expect(inbox.getByRole("button", { name: "Предыдущие уведомления", exact: true })).toBeDisabled();
      await page.screenshot({ path: info.outputPath(`pagination-${width}.png`) });
      await inbox.getByRole("button", { name: "Следующие уведомления", exact: true }).click();
      await expect(inbox.locator(".notification-item")).toHaveCount(1);
      await expect(inbox.getByText("Страница 2 из 2", { exact: true })).toBeVisible();
      await expect(inbox.getByRole("button", { name: "Следующие уведомления", exact: true })).toBeDisabled();
      await inbox.getByRole("button", { name: "Предыдущие уведомления", exact: true }).click();
      await expect(inbox.getByText("Страница 1 из 2", { exact: true })).toBeVisible();
      await inbox.getByRole("button", { name: "Следующие уведомления", exact: true }).click();
      await expect(inbox.getByText("Страница 2 из 2", { exact: true })).toBeVisible();
      await expect(group).not.toHaveAttribute("open");
      await toggle.click();
      await inbox.getByRole("button", { name: "Прочитано", exact: true }).click();
      await expect(inbox.locator(".notification-item")).toHaveCount(50);
      await expect(group).not.toHaveAttribute("open");
      await toggle.click();
      await expect(inbox.getByRole("button", { name: "Предыдущие уведомления", exact: true })).toHaveCount(0);
    }
    await inbox
      .locator(".notification-group-navigation")
      .getByRole("button", { name: "Открыть наряд", exact: true })
      .click();
    await expect(
      page.getByRole("dialog").locator(".dialog-head small").filter({ hasText: order.number }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}
