// Record an actual workflow against the isolated E2E server, never the public DB.
const { chromium, expect } = require('../frontend/node_modules/@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const state = JSON.parse(fs.readFileSync(path.join(root, 'tmp/demo-server.json'), 'utf8'));
const base = 'http://127.0.0.1:5178';
if (state.base_url !== 'http://127.0.0.1:58002') throw new Error('Only the isolated test server is supported');
const evidence = path.join(root, 'tmp/review/demo-recording');
fs.mkdirSync(evidence, { recursive: true });
require('node:child_process').execFileSync(path.join(root, '.venv/bin/python'), ['-c',
  "from pathlib import Path; from scripts.eval_ai import _image; p=Path('tmp/review/demo-recording'); (p/'before.jpg').write_bytes(_image('conveyor no guard',False,marker='BEFORE')); (p/'after.jpg').write_bytes(_image('conveyor guard fitted',True,marker='AFTER'))"
], { cwd: root });

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }, locale: 'ru-RU', timezoneId: 'Asia/Almaty',
    reducedMotion: 'reduce', recordVideo: { dir: evidence, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let scene = 0;
  let completed = false;
  const target = path.join(root, 'docs/submission/technaryad-demo.webm');
  async function caption(title, detail, seconds = 6) {
    await page.evaluate(({ title, detail }) => {
      let overlay = document.getElementById('demo-caption');
      if (!overlay) {
        overlay = document.createElement('aside'); overlay.id = 'demo-caption';
        overlay.style.cssText = 'position:fixed;bottom:12px;left:20px;right:20px;z-index:2147483647;padding:12px 20px;background:#132b29f5;color:#fff;border:1px solid #6b9c8e;border-radius:12px;box-shadow:0 8px 30px #0003;font:18px/1.4 system-ui;pointer-events:none';
        document.body.append(overlay);
      }
      const surface = document.querySelector('dialog[open]') || document.body;
      if (overlay.parentElement !== surface) surface.append(overlay);
      overlay.replaceChildren();
      const heading = document.createElement('strong'); heading.textContent = title;
      const text = document.createElement('div'); text.textContent = detail;
      text.style.cssText = 'font-size:13px;color:#cae2d8;margin-top:3px';
      overlay.append(heading, text);
    }, { title, detail });
    await page.screenshot({ path: path.join(evidence, `scene-${++scene}.png`) });
    await page.waitForTimeout(seconds * 1000);
  }
  async function login(account, route = '/') {
    await page.goto(base);
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await page.getByLabel('Логин', { exact: true }).fill(account);
    await page.getByLabel('Пароль', { exact: true }).fill(state.secret);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.getByRole('button', { name: /Выйти/ })).toBeVisible();
    if (route !== '/') await page.goto(base + route);
  }
  try {
    await login(state.master_login);
    await caption('ТехНаряд: от задания до принятого ремонта', 'Реальный интерфейс · изолированная тестовая база · автоматизированная запись', 7);
    await page.getByRole('button', { name: 'Выдать наряд', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: 'Участок', exact: true }).selectOption(state.area_id);
    await dialog.getByRole('combobox', { name: 'Оборудование', exact: true }).selectOption(state.equipment_id);
    await dialog.getByRole('combobox', { name: 'Исполнитель', exact: true }).selectOption(state.selected_executor_id);
    await dialog.getByLabel('Описание', { exact: true }).fill('Проверить и восстановить ограждение привода. Перед работой согласовать остановку.');
    await dialog.getByLabel('Комментарий для исполнителя', { exact: true }).fill('После восстановления проверить крепления и передать результат мастеру.');
    await dialog.getByRole('combobox', { name: 'Приоритет', exact: true }).selectOption('emergency');
    await caption('01 · Мастер выдаёт аварийный наряд', 'Участок, оборудование, исполнитель, срок и понятное задание связаны в одной карточке.', 7);
    const created = page.waitForResponse(r => r.url().endsWith('/api/v1/work-orders') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Выдать наряд', exact: true }).click();
    const response = await created;
    if (response.status() !== 201) throw new Error('Demo order creation failed');
    const id = (await response.json()).order_id;
    await page.goto(`${base}/orders/${id}`);
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Фотография', { exact: true }).setInputFiles(path.join(evidence, 'before.jpg'));
    await expect(dialog.locator('img')).toHaveCount(1);
    await caption('Фото «до» привязано к наряду', 'В записи используются синтетические схемы, а не фотографии промышленного ремонта.', 5);

    await login(state.executor_login, '/orders/' + id);
    dialog = page.getByRole('dialog');
    await caption('02 · Исполнитель получает задание', 'Видит описание, мастера, срок и фотографию. Чужие наряды ему недоступны.', 6);
    await dialog.getByRole('button', { name: 'Принять', exact: true }).click();
    await dialog.getByRole('button', { name: 'Начать работу', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Работа начата', exact: true })).toBeInViewport();
    await caption('Работа начата — следующий шаг показан сразу', 'Отдельно учитываются активная работа и паузы. После ремонта исполнитель заполняет отчёт.', 6);
    await dialog.getByRole('button', { name: 'Заполнить отчёт', exact: true }).click();
    await dialog.getByLabel('Фото после', { exact: false }).setInputFiles(path.join(evidence, 'after.jpg'));
    await expect(dialog.locator('img')).toHaveCount(2);
    await dialog.getByRole('textbox', { name: 'Что выполнено', exact: true }).fill('Ограждение привода восстановлено, существующие крепления подтянуты. Целостность и крепление проверены, результат передан мастеру.');
    const fault = dialog.getByRole('combobox', { name: 'Шифр неисправности', exact: true });
    const faultId = await fault.locator('option').evaluateAll(options => options.find(option => option.textContent.includes('GEN-005'))?.value);
    if (!faultId) throw new Error('Demo guard fault code not found');
    await fault.selectOption(faultId);
    await dialog.getByLabel('Материалы не использовались', { exact: true }).check();
    await dialog.getByLabel('Причина отсутствия материалов', { exact: true }).fill('Восстановлено штатное ограждение; использованы существующие крепления без списания новых материалов.');
    await dialog.getByRole('textbox', { name: 'Что выполнено', exact: true }).scrollIntoViewIfNeeded();
    await caption('03 · Сдача с описанием результата и фото «после»', 'Шифр неисправности, материалы либо обоснованное отсутствие расхода остаются в истории.', 7);
    await dialog.getByRole('button', { name: 'Сдать наряд', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Сдать наряд', exact: true })).toHaveCount(0);
    await caption('Отчёт передан на проверку', 'В этой записи внешний ИИ отключён. Локальные проверки не выдают себя за ответ модели.', 7);

    await login(state.master_login, '/orders/' + id);
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Закрыть вручную', exact: true })).toBeVisible();
    await dialog.getByLabel('Причина решения', { exact: true }).scrollIntoViewIfNeeded();
    await caption('04 · Решение остаётся за мастером', 'При недоступности ИИ требуется ручная проверка и причина решения; автоматической приёмки нет.', 7);
    await dialog.getByLabel('Причина решения', { exact: true }).fill('Учебный пример: результат и приложенные схемы проверены. Ограничения автоматической проверки учтены.');
    await dialog.getByLabel('Оценка мастера (необязательно)', { exact: true }).fill('4');
    await dialog.getByRole('button', { name: 'Закрыть вручную', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: /· Закрыт$/ })).toBeVisible();
    await caption('Наряд закрыт с объяснением и оценкой', 'Статусы, исполнители решений, фото и попытки сдачи сохранены в аудите.', 5);

    await login(state.executor_login, '/orders/' + id);
    const feedback = page.getByRole('region', { name: 'Результат вашей сдачи', exact: true });
    await feedback.locator('.ai-review-heading').scrollIntoViewIfNeeded();
    await expect(feedback.getByText('Оценка мастера: 4/5', { exact: true })).toBeVisible();
    await caption('05 · Исполнитель получает обратную связь', 'Видит оценку, рекомендации и время относительно норматива. Предыдущие попытки сохранены.', 8);

    await login(state.manager_login, '/analytics');
    await page.locator('.analytics-filters select').first().selectOption('month');
    await page.getByRole('button', { name: 'Применить', exact: true }).click();
    await page.waitForTimeout(700);
    await caption('06 · Руководитель видит картину по периоду', 'Выданные и закрытые наряды, просрочки, простой, рейтинги и расход. История синтетическая.', 8);
    await login(state.admin_login, '/reference');
    await expect(page.getByRole('heading', { name: 'Справочные данные', exact: true })).toBeVisible();
    await caption('07 · Справочники управляются через семь разделов', 'Участки, техника, люди, бригады, материалы, неисправности и нормы. История защищена от удаления.', 8);
    if (errors.length) throw new Error('Browser errors during recording');
    completed = true;
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ status: 'PASS', orderId: id, scenes: scene, browserErrors: errors, externalAI: false, syntheticImages: true }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
    throw error;
  } finally {
    await context.close();
    if (completed) await page.video().saveAs(target);
    await browser.close();
  }
  console.log(JSON.stringify({ video: target, scenes: scene, externalAI: false }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
