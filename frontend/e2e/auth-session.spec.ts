import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const state = JSON.parse(readFileSync(resolve("../tmp/e2e-server.json"), "utf8"));
const key = "naryadai.session.v1";
async function login(page: Page, account = state.master_login) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(account);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: account === state.executor_login ? "Мои наряды" : "Наряды участка",
      exact: true,
    }),
  ).toBeVisible();
}

test("a new tab and a fresh window restore the same unexpired account", async ({ page, context }) => {
  await login(page);
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("heading", { name: "Наряды участка", exact: true })).toBeVisible();
  await page.close();
  await second.close();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(reopened.getByRole("heading", { name: "Наряды участка", exact: true })).toBeVisible();
  await reopened.reload();
  await expect(reopened.getByRole("heading", { name: "Наряды участка", exact: true })).toBeVisible();
});

test("logout and account replacement update every tab without private UI leaking", async ({
  page,
  context,
}) => {
  await login(page);
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("heading", { name: "Наряды участка", exact: true })).toBeVisible();
  await second.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  await expect(second.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(second.getByRole("heading", { name: "Вход в смену", exact: true })).toBeVisible();
  await expect(second.getByRole("dialog")).toHaveCount(0);
  await login(page, state.executor_login);
  await expect(second.getByRole("heading", { name: "Мои наряды", exact: true })).toBeVisible();
  await expect(second.getByRole("button", { name: "Выдать наряд", exact: true })).toHaveCount(0);
});

test("a legacy session migrates once and is available in a new tab", async ({ page, context }) => {
  await login(page);
  await page.evaluate((key) => {
    const session = JSON.parse(localStorage.getItem(key)!);
    sessionStorage.setItem("naryadai.session.token", session.token);
    sessionStorage.setItem("naryadai.session.expires", session.expiresAt);
    sessionStorage.setItem("naryadai.session.user", JSON.stringify(session.user));
    localStorage.removeItem(key);
  }, key);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Наряды участка", exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("naryadai.session.token"))).toBeNull();
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("heading", { name: "Наряды участка", exact: true })).toBeVisible();
});

test("expiry still signs out every tab", async ({ page, context }) => {
  await login(page);
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("heading", { name: "Наряды участка", exact: true })).toBeVisible();
  // Simulate the absolute server expiry without weakening server validation or waiting eight hours.
  await page.evaluate((key) => {
    const session = JSON.parse(localStorage.getItem(key)!);
    session.expiresAt = new Date(Date.now() - 1).toISOString();
    localStorage.setItem(key, JSON.stringify(session));
  }, key);
  await expect(second.getByRole("heading", { name: "Вход в смену", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Вход в смену", exact: true })).toBeVisible();
});
