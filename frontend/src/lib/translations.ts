import { uiTranslations } from "./translationsUi";

/** Interface copy only. User-entered and server-authored content is never translated here. */
const baseTranslations: Record<string, { kk: string; en: string }> = {
  "Страница {0} из {1}": { kk: "{1} беттің {0}-і", en: "Page {0} of {1}" },
  "Нажмите на карточку, чтобы посмотреть связанные события.": {
    kk: "Байланысты оқиғаларды көру үшін карточканы басыңыз.",
    en: "Select a card to view related events.",
  },
  "Требуется подтверждение": { kk: "Растау қажет", en: "Acknowledgement required" },
  "ОБЗОР СМЕНЫ": { kk: "АУЫСЫМҒА ШОЛУ", en: "SHIFT OVERVIEW" },
  "Обновить сводку": { kk: "Шолуды жаңарту", en: "Refresh summary" },
  "Собираем выводы по показателям отчёта…": {
    kk: "Есеп көрсеткіштері бойынша қорытынды дайындаудамыз…",
    en: "Preparing insights from report metrics\u2026",
  },
  "Результат сводки": { kk: "Шолу нәтижесі", en: "Summary result" },
  "ИИ-анализ": { kk: "ЖИ талдауы", en: "AI analysis" },
  "Обзор по данным": { kk: "Деректерге шолу", en: "Data overview" },
  "На основе показателей отчёта": { kk: "Есеп көрсеткіштері негізінде", en: "Based on report metrics" },
  "Главное за период": { kk: "Кезеңнің негізгі нәтижелері", en: "Period highlights" },
  "Рекомендуемые действия": { kk: "Ұсынылатын әрекеттер", en: "Recommended actions" },
  "О данных и ограничениях сводки": {
    kk: "Шолу деректері мен шектеулері туралы",
    en: "Summary data and limitations",
  },
  "Наряд {0}": { kk: "Наряд {0}", en: "Work order {0}" },
  "Системные уведомления": { kk: "Жүйелік хабарландырулар", en: "System notifications" },
  "События по наряду": { kk: "Наряд оқиғалары", en: "Work order events" },
  "Сообщения об оборудовании": { kk: "Жабдық туралы хабарламалар", en: "Equipment messages" },
  "Служебные сообщения": { kk: "Қызметтік хабарламалар", en: "Service messages" },
  "Служебное уведомление": { kk: "Қызметтік хабарландыру", en: "Service notification" },
  "Откройте приложение, чтобы посмотреть детали.": {
    kk: "Мәліметтерді көру үшін қолданбаны ашыңыз.",
    en: "Open the app to view details.",
  },
  "На этой странице: {0} из {1} уведомлений.": {
    kk: "Бұл бетте: {1} хабарландырудың {0}-і.",
    en: "On this page: {0} of {1} notifications.",
  },
  "Событий: {0} · непрочитано: {1}": {
    kk: "Оқиғалар: {0} · оқылмаған: {1}",
    en: "Events: {0} · unread: {1}",
  },
  Срочно: { kk: "Шұғыл", en: "Urgent" },
  Новое: { kk: "Жаңа", en: "New" },
  "Навигация по уведомлениям": { kk: "Хабарландырулар бойынша навигация", en: "Notification navigation" },
  "Приложение и язык": { kk: "Қолданба және тіл", en: "App and language" },
  Язык: { kk: "Тіл", en: "Language" },
  "Приложение на устройстве": { kk: "Құрылғыдағы қолданба", en: "App on this device" },
  "Приложение установлено на этом устройстве.": {
    kk: "Қолданба осы құрылғыға орнатылған.",
    en: "The app is installed on this device.",
  },
  "Приложение установлено": { kk: "Қолданба орнатылған", en: "App installed" },
  "Как установить": { kk: "Қалай орнату керек", en: "How to install" },
  "В браузере откройте меню и выберите «Установить приложение».": {
    kk: "Браузер мәзірінен «Қолданбаны орнату» таңдаңыз.",
    en: "In the browser menu, choose “Install app”.",
  },
  "Открывайте приложение с ярлыка.": {
    kk: "Қолданбаны белгішеден ашыңыз.",
    en: "Open the app from its icon.",
  },
  "iPhone/iPad: в Safari выберите «Поделиться» → «На экран Домой».": {
    kk: "iPhone/iPad: Safari-де «Бөлісу» → «Басты экранға» таңдаңыз.",
    en: "iPhone/iPad: in Safari choose “Share” → “Add to Home Screen”.",
  },
  "Установите для быстрого запуска и уведомлений после отдельного разрешения.": {
    kk: "Жылдам ашу және бөлек рұқсаттан кейінгі хабарландырулар үшін орнатыңыз.",
    en: "Install for quick launch and notifications after separate permission.",
  },
  "На компьютере и телефоне — отдельным приложением. Уведомления включаются отдельно.": {
    kk: "Компьютерде де, телефонда да — бөлек қолданба ретінде. Хабарландырулар бөлек қосылады.",
    en: "Use it as a standalone app on computers and phones. Notifications are enabled separately.",
  },
  "На компьютере и телефоне — отдельным приложением. Уведомления включаются отдельно. В браузере откройте меню и выберите «Установить приложение».":
    {
      kk: "Компьютерде де, телефонда да — бөлек қолданба ретінде. Хабарландырулар бөлек қосылады. Браузер мәзірінен «Қолданбаны орнату» таңдаңыз.",
      en: "Use it as a standalone app on computers and phones. Notifications are enabled separately. In the browser menu, choose “Install app”.",
    },
  "Не удалось открыть установку. Попробуйте ещё раз.": {
    kk: "Орнатуды ашу мүмкін болмады. Қайталап көріңіз.",
    en: "Could not open installation. Try again.",
  },
  "· текущий наряд:": { kk: "· ағымдағы наряд:", en: "· current work order:" },
  "текущий наряд:": { kk: "ағымдағы наряд:", en: "current work order:" },
  "Выберите оборудование, опишите работу и назначьте исполнителя со сроком.": {
    kk: "Жабдықты таңдаңыз, жұмысты сипаттаңыз және орындаушы мен мерзімді белгілеңіз.",
    en: "Choose equipment, describe the work, then assign a technician and deadline.",
  },
  "Участок определится по оборудованию.": {
    kk: "Учаске жабдық бойынша анықталады.",
    en: "The area is set from the equipment.",
  },
  "Найти оборудование": { kk: "Жабдықты табу", en: "Find equipment" },
  "Участок не указан": { kk: "Учаске көрсетілмеген", en: "Area not set" },
  "Оборудование не найдено.": { kk: "Жабдық табылмады.", en: "No equipment found." },
  "Оборудование недоступно": { kk: "Жабдық қолжетімсіз", en: "Equipment unavailable" },
  "Участок недоступен": { kk: "Учаске қолжетімсіз", en: "Area unavailable" },
  Активно: { kk: "Белсенді", en: "Active" },
  "В архиве или участок отключён": {
    kk: "Мұрағатта немесе учаске өшірілген",
    en: "Archived or area disabled",
  },
  "Наряды оборудования": { kk: "Жабдық нарядтары", en: "Equipment work orders" },
  "QR-КАРТОЧКА": { kk: "QR-КАРТОЧКА", en: "QR CARD" },
  "QR-КАРТОЧКА ОБОРУДОВАНИЯ": { kk: "ЖАБДЫҚТЫҢ QR-КАРТОЧКАСЫ", en: "EQUIPMENT QR CARD" },
  "QR-код": { kk: "QR-код", en: "QR code" },
  "QR-код оборудования": { kk: "Жабдықтың QR-коды", en: "Equipment QR code" },
  "Проверьте QR-код или доступ к участку. Карточка доступна только для оборудования вашего контура.": {
    kk: "QR-кодты немесе учаскеге қолжетімділікті тексеріңіз. Карточка тек сіздің контурыңыздағы жабдыққа қолжетімді.",
    en: "Check the QR code or area access. This card is available only for equipment in your assigned scope.",
  },
  "Откройте эту карточку камерой телефона.": {
    kk: "Осы карточканы телефон камерасымен ашыңыз.",
    en: "Open this card with your phone camera.",
  },
  "Копировать ссылку": { kk: "Сілтемені көшіру", en: "Copy link" },
  "Скачать QR-код": { kk: "QR-кодты жүктеу", en: "Download QR code" },
  "Печать наклейки": { kk: "Жапсырманы басып шығару", en: "Print label" },
  "Ссылка скопирована.": { kk: "Сілтеме көшірілді.", en: "Link copied." },
  "Не удалось скопировать ссылку. Скопируйте её из строки выше.": {
    kk: "Сілтемені көшіру мүмкін болмады. Оны жоғарыдағы жолдан көшіріңіз.",
    en: "Could not copy the link. Copy it from the address above.",
  },
  "Телефон не откроет localhost. Для проверки используйте адрес туннеля.": {
    kk: "Телефон localhost-ты ашпайды. Тексеру үшін туннель мекенжайын пайдаланыңыз.",
    en: "A phone cannot open localhost. Use a tunnel address for testing.",
  },
  "Это временный адрес туннеля. После его перезапуска напечатайте новый QR-код.": {
    kk: "Бұл туннельдің уақытша мекенжайы. Қайта іске қосқаннан кейін жаңа QR-кодты басып шығарыңыз.",
    en: "This tunnel address is temporary. Print a new QR code after it restarts.",
  },
  "Подбор запускается после описания и не назначает исполнителя сам.": {
    kk: "Іріктеу сипаттамадан кейін басталады және орындаушыны өзі тағайындамайды.",
    en: "Suggestions start after the description and never assign a technician automatically.",
  },
  "Сначала выберите оборудование и опишите работу.": {
    kk: "Алдымен жабдықты таңдап, жұмысты сипаттаңыз.",
    en: "First choose equipment and describe the work.",
  },
  Выбрано: { kk: "Таңдалды", en: "Selected" },
  Выбрать: { kk: "Таңдау", en: "Select" },
  "Профилактический наряд": { kk: "Алдын алу наряды", en: "Preventive work order" },
  "Подготовить наряд": { kk: "Нарядты дайындау", en: "Prepare work order" },
  "Подготавливаем…": { kk: "Дайындалуда…", en: "Preparing…" },
  "Не удалось подготовить профилактический наряд. Обновите отчёт и повторите.": {
    kk: "Алдын алу нарядын дайындау мүмкін болмады. Есепті жаңартып, қайталап көріңіз.",
    en: "Could not prepare the preventive work order. Refresh the report and try again.",
  },
  "Проверьте описание, назначьте исполнителя и срок.": {
    kk: "Сипаттаманы тексеріп, орындаушы мен мерзімді белгілеңіз.",
    en: "Review the description, then choose the technician and deadline.",
  },
  "Основание изменилось. Закройте форму, обновите отчёт и подготовьте наряд заново.": {
    kk: "Негіз өзгерді. Пішінді жауып, есепті жаңартып, нарядты қайта дайындаңыз.",
    en: "The evidence changed. Close the form, refresh the report, and prepare the work order again.",
  },
  "Связанные наряды ({0})": { kk: "Байланысты нарядтар ({0})", en: "Related work orders ({0})" },
  "Не удалось открыть связанный наряд.": {
    kk: "Байланысты нарядты ашу мүмкін болмады.",
    en: "Could not open the related work order.",
  },
  "Похожие ремонты": { kk: "Ұқсас жөндеулер", en: "Similar repairs" },
  "Выберите оборудование и заполните описание.": {
    kk: "Жабдықты таңдап, сипаттаманы толтырыңыз.",
    en: "Select equipment and enter a description.",
  },
  "Ищем похожие ремонты…": { kk: "Ұқсас жөндеулер ізделуде…", en: "Finding similar repairs…" },
  "Не удалось загрузить похожие ремонты.": {
    kk: "Ұқсас жөндеулерді жүктеу мүмкін болмады.",
    en: "Could not load similar repairs.",
  },
  "Подходящих закрытых ремонтов не найдено.": {
    kk: "Сәйкес жабылған жөндеулер табылмады.",
    en: "No matching closed repairs found.",
  },
  "То же оборудование": { kk: "Сол жабдық", en: "Same equipment" },
  "Совместимый тип оборудования": { kk: "Үйлесімді жабдық түрі", en: "Compatible equipment type" },
  "Тот же шифр неисправности": { kk: "Сол ақау коды", en: "Same fault code" },
  "Совпадение по описанию": { kk: "Сипаттама бойынша сәйкестік", en: "Description match" },
  "Повтор за {0} дн.: {1}": { kk: "{0} күнде қайталау: {1}", en: "Repeat within {0} days: {1}" },
  "За {0} дн. повторов не зафиксировано": {
    kk: "{0} күнде қайталау тіркелмеген",
    en: "No repeat recorded within {0} days",
  },
  "Наблюдение: {0} из {1} дн.": { kk: "Бақылау: {1} күннің {0}", en: "Observing: {0} of {1} days" },
  "Повтор не оценён": { kk: "Қайталау бағаланбады", en: "Repeat not assessed" },
  "Принят и закрыт мастером": { kk: "Шебер қабылдап, жабды", en: "Accepted and closed by supervisor" },
  "Описание обращения": { kk: "Өтініш сипаттамасы", en: "Issue description" },
  "Показаны не все найденные ремонты.": {
    kk: "Табылған жөндеулердің барлығы көрсетілмеген.",
    en: "Not all matching repairs are shown.",
  },
  "История ограничена: показаны результаты по доступной части выборки.": {
    kk: "Тарих шектелген: қолжетімді деректер бөлігінің нәтижелері көрсетілді.",
    en: "History is limited: results use the available portion of the data.",
  },
  "Контроль профилактики": { kk: "Алдын алуды бақылау", en: "Preventive follow-up" },
  "Ожидает выполнения": { kk: "Орындалуы күтілуде", en: "Awaiting completion" },
  "Наблюдение продолжается": { kk: "Бақылау жалғасуда", en: "Observation continues" },
  "Повтор зарегистрирован": { kk: "Қайталану тіркелді", en: "Repeat recorded" },
  "Внеплановый ремонт зарегистрирован": {
    kk: "Жоспардан тыс жөндеу тіркелді",
    en: "Unplanned repair recorded",
  },
  "7 дней без зарегистрированного повтора": {
    kk: "7 күн тіркелген қайталанусыз",
    en: "7 days without a recorded repeat",
  },
  "7 дней без внеплановых ремонтов": {
    kk: "7 күн жоспардан тыс жөндеусіз",
    en: "7 days without unplanned repairs",
  },
  "Период отбирает профилактические наряды по дате выдачи. Наблюдение повторов начинается после закрытия.": {
    kk: "Кезең алдын алу нарядтарын берілген күні бойынша алады. Қайталарды бақылау жабылғаннан кейін басталады.",
    en: "The period selects preventive work orders by issue date. Repeat observation begins after closure.",
  },
  "Наблюдение фиксирует записи журнала и не доказывает эффективность профилактики.": {
    kk: "Бақылау журнал жазбаларын бекітеді, бірақ алдын алудың тиімділігін дәлелдемейді.",
    en: "Observation records journal entries; it does not prove preventive effectiveness.",
  },
  "Сначала сформируйте отчёт с нужными фильтрами.": {
    kk: "Алдымен қажетті сүзгілермен есепті қалыптастырыңыз.",
    en: "Generate a report with the required filters first.",
  },
  "Загружаем контроль профилактики…": {
    kk: "Алдын алуды бақылау жүктелуде…",
    en: "Loading preventive follow-up…",
  },
  "Не удалось загрузить контроль профилактики.": {
    kk: "Алдын алуды бақылауды жүктеу мүмкін болмады.",
    en: "Could not load preventive follow-up.",
  },
  "Профилактических нарядов за выбранный период нет.": {
    kk: "Таңдалған кезеңде алдын алу нарядтары жоқ.",
    en: "There are no preventive work orders in the selected period.",
  },
  "Страницы контроля профилактики": { kk: "Алдын алуды бақылау беттері", en: "Preventive follow-up pages" },
  Вперёд: { kk: "Алға", en: "Next" },
  "Показаны не все найденные результаты.": {
    kk: "Барлық табылған нәтижелер көрсетілмеген.",
    en: "Not all matching results are shown.",
  },
  "Повтор той же неисправности": { kk: "Сол ақаудың қайталануы", en: "Repeat of the same fault" },
  "Внеплановый ремонт после профилактики": {
    kk: "Алдын алудан кейінгі жоспардан тыс жөндеу",
    en: "Unplanned repair after prevention",
  },
  "Дней наблюдения: {0} из {1}": { kk: "Бақылау күндері: {0} / {1}", en: "Days observed: {0} of {1}" },
  "Повторов в журнале: {0}": { kk: "Журналдағы қайталар: {0}", en: "Repeats in the journal: {0}" },
  "Внеплановых ремонтов в журнале: {0}": {
    kk: "Журналдағы жоспардан тыс жөндеулер: {0}",
    en: "Unplanned repairs in the journal: {0}",
  },
  "Показаны не все связанные наряды.": {
    kk: "Барлық байланысты нарядтар көрсетілмеген.",
    en: "Not all related work orders are shown.",
  },
  "Связанные повторы:": { kk: "Байланысты қайталар:", en: "Related repeats:" },
  "Связанные внеплановые ремонты:": {
    kk: "Байланысты жоспардан тыс жөндеулер:",
    en: "Related unplanned repairs:",
  },
  "Основание и методика": { kk: "Негіз және әдістеме", en: "Basis and method" },
  "Сравнение:": { kk: "Салыстыру:", en: "Comparison:" },
  "Исходные наряды:": { kk: "Бастапқы нарядтар:", en: "Source work orders:" },
  "Не закрыт": { kk: "Жабылмаған", en: "Not closed" },
  "До:": { kk: "Дейін:", en: "Until:" },
  "Проверено по состоянию на:": { kk: "Күйі бойынша тексерілді:", en: "Checked as of:" },
  "Основание недоступно.": { kk: "Негіз қолжетімсіз.", en: "Basis is unavailable." },
  "Нет подтверждённой даты": { kk: "Расталған күні жоқ", en: "No confirmed date" },
  "Импорт Excel": { kk: "Excel импорты", en: "Excel import" },
  "Скачать шаблон": { kk: "Үлгіні жүктеу", en: "Download template" },
  "Один файл: листы «Оборудование» и «Материалы». Лист участков — только для справки.": {
    kk: "Бір файл: «Жабдық» және «Материалдар» парақтары. Учаскелер парағы — тек анықтама үшін.",
    en: "One file: Equipment and Materials sheets. The Areas sheet is reference-only.",
  },
  "Выберите файл .xlsx": { kk: ".xlsx файлын таңдаңыз", en: "Choose an .xlsx file" },
  "Файл Excel": { kk: "Excel файлы", en: "Excel file" },
  "Код участка": { kk: "Учаске коды", en: "Area code" },
  "Ед. изм.": { kk: "Өлшем бірл.", en: "Unit" },
  "Не более 500 строк и 2 МБ. Импорт только добавляет новые записи.": {
    kk: "500 жолдан және 2 МБ-тан аспайды. Импорт тек жаңа жазбаларды қосады.",
    en: "Up to 500 rows and 2 MB. Import only adds new records.",
  },
  "Проверить файл": { kk: "Файлды тексеру", en: "Validate file" },
  "Проверка не меняет справочник. Записи будут добавлены только после подтверждения.": {
    kk: "Тексеру анықтамалықты өзгертпейді. Жазбалар тек растағаннан кейін қосылады.",
    en: "Validation does not change the catalog. Records are added only after confirmation.",
  },
  "Выберите файл Excel в формате .xlsx.": {
    kk: ".xlsx пішіміндегі Excel файлын таңдаңыз.",
    en: "Choose an Excel file in .xlsx format.",
  },
  "Файл больше 2 МБ. Выберите другой файл.": {
    kk: "Файл 2 МБ-тан артық. Басқа файлды таңдаңыз.",
    en: "The file is larger than 2 MB. Choose another file.",
  },
  "Не удалось прочитать файл.": { kk: "Файлды оқу мүмкін болмады.", en: "Could not read the file." },
  "Справочник изменился. Проверьте файл заново.": {
    kk: "Анықтамалық өзгерді. Файлды қайта тексеріңіз.",
    en: "The catalog changed. Validate the file again.",
  },
  "Импорт доступен только администратору.": {
    kk: "Импорт тек әкімшіге қолжетімді.",
    en: "Import is available to administrators only.",
  },
  "Файл не прошёл проверку. Исправьте строки в шаблоне и проверьте его снова.": {
    kk: "Файл тексеруден өтпеді. Үлгідегі жолдарды түзетіп, қайта тексеріңіз.",
    en: "The file did not pass validation. Fix the rows in the template and validate it again.",
  },
  "Файл больше 2 МБ. Уменьшите его и проверьте снова.": {
    kk: "Файл 2 МБ-тан үлкен. Оны кішірейтіп, қайта тексеріңіз.",
    en: "The file is larger than 2 MB. Reduce it and validate it again.",
  },
  "Скачайте шаблон и перенесите данные в его листы.": {
    kk: "Үлгіні жүктеп, деректерді оның парақтарына көшіріңіз.",
    en: "Download the template and move the data into its sheets.",
  },
  "Файл содержит формулы или небезопасные элементы. Используйте значения из шаблона.": {
    kk: "Файлда формулалар немесе қауіпті элементтер бар. Үлгідегі мәндерді пайдаланыңыз.",
    en: "The file contains formulas or unsafe elements. Use the values from the template.",
  },
  "В файле слишком много строк. Оставьте не более 500 строк и проверьте снова.": {
    kk: "Файлда жол тым көп. 500 жолдан асырмай, қайта тексеріңіз.",
    en: "The file has too many rows. Keep no more than 500 rows and validate it again.",
  },
  Помощник: { kk: "Көмекші", en: "Assistant" },
  "Помощник мастера": { kk: "Шебер көмекшісі", en: "Supervisor assistant" },
  "Справка по данным нарядов. Решение и действия остаются за мастером.": {
    kk: "Наряд деректері бойынша анықтама. Шешім мен әрекеттер шеберде қалады.",
    en: "A reference based on work-order data. Decisions and actions remain with the supervisor.",
  },
  "Варианты вопроса": { kk: "Сұрақ нұсқалары", en: "Question options" },
  "Что требует внимания?": { kk: "Не назар аударуды қажет етеді?", en: "What needs attention?" },
  "Повторные неисправности": { kk: "Қайталанатын ақаулар", en: "Repeated faults" },
  "Как ремонтировали раньше?": { kk: "Бұрын қалай жөнделді?", en: "How was it repaired before?" },
  "Вопрос помощнику": { kk: "Көмекшіге сұрақ", en: "Question for the assistant" },
  "Например, что сейчас требует внимания?": {
    kk: "Мысалы, қазір не назар аударуды қажет етеді?",
    en: "For example, what needs attention now?",
  },
  "До 500 символов": { kk: "500 таңбаға дейін", en: "Up to 500 characters" },
  "Оборудование для ответа": { kk: "Жауапқа арналған жабдық", en: "Equipment for the answer" },
  "Всё доступное оборудование": { kk: "Барлық қолжетімді жабдық", en: "All available equipment" },
  "Для истории выберите оборудование или уточните неисправность.": {
    kk: "Тарих үшін жабдықты таңдаңыз немесе ақауды нақтылаңыз.",
    en: "For history, select equipment or clarify the fault.",
  },
  "Помощник доступен только мастеру.": {
    kk: "Көмекші тек шеберге қолжетімді.",
    en: "The assistant is available only to supervisors.",
  },
  "Помощник занят. Повторите через минуту.": {
    kk: "Көмекші бос емес. Бір минуттан кейін қайталаңыз.",
    en: "The assistant is busy. Try again in a minute.",
  },
  "Помощник работает при подключении к сети.": {
    kk: "Көмекші желіге қосылғанда жұмыс істейді.",
    en: "The assistant works when connected to the network.",
  },
  "Уточните вопрос и попробуйте снова.": {
    kk: "Сұрақты нақтылап, қайта көріңіз.",
    en: "Clarify the question and try again.",
  },
  "Не удалось получить ответ. Повторите попытку.": {
    kk: "Жауап алу мүмкін болмады. Қайталап көріңіз.",
    en: "Could not get an answer. Try again.",
  },
  "Не указан": { kk: "Көрсетілмеген", en: "Not specified" },
  "Ищем…": { kk: "Іздеудеміз…", en: "Searching…" },
  "Ищем по доступным нарядам…": {
    kk: "Қолжетімді нарядтар бойынша іздеудеміз…",
    en: "Searching available work orders…",
  },
  Спросить: { kk: "Сұрау", en: "Ask" },
  "По выбранному запросу подтверждённых нарядов не найдено.": {
    kk: "Таңдалған сұрақ бойынша расталған нарядтар табылмады.",
    en: "No confirmed work orders were found for this question.",
  },
  "Найдено нарядов": { kk: "Табылған нарядтар", en: "Work orders found" },
  "Период данных": { kk: "Деректер кезеңі", en: "Data period" },
  "Данные на": { kk: "Деректер уақыты", en: "Data as of" },
  "Показана часть подходящих нарядов.": {
    kk: "Сәйкес нарядтардың бір бөлігі көрсетілді.",
    en: "Only some matching work orders are shown.",
  },
  "Наряды-основания": { kk: "Негіз нарядтары", en: "Supporting work orders" },
  "Не удалось открыть файл. Скачайте шаблон и перенесите данные заново.": {
    kk: "Файлды ашу мүмкін болмады. Үлгіні жүктеп, деректерді қайта көшіріңіз.",
    en: "Could not open the file. Download the template and move the data again.",
  },
  "Укажите код участка.": { kk: "Учаске кодын көрсетіңіз.", en: "Enter the area code." },
  "Укажите инвентарный номер.": { kk: "Түгендеу нөмірін көрсетіңіз.", en: "Enter the inventory number." },
  "Укажите наименование.": { kk: "Атауын көрсетіңіз.", en: "Enter the name." },
  "Укажите тип оборудования.": { kk: "Жабдық түрін көрсетіңіз.", en: "Enter the equipment type." },
  "Критичность: целое число от 1 до 5.": {
    kk: "Маңыздылық: 1-ден 5-ке дейінгі бүтін сан.",
    en: "Criticality must be an integer from 1 to 5.",
  },
  "Укажите код материала.": { kk: "Материал кодын көрсетіңіз.", en: "Enter the material code." },
  "Укажите единицу измерения.": { kk: "Өлшем бірлігін көрсетіңіз.", en: "Enter the unit of measure." },
  "Дубликат инвентарного номера в файле.": {
    kk: "Файлда қайталанатын түгендеу нөмірі бар.",
    en: "The inventory number is duplicated in the file.",
  },
  "Активный участок не найден.": { kk: "Белсенді учаске табылмады.", en: "No active area was found." },
  "Инвентарный номер уже занят другими данными.": {
    kk: "Түгендеу нөмірі басқа деректермен бұрыннан қолданылған.",
    en: "The inventory number is already used with different data.",
  },
  "Дубликат кода в файле.": { kk: "Файлда қайталанатын код бар.", en: "The code is duplicated in the file." },
  "Код материала уже занят другими данными.": {
    kk: "Материал коды басқа деректермен бұрыннан қолданылған.",
    en: "The material code is already used with different data.",
  },
  "Не удалось проверить файл. Повторите попытку.": {
    kk: "Файлды тексеру мүмкін болмады. Қайта көріңіз.",
    en: "Could not validate the file. Try again.",
  },
  "Не удалось скачать шаблон.": {
    kk: "Үлгіні жүктеу мүмкін болмады.",
    en: "Could not download the template.",
  },
  "Добавить записи · {0}": { kk: "Жазбаларды қосу · {0}", en: "Add records · {0}" },
  "Добавляем…": { kk: "Қосылуда…", en: "Adding…" },
  "Добавлено: оборудование — {0}, материалы — {1}.": {
    kk: "Қосылды: жабдық — {0}, материалдар — {1}.",
    en: "Added: equipment — {0}, materials — {1}.",
  },
  "Записи добавлены, но список не обновился. Закройте окно и обновите справочник.": {
    kk: "Жазбалар қосылды, бірақ тізім жаңартылмады. Терезені жабыңыз да анықтамалықты жаңартыңыз.",
    en: "Records were added, but the list did not refresh. Close this window and refresh the catalog.",
  },
  "Результат проверки": { kk: "Тексеру нәтижесі", en: "Validation result" },
  "К добавлению: {0}": { kk: "Қосуға: {0}", en: "To add: {0}" },
  "Пропущено: {0}": { kk: "Өткізіп жіберілді: {0}", en: "Skipped: {0}" },
  "Ошибки: {0}": { kk: "Қателер: {0}", en: "Errors: {0}" },
  "Будет добавлено": { kk: "Қосылады", en: "Will be added" },
  "Пропущено как совпадение": { kk: "Сәйкес жазба ретінде өткізіп жіберілді", en: "Skipped as a match" },
  "Требует исправления": { kk: "Түзетуді қажет етеді", en: "Needs correction" },
  "Исправьте ошибки: пока они есть, импорт не выполняется.": {
    kk: "Қателерді түзетіңіз: олар бар кезде импорт орындалмайды.",
    en: "Fix the errors: import cannot run while they remain.",
  },
  "строка {0}": { kk: "{0} жол", en: "row {0}" },
  Строка: { kk: "Жол", en: "Row" },
  "Недостаточно проверяемых данных об источнике профилактики.": {
    kk: "Алдын алу көзі туралы тексерілетін дерек жеткіліксіз.",
    en: "There is insufficient verifiable data about the preventive source.",
  },
  "Недостаточно проверяемых исходных нарядов для сравнения.": {
    kk: "Салыстыру үшін тексерілетін бастапқы нарядтар жеткіліксіз.",
    en: "There are insufficient verifiable source work orders for comparison.",
  },
  "Закрытие не подтверждено событием мастера.": {
    kk: "Жабылу шебер оқиғасымен расталмаған.",
    en: "Closure is not confirmed by a supervisor event.",
  },
  "Не удалось определить исходный шифр неисправности.": {
    kk: "Бастапқы ақау кодын анықтау мүмкін болмады.",
    en: "Could not determine the original fault code.",
  },
  "Показаны первые 20 повторных нарядов; общее число указано отдельно.": {
    kk: "Алғашқы 20 қайталанған наряд көрсетілді; жалпы сан бөлек көрсетілген.",
    en: "The first 20 repeated work orders are shown; the total is shown separately.",
  },
  Наблюдение: { kk: "Бақылау", en: "Follow-up" },
  "Выполненные работы": { kk: "Орындалған жұмыстар", en: "Work performed" },
  "Параметры наряда": { kk: "Наряд параметрлері", en: "Work order settings" },
  "Выберите реальный срок: он не рассчитывается автоматически.": {
    kk: "Нақты мерзімді таңдаңыз: ол автоматты түрде есептелмейді.",
    en: "Choose a realistic deadline; it is not calculated automatically.",
  },
  "К выдаче:": { kk: "Беруге дайын:", en: "Ready to issue:" },
  "оборудование не выбрано": { kk: "жабдық таңдалмаған", en: "equipment not selected" },
  "исполнитель не выбран": { kk: "орындаушы таңдалмаған", en: "technician not selected" },
  "срок не выбран": { kk: "мерзім таңдалмаған", en: "deadline not selected" },
  "Дополнительные параметры": { kk: "Қосымша параметрлер", en: "Additional settings" },
  "Подходящие шифры": { kk: "Сәйкес ақау кодтары", en: "Matching fault codes" },
  "Заполните оборудование, описание и исполнителя.": {
    kk: "Жабдықты, сипаттаманы және орындаушыны толтырыңыз.",
    en: "Fill in equipment, description and technician.",
  },
  "Выдаём наряд…": { kk: "Наряд берілуде…", en: "Issuing work order…" },
  "Выберите участок и оборудование, затем опишите работу.": {
    kk: "Учаске мен жабдықты таңдап, жұмысты сипаттаңыз.",
    en: "Choose an area and equipment, then describe the work.",
  },
  "Подбор недоступен. Заполните поля вручную или повторите попытку.": {
    kk: "Ұсыныстар қолжетімсіз. Өрістерді қолмен толтырыңыз немесе қайталап көріңіз.",
    en: "Suggestions are unavailable. Fill in the fields manually or try again.",
  },
  "Система показывает варианты, но не выбирает исполнителя, шифр или срок вместо мастера.": {
    kk: "Жүйе нұсқаларды ұсынады. Орындаушыны, ақау кодын және мерзімді шебер таңдайды.",
    en: "Review the suggestions, then choose the worker, fault code and deadline yourself.",
  },
  "Не выбран": { kk: "Таңдалмаған", en: "Not selected" },
  "Ориентир трудоёмкости:": { kk: "Болжамды еңбек шығыны:", en: "Estimated work effort:" },
  "мин. Это не срок выполнения.": {
    kk: "мин. Бұл орындау мерзімі емес.",
    en: "min. This is not the completion deadline.",
  },
  "Для выбранного шифра и типа оборудования нормы пока нет.": {
    kk: "Таңдалған ақау коды мен жабдық түріне норматив әлі берілмеген.",
    en: "No time standard is available for this fault code and equipment type.",
  },
  "Подбор вариантов": { kk: "Ұсыныстар", en: "Suggestions" },
  "Подбор исполнителя по выбранному шифру. Чтобы найти другой шифр, очистите это поле.": {
    kk: "Орындаушы таңдалған ақау коды бойынша іріктеледі. Басқа кодты іздеу үшін осы өрісті тазалаңыз.",
    en: "Workers are matched to the selected fault code. Clear this field to search for another code.",
  },
  "Учитывает участок, оборудование, описание и текущую нагрузку.": {
    kk: "Учаске, жабдық, сипаттама және ағымдағы жүктеме ескеріледі.",
    en: "Based on the area, equipment, description and current workload.",
  },
  "Подбираем…": { kk: "Іріктеу…", en: "Finding suggestions…" },
  "Подобрать по описанию": { kk: "Сипаттама бойынша іріктеу", en: "Find suggestions" },
  "Данные изменились. Подберите варианты снова.": {
    kk: "Деректер өзгерді. Ұсыныстарды қайта сұратыңыз.",
    en: "Details have changed. Request fresh suggestions.",
  },
  "Шифры неисправности": { kk: "Ақау кодтары", en: "Fault codes" },
  "Выбрать шифр": { kk: "Кодты таңдау", en: "Choose code" },
  "· очередь:": { kk: "· кезекте:", en: "· queued:" },
  "· пауз:": { kk: "· кідірісте:", en: "· paused:" },
  "Выбрать исполнителя": { kk: "Орындаушыны таңдау", en: "Choose worker" },
  "В описании указан шифр «{0}».": {
    kk: "Сипаттамада «{0}» коды көрсетілген.",
    en: "The description includes code “{0}”.",
  },
  "Совпадение с названием неисправности: {0}.": {
    kk: "Ақау атауымен сәйкестік: {0}.",
    en: "Matches the fault name: {0}.",
  },
  "Слово «{0}» соответствует группе «{1}».": {
    kk: "«{0}» сөзі «{1}» тобына сәйкес келеді.",
    en: "The word “{0}” matches the “{1}” group.",
  },
  "Шифр неисправности выбран мастером.": {
    kk: "Ақау кодын шебер таңдады.",
    en: "The fault code was selected by the master.",
  },
  "По описанию не найден подходящий шифр: выберите его вручную при выдаче.": {
    kk: "Сипаттама бойынша сәйкес код табылмады. Наряд беру кезінде оны қолмен таңдаңыз.",
    en: "No matching code was found. Select one manually when issuing the order.",
  },
  "Подсказки по шифру не меняют специальность исполнителя без выбора мастера.": {
    kk: "Шебер кодты таңдағанға дейін ұсыныстар орындаушының мамандығын шектемейді.",
    en: "Code suggestions do not restrict the worker's specialty until the master selects a code.",
  },
  "Для выбранного шифра и типа оборудования норматив не задан.": {
    kk: "Таңдалған ақау коды мен жабдық түріне норматив берілмеген.",
    en: "No time standard is set for the selected code and equipment type.",
  },
  "Нет исполнителей на смене с требуемой специальностью на этом участке.": {
    kk: "Бұл учаскеде қажетті мамандық бойынша ауысымдағы орындаушылар жоқ.",
    en: "No workers with the required specialty are on shift in this area.",
  },
  "Для оценки учтены последние {0} закрытых работ за {1} дней.": {
    kk: "Бағалау үшін соңғы {1} күндегі {0} жабылған жұмыс ескерілді.",
    en: "The assessment uses the latest {0} closed jobs from the past {1} days.",
  },
  "Для подбора рассмотрены первые {0} исполнителей по имени.": {
    kk: "Іріктеу үшін аты бойынша алғашқы {0} орындаушы қаралды.",
    en: "Suggestions consider the first {0} workers in name order.",
  },
  "Нет активных нарядов.": { kk: "Белсенді нарядтар жоқ.", en: "No active work orders." },
  "Есть наряд в работе; детали других участков не раскрываются.": {
    kk: "Орындалып жатқан наряд бар; басқа учаскелердің мәліметтері көрсетілмейді.",
    en: "A work order is in progress; details from other areas are not shown.",
  },
  "В очереди или на паузе: {0}.": { kk: "Кезекте немесе кідірісте: {0}.", en: "Queued or paused: {0}." },
  "Специальность соответствует шифру: «{0}».": {
    kk: "Мамандық ақау кодына сәйкес келеді: «{0}».",
    en: "Specialty matches the code: “{0}”.",
  },
  "Шифр не подтверждён: подбор не ограничен специальностью.": {
    kk: "Код расталмаған: іріктеу мамандықпен шектелмейді.",
    en: "No code confirmed: suggestions are not restricted by specialty.",
  },
  "Оценённых закрытых работ на типе «{0}»: {1}; для сортировки по качеству нужно не менее {2}.": {
    kk: "«{0}» түрі бойынша бағаланған жабық жұмыстар: {1}; сапа бойынша сұрыптау үшін кемінде {2} қажет.",
    en: "Rated closed jobs for type “{0}”: {1}; at least {2} are needed to rank by quality.",
  },
  "Средняя итоговая оценка: {0}/5 по {1} закрытым работам на типе «{2}» за {3} дней.": {
    kk: "Орташа қорытынды баға: {0}/5; «{2}» түрі бойынша {3} күнде жабылған {1} жұмыс.",
    en: "Average final score: {0}/5 across {1} closed jobs for type “{2}” over {3} days.",
  },
  "При одинаковой нагрузке качество не меняло порядок: не у всех кандидатов достаточно оценённых работ.": {
    kk: "Жүктеме бірдей болғанда сапа бойынша сұрыптау қолданылмады: барлық үміткерде бағаланған жұмыстар жеткілікті емес.",
    en: "Quality did not change the order for equal workloads: some candidates have too few rated jobs.",
  },
  "Подтвердить оценку ИИ и закрыть": {
    kk: "ЖИ бағасын растап, жабу",
    en: "Confirm AI score and close",
  },
  "Действие недоступно в текущем состоянии наряда. Проверьте данные и выберите доступное действие.": {
    kk: "Нарядтың ағымдағы күйінде бұл әрекет қолжетімсіз. Деректерді тексеріп, қолжетімді әрекетті таңдаңыз.",
    en: "This action is unavailable in the work order's current state. Check the details and choose an available action.",
  },
  Принятие: {
    kk: "Қабылдау",
    en: "Acceptance",
  },
  "Постановка в очередь": {
    kk: "Кезекке қою",
    en: "Queueing",
  },
  Отказ: {
    kk: "Бас тарту",
    en: "Rejection",
  },
  "Начало работы": {
    kk: "Жұмысты бастау",
    en: "Starting work",
  },
  Пауза: {
    kk: "Үзіліс",
    en: "Pause",
  },
  Возобновление: {
    kk: "Жалғастыру",
    en: "Resuming",
  },
  "Сдача работы": {
    kk: "Жұмысты тапсыру",
    en: "Submitting work",
  },
  "Подтверждено сервером: {0}.": {
    kk: "Сервер растады: {0}.",
    en: "Confirmed by server: {0}.",
  },
  "Некоторые отложенные действия требуют ручного решения.": {
    kk: "Кейбір кейінге қалдырылған әрекеттерді қолмен шешу қажет.",
    en: "Some pending actions need manual attention.",
  },
  "Показан сохранённый снимок": {
    kk: "Сақталған көшірме көрсетілген",
    en: "Showing saved snapshot",
  },
  "Для выбранных фильтров": {
    kk: "Таңдалған сүзгілер үшін",
    en: "For the selected filters",
  },
  "Показан сохранённый снимок. Новые данные появятся после восстановления связи.": {
    kk: "Сақталған көшірме көрсетілген. Байланыс қалпына келгенде жаңа деректер пайда болады.",
    en: "Showing a saved snapshot. New data will appear when the connection is restored.",
  },
  "Для выбранных фильтров нет сохранённых нарядов. Подключитесь к сети, чтобы загрузить список.": {
    kk: "Таңдалған сүзгілер бойынша сақталған нарядтар жоқ. Тізімді жүктеу үшін желіге қосылыңыз.",
    en: "No saved work orders match these filters. Connect to load the list.",
  },
  "Не удалось получить данные. Проверьте соединение и выбранные фильтры.": {
    kk: "Деректер алынбады. Байланысты және таңдалған сүзгілерді тексеріңіз.",
    en: "Could not load data. Check your connection and filters.",
  },
  "Сервер недоступен. Войдите снова после восстановления связи.": {
    kk: "Сервер қолжетімсіз. Байланыс қалпына келгенде қайта кіріңіз.",
    en: "Server unavailable. Sign in again when the connection is restored.",
  },
  "Уведомление больше недоступно. Открыт ваш журнал.": {
    kk: "Хабарлама енді қолжетімсіз. Журналыңыз ашылды.",
    en: "This notification is no longer available. Your inbox has been opened.",
  },
  "Действие ожидает подтверждения сервером.": {
    kk: "Әрекет сервердің растауын күтуде.",
    en: "This action is awaiting server confirmation.",
  },
  "Действие сохранено на устройстве. Отправим его при восстановлении связи; статус ещё не изменён.": {
    kk: "Әрекет құрылғыда сақталды. Байланыс қалпына келгенде жіберіледі; күйі әлі өзгерген жоқ.",
    en: "Action saved on this device. It will be sent when connected; the status has not changed yet.",
  },
  "Проверяем сессию…": {
    kk: "Сеанс тексерілуде…",
    en: "Checking session…",
  },
  Т: {
    kk: "Т",
    en: "T",
  },
  Тех: {
    kk: "Тех",
    en: "Tech",
  },
  Наряд: {
    kk: "Наряд",
    en: "Naryad",
  },
  "РАБОЧИЙ КОНТУР": {
    kk: "ЖҰМЫС ОРТАСЫ",
    en: "WORKSPACE",
  },
  "Основная навигация": {
    kk: "Негізгі навигация",
    en: "Main navigation",
  },
  Мастер: {
    kk: "Шебер",
    en: "Supervisor",
  },
  Исполнитель: {
    kk: "Орындаушы",
    en: "Technician",
  },
  Руководитель: {
    kk: "Басшы",
    en: "Manager",
  },
  Администратор: {
    kk: "Әкімші",
    en: "Administrator",
  },
  Выйти: {
    kk: "Шығу",
    en: "Sign out",
  },
  ТехНаряд: {
    kk: "ТехНаряд",
    en: "TechNaryad",
  },
  смена: {
    kk: "ауысым",
    en: "shift",
  },
  контур: {
    kk: "жұмыс ортасы",
    en: "workspace",
  },
  "Выйти из учётной записи": {
    kk: "Есептік жазбадан шығу",
    en: "Sign out of your account",
  },
  "Навигация страницы": {
    kk: "Бет навигациясы",
    en: "Page navigation",
  },
  "← Назад": {
    kk: "← Артқа",
    en: "← Back",
  },
  Профиль: { kk: "Профиль", en: "Profile" },
  "Профиль: {0}": { kk: "Профиль: {0}", en: "Profile: {0}" },
  "Свернуть меню": { kk: "Мәзірді жию", en: "Collapse menu" },
  "Развернуть меню": { kk: "Мәзірді жаю", en: "Expand menu" },
  "Переподключение…": {
    kk: "Қайта қосылуда…",
    en: "Reconnecting…",
  },
  "Подключение…": {
    kk: "Қосылуда…",
    en: "Connecting…",
  },
  "Нет соединения": {
    kk: "Байланыс жоқ",
    en: "Disconnected",
  },
  " · сохранено {0}": {
    kk: " · сақталған: {0}",
    en: " · saved {0}",
  },
  "Закрыть сообщение": {
    kk: "Хабарламаны жабу",
    en: "Dismiss message",
  },
  "Ожидают отправки:": {
    kk: "Жіберуді күтуде:",
    en: "Pending upload:",
  },
  "Действия сохранены на устройстве и ожидают отправки.": {
    kk: "Әрекеттер құрылғыда сақталған және жіберуді күтуде.",
    en: "Actions are saved on this device and waiting to be sent.",
  },
  Действие: {
    kk: "Әрекет",
    en: "Action",
  },
  наряд: {
    kk: "наряд",
    en: "work order",
  },
  "Ожидает подтверждения": {
    kk: "Растауды күтуде",
    en: "Awaiting confirmation",
  },
  Повторить: {
    kk: "Қайталау",
    en: "Retry",
  },
  Удалить: {
    kk: "Жою",
    en: "Delete",
  },
  "Загрузка данных сотрудников…": {
    kk: "Қызметкерлер деректері жүктелуде…",
    en: "Loading employee data…",
  },
  "Мобильная навигация": {
    kk: "Мобильді навигация",
    en: "Mobile navigation",
  },
  Закрыть: {
    kk: "Жабу",
    en: "Close",
  },
  "Оценка мастера — целое число от 1 до 5.": {
    kk: "Шебер бағасы 1 мен 5 аралығындағы бүтін сан болуы керек.",
    en: "The supervisor's score must be an integer from 1 to 5.",
  },
  "Укажите оценку мастера от 1 до 5.": {
    kk: "Шебер бағасын 1 мен 5 аралығында көрсетіңіз.",
    en: "Enter a supervisor score from 1 to 5.",
  },
  "Для оценки мастера укажите обоснование не короче 3 символов.": {
    kk: "Шебер бағасын кемінде 3 таңбамен негіздеңіз.",
    en: "Explain the supervisor's score using at least 3 characters.",
  },
  "Укажите обоснование решения не короче 3 символов.": {
    kk: "Шешім негіздемесі кемінде 3 таңбадан тұруы керек.",
    en: "Explain the decision using at least 3 characters.",
  },
  Принято: {
    kk: "Қабылданды",
    en: "Accepted",
  },
  "Принято с замечаниями": {
    kk: "Ескертулермен қабылданды",
    en: "Accepted with comments",
  },
  "Нужна доработка": {
    kk: "Қайта өңдеу қажет",
    en: "Rework required",
  },
  "Проверка ИИ": {
    kk: "ЖИ тексеруі",
    en: "AI review",
  },
  "Базовая проверка": {
    kk: "Базалық тексеру",
    en: "Basic checks",
  },
  "Автоматическая проверка недоступна": {
    kk: "Автоматты тексеру қолжетімсіз",
    en: "Automated review unavailable",
  },
  Пройдено: {
    kk: "Өтті",
    en: "Passed",
  },
  Внимание: {
    kk: "Назар аударыңыз",
    en: "Attention",
  },
  "Не пройдено": {
    kk: "Өтпеді",
    en: "Failed",
  },
  "Нет данных": {
    kk: "Деректер жоқ",
    en: "No data",
  },
  "Проверка поставлена в очередь": {
    kk: "Тексеру кезекке қойылды",
    en: "Review queued",
  },
  "Проверка выполняется": {
    kk: "Тексерілуде",
    en: "Review in progress",
  },
  "Проверка будет повторена": {
    kk: "Тексеру қайталанады",
    en: "Review will be retried",
  },
  "Проверка завершена": {
    kk: "Тексеру аяқталды",
    en: "Review completed",
  },
  "Результат проверки устарел": {
    kk: "Тексеру нәтижесі ескірген",
    en: "Review result is outdated",
  },
  "{0} ч {1} мин": {
    kk: "{0} сағ {1} мин",
    en: "{0} h {1} min",
  },
  "{0} мин": {
    kk: "{0} мин",
    en: "{0} min",
  },
  "Сравнение с нормой пока недоступно.": {
    kk: "Нормамен салыстыру әзірге қолжетімсіз.",
    en: "Comparison with the standard is not yet available.",
  },
  "Точно по норме · {0}% нормы.": {
    kk: "Нормаға сәйкес · норманың {0}%.",
    en: "Exactly on standard · {0}% of standard.",
  },
  "Дольше нормы на {0} · {1}% нормы.": {
    kk: "Нормадан {0} ұзақ · норманың {1}%.",
    en: "{0} over standard · {1}% of standard.",
  },
  "Быстрее нормы на {0} · {1}% нормы.": {
    kk: "Нормадан {0} жылдам · норманың {1}%.",
    en: "{0} under standard · {1}% of standard.",
  },
  "Предварительный вывод не сформирован": {
    kk: "Алдын ала қорытынды жасалмаған",
    en: "No preliminary assessment",
  },
  "ИИ не дал рекомендации": {
    kk: "ЖИ ұсыным бермеді",
    en: "AI did not provide a recommendation",
  },
  "ИИ рекомендует принять работу": {
    kk: "ЖИ жұмысты қабылдауды ұсынады",
    en: "AI recommends accepting the work",
  },
  "ИИ рекомендует принять с замечаниями": {
    kk: "ЖИ ескертулермен қабылдауды ұсынады",
    en: "AI recommends accepting with remarks",
  },
  "ИИ рекомендует вернуть на доработку": {
    kk: "ЖИ пысықтауға қайтаруды ұсынады",
    en: "AI recommends returning for rework",
  },
  "Архивная проверка": {
    kk: "Мұрағаттағы тексеру",
    en: "Archived review",
  },
  " Следующая попытка: {0}.": {
    kk: " Келесі әрекет: {0}.",
    en: " Next attempt: {0}.",
  },
  "Статус автоматической проверки обновляется.": {
    kk: "Автоматты тексеру күйі жаңартылуда.",
    en: "Automated review status is updating.",
  },
  "Автоматическая проверка": {
    kk: "Автоматты тексеру",
    en: "Automated review",
  },
  "Попытка ремонта {0}": {
    kk: "Жөндеу әрекеті {0}",
    en: "Repair attempt {0}",
  },
  Ожидание: {
    kk: "Күту",
    en: "Pending",
  },
  "Итог по вашей сдаче ещё не сформирован. Когда проверка завершится, здесь появятся результат и время относительно нормы.":
    {
      kk: "Тапсырған жұмысыңыздың қорытындысы әлі дайын емес. Тексеру аяқталғанда нәтиже мен нормаға қатысты уақыт көрсетіледі.",
      en: "Your submission has not been assessed yet. The result and time comparison will appear after review.",
    },
  "Отчёт для этой попытки ещё не сформирован.": {
    kk: "Осы әрекеттің есебі әлі дайын емес.",
    en: "The report for this attempt is not ready yet.",
  },
  " · попытка ремонта {0}": {
    kk: " · жөндеу әрекеті {0}",
    en: " · repair attempt {0}",
  },
  "Наряд отменён": {
    kk: "Наряд тоқтатылды",
    en: "Work order cancelled",
  },
  "Решение мастера принято": {
    kk: "Шебер шешім қабылдады",
    en: "Supervisor decision recorded",
  },
  "Мастер вернул на доработку": {
    kk: "Шебер пысықтауға қайтарды",
    en: "Supervisor returned it for rework",
  },
  "Ожидает решения мастера": {
    kk: "Шебер шешімін күтуде",
    en: "Awaiting supervisor decision",
  },
  "Рекомендация готова": {
    kk: "Ұсыным дайын",
    en: "Recommendation ready",
  },
  "Наряд отменён.": {
    kk: "Наряд тоқтатылды.",
    en: "Work order cancelled.",
  },
  "Наряд возвращён на доработку.": {
    kk: "Наряд пысықтауға қайтарылды.",
    en: "Work order returned for rework.",
  },
  "Наряд закрыт.": {
    kk: "Наряд жабылды.",
    en: "Work order closed.",
  },
  "Ниже сохранён предварительный вывод проверки на момент сдачи.": {
    kk: "Төменде жұмыс тапсырылған сәттегі алдын ала тексеру қорытындысы сақталған.",
    en: "The preliminary assessment at the time of submission is preserved below.",
  },
  "Это предварительный результат по вашей сдаче. Решение о закрытии или доработке принимает мастер.": {
    kk: "Бұл — тапсырған жұмысыңыздың алдын ала нәтижесі. Жабу немесе қайта өңдеу туралы шешімді шебер қабылдайды.",
    en: "This is a preliminary assessment. The supervisor decides whether to close the order or request rework.",
  },
  "Пояснение отсутствует.": {
    kk: "Түсіндірме жоқ.",
    en: "No explanation provided.",
  },
  "Предварительная оценка ИИ:": {
    kk: "ЖИ алдын ала бағасы:",
    en: "Preliminary AI score:",
  },
  "Оценка мастера:": {
    kk: "Шебер бағасы:",
    en: "Supervisor score:",
  },
  "Подробности проверки не сохранены.": {
    kk: "Тексеру мәліметтері сақталмаған.",
    en: "Review details were not saved.",
  },
  "Активная работа": {
    kk: "Белсенді жұмыс",
    en: "Active work",
  },
  Паузы: {
    kk: "Үзілістер",
    en: "Pauses",
  },
  "Прошедшее время": {
    kk: "Өткен уақыт",
    en: "Elapsed time",
  },
  Норма: {
    kk: "Норма",
    en: "Standard",
  },
  "Ограничения проверки": {
    kk: "Тексеру шектеулері",
    en: "Review limitations",
  },
  "Предыдущие проверки (": {
    kk: "Алдыңғы тексерулер (",
    en: "Previous reviews (",
  },
  "Проверка от": {
    kk: "Тексеру күні",
    en: "Reviewed on",
  },
  "Предыдущая сдача": {
    kk: "Алдыңғы тапсыру",
    en: "Previous submission",
  },
  "Работа принята мастером": {
    kk: "Жұмысты шебер қабылдады",
    en: "Work accepted by supervisor",
  },
  "Возвращено на доработку": {
    kk: "Қайта өңдеуге қайтарылды",
    en: "Returned for rework",
  },
  "Результат вашей сдачи": {
    kk: "Тапсырған жұмысыңыздың нәтижесі",
    en: "Your submission result",
  },
  "РЕЗУЛЬТАТ ВАШЕЙ СДАЧИ · ПОПЫТКА": {
    kk: "ТАПСЫРУ НӘТИЖЕСІ · ӘРЕКЕТ",
    en: "SUBMISSION RESULT · ATTEMPT",
  },
  "Итог проверки": {
    kk: "Тексеру қорытындысы",
    en: "Review outcome",
  },
  "Итоговая оценка:": {
    kk: "Қорытынды баға:",
    en: "Final score:",
  },
  "Относительно нормы": {
    kk: "Нормаға қатысты",
    en: "Compared with standard",
  },
  "Что получилось": {
    kk: "Сәтті орындалғаны",
    en: "What went well",
  },
  "Проверка не выделила отдельных сильных сторон.": {
    kk: "Тексеру жеке артықшылықтарды анықтамады.",
    en: "The review did not identify specific strengths.",
  },
  "Что улучшить": {
    kk: "Нені жақсарту керек",
    en: "What to improve",
  },
  "Замечаний по этой сдаче нет.": {
    kk: "Бұл жұмыс бойынша ескертулер жоқ.",
    en: "No issues with this submission.",
  },
  "Обновлено:": {
    kk: "Жаңартылған:",
    en: "Updated:",
  },
  ". Закрытие или возврат в доработку решает мастер.": {
    kk: ". Жабу немесе қайта өңдеуге қайтаруды шебер шешеді.",
    en: ". The supervisor decides whether to close or return for rework.",
  },
  "Новая сдача проверяется. Ниже показан результат предыдущей попытки.": {
    kk: "Жаңа тапсыру тексерілуде. Төменде алдыңғы әрекеттің нәтижесі көрсетілген.",
    en: "The new submission is being reviewed. The previous result is shown below.",
  },
  "Предыдущие результаты (": {
    kk: "Алдыңғы нәтижелер (",
    en: "Previous results (",
  },
  Попытка: {
    kk: "Әрекет",
    en: "Attempt",
  },
  Смена: {
    kk: "Ауысым",
    en: "Shift",
  },
  День: {
    kk: "Күн",
    en: "Day",
  },
  Неделя: {
    kk: "Апта",
    en: "Week",
  },
  Месяц: {
    kk: "Ай",
    en: "Month",
  },
  Период: {
    kk: "Кезең",
    en: "Period",
  },
  "Недостаточно данных": {
    kk: "Деректер жеткіліксіз",
    en: "Insufficient data",
  },
  "Этот отчёт недоступен для вашей роли.": {
    kk: "Бұл есеп сіздің рөліңіз үшін қолжетімсіз.",
    en: "This report is not available for your role.",
  },
  "Не удалось сформировать отчёт. Проверьте параметры периода и соединение.": {
    kk: "Есеп жасалмады. Кезең параметрлері мен байланысты тексеріңіз.",
    en: "Could not generate the report. Check the period and connection.",
  },
  "Не удалось получить значения фильтров.": {
    kk: "Сүзгі мәндері алынбады.",
    en: "Could not load filter values.",
  },
  "Не удалось скачать XLSX. Повторите попытку.": {
    kk: "XLSX жүктелмеді. Қайталап көріңіз.",
    en: "Could not download XLSX. Try again.",
  },
  "Сводка уже формировалась. Подождите 30 секунд и повторите запрос.": {
    kk: "Жиынтық жақында жасалды. 30 секундтан кейін қайталаңыз.",
    en: "A summary was recently requested. Wait 30 seconds and try again.",
  },
  "ИИ-сводки сейчас заняты. Подождите и повторите запрос.": {
    kk: "ЖИ жиынтықтары қазір бос емес. Күтіп, қайталаңыз.",
    en: "AI summaries are busy. Wait and try again.",
  },
  "ИИ-сводка не сформирована. Исходные показатели доступны ниже.": {
    kk: "ЖИ жиынтығы жасалмады. Бастапқы көрсеткіштер төменде қолжетімді.",
    en: "The AI summary could not be generated. Source metrics are available below.",
  },
  "РЕЗУЛЬТАТЫ РАБОТЫ": {
    kk: "ЖҰМЫС НӘТИЖЕЛЕРІ",
    en: "WORK RESULTS",
  },
  "Мой отчёт": {
    kk: "Менің есебім",
    en: "My report",
  },
  "Отчёты смены": {
    kk: "Ауысым есептері",
    en: "Shift reports",
  },
  "По журналу нарядов · время Костаная": {
    kk: "Нарядтар журналы бойынша · Қостанай уақыты",
    en: "Based on the work order log · Kostanay time",
  },
  "Готовим Excel…": {
    kk: "Excel дайындалуда…",
    en: "Preparing Excel…",
  },
  "Скачать Excel": {
    kk: "Excel жүктеу",
    en: "Download Excel",
  },
  "Считаем…": {
    kk: "Есептелуде…",
    en: "Calculating…",
  },
  "Обновить отчёт": {
    kk: "Есепті жаңарту",
    en: "Refresh report",
  },
  "Дневная · 08:00–20:00": {
    kk: "Күндізгі · 08:00–20:00",
    en: "Day · 08:00–20:00",
  },
  "Ночная · 20:00–08:00": {
    kk: "Түнгі · 20:00–08:00",
    en: "Night · 20:00–08:00",
  },
  С: {
    kk: "Басталуы",
    en: "From",
  },
  По: {
    kk: "Аяқталуы",
    en: "To",
  },
  "Дата отчёта": {
    kk: "Есеп күні",
    en: "Report date",
  },
  Участок: {
    kk: "Учаске",
    en: "Area",
  },
  Оборудование: {
    kk: "Жабдық",
    en: "Equipment",
  },
  Бригада: {
    kk: "Бригада",
    en: "Team",
  },
  "Исполнитель или бригада": { kk: "Орындаушы немесе бригада", en: "Technician or team" },
  "Рекомендуемая бригада": { kk: "Ұсынылған бригада", en: "Recommended team" },
  "Доступная бригада": { kk: "Қолжетімді бригада", en: "Available team" },
  "Почему этот состав": { kk: "Неліктен осы құрам", en: "Why this team" },
  "Причины не указаны.": { kk: "Себептер көрсетілмеген.", en: "No reasons provided." },
  "Свободны {0} из {1}": { kk: "Бос: {1} ішінен {0}", en: "Available: {0} of {1}" },
  "Специалист по {0}: {1}": { kk: "{0} бойынша маман: {1}", en: "{0} specialists: {1}" },
  "Нет подтверждённого специалиста по {0}": {
    kk: "{0} бойынша расталған маман жоқ",
    en: "No confirmed specialist for {0}",
  },
  "Специальность определена по описанию: {0}": {
    kk: "Мамандық сипаттамадан анықталды: {0}",
    en: "Specialty inferred from the description: {0}",
  },
  "Специальность не определена": { kk: "Мамандық анықталмады", en: "Specialty is not determined" },
  "Качество: {0}/5 по {1} нарядам": {
    kk: "Сапа: {1} наряд бойынша {0}/5",
    en: "Quality: {0}/5 from {1} work orders",
  },
  "Недостаточно данных о качестве": {
    kk: "Сапа туралы дерек жеткіліксіз",
    en: "Not enough quality data",
  },
  "Подтверждённой рекомендации по бригаде нет.": {
    kk: "Бригада бойынша расталған ұсыныс жоқ.",
    en: "There is no confirmed team recommendation.",
  },
  "Специальность бригады не подтверждена": {
    kk: "Бригада мамандығы расталмаған",
    en: "The team specialty is not confirmed",
  },
  "Ответственный выбран мастером.": {
    kk: "Жауаптыны шебер таңдады.",
    en: "The responsible technician was chosen by the supervisor.",
  },
  "В бригаде нет подходящего специалиста": {
    kk: "Бригадада сәйкес маман жоқ",
    en: "The team has no matching specialist",
  },
  "Индивидуальное назначение": { kk: "Жеке тағайындау", en: "Individual assignment" },
  "Участников: {0}": { kk: "Қатысушылар: {0}", en: "Members: {0}" },
  "Ответственный:": { kk: "Жауапты:", en: "Responsible:" },
  Ответственный: { kk: "Жауапты", en: "Responsible" },
  "Участники:": { kk: "Қатысушылар:", en: "Members:" },
  "Бригада:": { kk: "Бригада:", en: "Team:" },
  "Состав бригады": { kk: "Бригада құрамы", en: "Team members" },
  "Нет доступных бригад: нужны не менее двух сотрудников одной бригады на смене с доступом к этому участку.":
    {
      kk: "Қолжетімді бригада жоқ: осы учаскеге рұқсаты бар, ауысымдағы бір бригаданың кемінде екі қызметкері қажет.",
      en: "No eligible brigades: at least two on-shift members of the same brigade must have access to this area.",
    },
  "Не удалось подобрать бригаду. Выберите исполнителя или повторите попытку.": {
    kk: "Бригаданы таңдау мүмкін болмады. Орындаушыны таңдаңыз немесе қайталап көріңіз.",
    en: "Could not choose a team. Select a technician or try again.",
  },
  "Состав бригады изменился. Выберите бригаду и ответственного заново.": {
    kk: "Бригада құрамы өзгерді. Бригада мен жауаптыны қайта таңдаңыз.",
    en: "The team membership changed. Choose the team and responsible technician again.",
  },
  "Участник бригады занят другим нарядом. Завершите или приостановите его работу, либо попросите мастера проверить состав бригады.":
    {
      kk: "Бригада қатысушысы басқа нарядпен айналысып жатыр. Оның жұмысын аяқтаңыз не тоқтатыңыз немесе шеберден бригада құрамын тексеруді сұраңыз.",
      en: "A team member is busy with another work order. Finish or pause that work, or ask the supervisor to check the team assignment.",
    },
  "Участник бригады недоступен по роли, смене или участку. Попросите мастера проверить состав бригады.": {
    kk: "Бригада қатысушысы рөлі, ауысымы немесе учаскесі бойынша қолжетімсіз. Шеберден бригада құрамын тексеруді сұраңыз.",
    en: "A team member is unavailable for the role, shift, or area. Ask the supervisor to check the team assignment.",
  },
  "Вы участник. Отчёт сдаёт {0}.": {
    kk: "Сіз қатысушысыз. Есепті {0} тапсырады.",
    en: "You are a participant. {0} submits the report.",
  },
  "Общий отчёт бригады": { kk: "Бригаданың ортақ есебі", en: "Shared team report" },
  "Не удалось загрузить доступные бригады.": {
    kk: "Қолжетімді бригадаларды жүктеу мүмкін болмады.",
    en: "Could not load available teams.",
  },
  "Сообщить о поломке": { kk: "Ақау туралы хабарлау", en: "Report a fault" },
  "Сообщения о поломках": { kk: "Ақаулар туралы хабарламалар", en: "Fault reports" },
  "Сообщение о поломке": { kk: "Ақау туралы хабарлама", en: "Fault report" },
  "Новое сообщение о поломке": { kk: "Ақау туралы жаңа хабарлама", en: "New fault report" },
  "Опишите поломку. Мастер получит сообщение и решит, нужен ли наряд.": {
    kk: "Ақауды сипаттаңыз. Шебер хабарламаны алып, наряд қажет пе, соны шешеді.",
    en: "Describe the fault. The supervisor will receive the report and decide whether a work order is needed.",
  },
  "Выберите оборудование, мастера и опишите неисправность.": {
    kk: "Жабдық пен шеберді таңдаңыз және ақауды сипаттаңыз.",
    en: "Choose equipment and a supervisor, then describe the fault.",
  },
  "Для этого оборудования сейчас нет доступного мастера.": {
    kk: "Бұл жабдық үшін қазір қолжетімді шебер жоқ.",
    en: "There is no available supervisor for this equipment right now.",
  },
  "Что произошло": { kk: "Не болды", en: "What happened" },
  "Отправить сообщение": { kk: "Хабарлама жіберу", en: "Send report" },
  "Отправляем…": { kk: "Жіберілуде…", en: "Sending…" },
  "Мои сообщения": { kk: "Менің хабарламаларым", en: "My reports" },
  "Открытые сообщения": { kk: "Ашық хабарламалар", en: "Open reports" },
  Открытые: { kk: "Ашық", en: "Open" },
  "Все сообщения": { kk: "Барлық хабарламалар", en: "All reports" },
  "Сообщений пока нет.": { kk: "Әзірге хабарламалар жоқ.", en: "There are no reports yet." },
  Открыто: { kk: "Ашық", en: "Open" },
  "Закрыто с пояснением": { kk: "Түсіндірмемен жабылды", en: "Closed with an explanation" },
  "Закрыть с пояснением": { kk: "Түсіндірмемен жабу", en: "Close with an explanation" },
  Сообщил: { kk: "Хабарлаған", en: "Reported by" },
  "Отклонить с причиной": { kk: "Себебін көрсетіп қабылдамау", en: "Dismiss with a reason" },
  "Подтвердить отклонение": { kk: "Қабылдамауды растау", en: "Confirm dismissal" },
  "Открыть сообщение": { kk: "Хабарламаны ашу", en: "Open report" },
  "Не удалось подтвердить отправку. Повторите попытку — сообщение не продублируется.": {
    kk: "Жіберуді растау мүмкін болмады. Қайталап көріңіз — хабарлама қайталанбайды.",
    en: "Could not confirm delivery. Try again — the report will not be duplicated.",
  },
  "Нет соединения. Не удалось подтвердить отправку. Повторите попытку — сообщение не продублируется.": {
    kk: "Байланыс жоқ. Жіберуді растау мүмкін болмады. Қайталап көріңіз — хабарлама қайталанбайды.",
    en: "No connection. Could not confirm delivery. Try again — the report will not be duplicated.",
  },
  "Сообщение больше недоступно. Обновите список.": {
    kk: "Хабарлама енді қолжетімсіз. Тізімді жаңартыңыз.",
    en: "The report is no longer available. Refresh the list.",
  },
  "Сообщение уже обработано. Откройте актуальный список.": {
    kk: "Хабарлама өңделіп қойған. Өзекті тізімді ашыңыз.",
    en: "The report has already been handled. Open the current list.",
  },
  "Сообщение изменилось. Проверьте актуальные данные и повторите действие.": {
    kk: "Хабарлама өзгерді. Өзекті деректерді тексеріп, әрекетті қайталаңыз.",
    en: "The report changed. Check the current details and try the action again.",
  },
  "Не удалось выполнить действие. Проверьте соединение и повторите.": {
    kk: "Әрекетті орындау мүмкін болмады. Байланысты тексеріп, қайталаңыз.",
    en: "Could not complete the action. Check the connection and try again.",
  },
  Применить: {
    kk: "Қолдану",
    en: "Apply",
  },
  "Фильтры изменены. Нажмите «Применить», чтобы обновить показанный отчёт, выгрузку и ИИ-сводку.": {
    kk: "Сүзгілер өзгерді. Есепті, экспортты және ЖИ жиынтығын жаңарту үшін «Қолдану» түймесін басыңыз.",
    en: "Filters changed. Select Apply to update the report, export and AI summary.",
  },
  "Появились новые изменения.": {
    kk: "Жаңа өзгерістер бар.",
    en: "New changes are available.",
  },
  "Обновить данные": {
    kk: "Деректерді жаңарту",
    en: "Refresh data",
  },
  "Формируем отчёт по журналу нарядов…": {
    kk: "Нарядтар журналы бойынша есеп жасалуда…",
    en: "Generating the work order report…",
  },
  "Сформирован:": {
    kk: "Жасалған:",
    en: "Generated:",
  },
  "Нарядов в расчёте:": {
    kk: "Есептегі нарядтар:",
    en: "Work orders included:",
  },
  Выдано: {
    kk: "Берілді",
    en: "Issued",
  },
  Завершено: {
    kk: "Аяқталды",
    en: "Completed",
  },
  Закрыто: {
    kk: "Жабылды",
    en: "Closed",
  },
  Отказы: {
    kk: "Бас тартулар",
    en: "Rejections",
  },
  Незакрыто: {
    kk: "Жабылмаған",
    en: "Open",
  },
  Просрочено: {
    kk: "Мерзімі өткен",
    en: "Overdue",
  },
  Реакция: {
    kk: "Жауап беру",
    en: "Response",
  },
  "В среднем до первого ответа": {
    kk: "Бірінші жауапқа дейінгі орташа уақыт",
    en: "Average time to first response",
  },
  Работа: {
    kk: "Жұмыс",
    en: "Work",
  },
  "В среднем, без пауз": {
    kk: "Орташа, үзіліссіз",
    en: "Average, excluding pauses",
  },
  Простой: {
    kk: "Бос тұру",
    en: "Downtime",
  },
  "Только записанные интервалы": {
    kk: "Тек тіркелген аралықтар",
    en: "Recorded intervals only",
  },
  "Активные наряды": {
    kk: "Белсенді нарядтар",
    en: "Active work orders",
  },
  СРАВНЕНИЕ: {
    kk: "САЛЫСТЫРУ",
    en: "COMPARISON",
  },
  "ЛИЧНЫЕ РЕЗУЛЬТАТЫ": {
    kk: "ЖЕКЕ НӘТИЖЕЛЕР",
    en: "PERSONAL RESULTS",
  },
  "Рейтинг исполнения": {
    kk: "Орындау рейтингі",
    en: "Performance ranking",
  },
  "Моя оценка": {
    kk: "Менің бағам",
    en: "My score",
  },
  "Оценка показывает только подтверждённые компоненты; малые выборки отмечены.": {
    kk: "Баға тек расталған құрамдастарды қамтиды; шағын іріктемелер белгіленген.",
    en: "Scores include verified components only; small samples are marked.",
  },
  СИГНАЛЫ: {
    kk: "БЕЛГІЛЕР",
    en: "SIGNALS",
  },
  "Аномалии с доказательствами": {
    kk: "Дәлелдері бар ауытқулар",
    en: "Evidence-based anomalies",
  },
  "Система показывает только наблюдаемые факты.": {
    kk: "Жүйе тек байқалған фактілерді көрсетеді.",
    en: "The system shows observed facts only.",
  },
  "ПО ЗАПРОСУ": {
    kk: "СҰРАУ БОЙЫНША",
    en: "ON REQUEST",
  },
  "ИИ-сводка мастера": {
    kk: "Шеберге арналған ЖИ жиынтығы",
    en: "Supervisor AI summary",
  },
  "Основные выводы и рекомендации за выбранный период.": {
    kk: "Таңдалған кезеңнің негізгі қорытындылары мен ұсынымдары.",
    en: "Key findings and recommendations for the selected period.",
  },
  "Формируем…": {
    kk: "Жасалуда…",
    en: "Generating…",
  },
  "Сформировать ИИ-сводку": {
    kk: "ЖИ жиынтығын жасау",
    en: "Generate AI summary",
  },
  "Обзор показателей без ИИ-интерпретации.": {
    kk: "ЖИ түсіндірмесінсіз көрсеткіштер шолуы.",
    en: "Metrics overview without AI interpretation.",
  },
  "Все доступные": {
    kk: "Барлық қолжетімді",
    en: "All available",
  },
  "Рейтинг пока не рассчитан": {
    kk: "Рейтинг әлі есептелмеген",
    en: "Ranking not calculated yet",
  },
  "Для периода недостаточно подтверждённых данных.": {
    kk: "Бұл кезеңде расталған деректер жеткіліксіз.",
    en: "Not enough verified data for this period.",
  },
  Исполнители: {
    kk: "Орындаушылар",
    en: "Technicians",
  },
  Бригады: {
    kk: "Бригадалар",
    en: "Teams",
  },
  Качество: {
    kk: "Сапа",
    en: "Quality",
  },
  Срок: {
    kk: "Мерзім",
    en: "Deadline",
  },
  Доработки: {
    kk: "Қайта өңдеулер",
    en: "Rework",
  },
  Объём: {
    kk: "Көлем",
    en: "Volume",
  },
  "Повторяемость неисправности": {
    kk: "Ақаудың қайталануы",
    en: "Recurring fault",
  },
  "После ППР": {
    kk: "Жоспарлы жөндеуден кейін",
    en: "After preventive maintenance",
  },
  "Отклонение материалов": {
    kk: "Материалдар ауытқуы",
    en: "Material variance",
  },
  "Концентрация доработок": {
    kk: "Қайта өңдеулердің шоғырлануы",
    en: "Rework concentration",
  },
  Низкий: {
    kk: "Төмен",
    en: "Low",
  },
  Средний: {
    kk: "Орташа",
    en: "Medium",
  },
  Высокий: {
    kk: "Жоғары",
    en: "High",
  },
  Наряды: {
    kk: "Нарядтар",
    en: "Work orders",
  },
  Количество: {
    kk: "Саны",
    en: "Quantity",
  },
  Основание: {
    kk: "Негіздеме",
    en: "Basis",
  },
  Числитель: {
    kk: "Алым",
    en: "Numerator",
  },
  Материал: {
    kk: "Материал",
    en: "Material",
  },
  Доля: {
    kk: "Үлес",
    en: "Share",
  },
  "Средняя доля": {
    kk: "Орташа үлес",
    en: "Average share",
  },
  "Обычный расход (медиана)": {
    kk: "Әдеттегі шығын (медиана)",
    en: "Typical usage (median)",
  },
  Всего: {
    kk: "Барлығы",
    en: "Total",
  },
  "{0} и ещё {1}": {
    kk: "{0} және тағы {1}",
    en: "{0} and {1} more",
  },
  "Составное доказательство": {
    kk: "Құрама дәлел",
    en: "Combined evidence",
  },
  "Нарядов:": {
    kk: "Нарядтар:",
    en: "Work orders:",
  },
  " · нет: {0}": {
    kk: " · жоқ: {0}",
    en: " · unavailable: {0}",
  },
  "Состав оценки": {
    kk: "Баға құрамы",
    en: "Score breakdown",
  },
  "нет данных": {
    kk: "деректер жоқ",
    en: "no data",
  },
  из: {
    kk: "ішінен",
    en: "out of",
  },
  РЕСУРСЫ: {
    kk: "РЕСУРСТАР",
    en: "RESOURCES",
  },
  Материалы: {
    kk: "Материалдар",
    en: "Materials",
  },
  "Расход разделён по материалу и единице.": {
    kk: "Шығын материал мен өлшем бірлігі бойынша бөлінген.",
    en: "Usage is grouped by material and unit.",
  },
  Расход: {
    kk: "Шығын",
    en: "Usage",
  },
  Нарядов: {
    kk: "Наряд саны",
    en: "Work orders",
  },
  "Расхода материалов в выбранном периоде нет.": {
    kk: "Таңдалған кезеңде материал шығыны жоқ.",
    en: "No material usage in the selected period.",
  },
  "По участкам": {
    kk: "Учаскелер бойынша",
    en: "By area",
  },
  "По оборудованию": {
    kk: "Жабдық бойынша",
    en: "By equipment",
  },
  "По исполнителям": {
    kk: "Орындаушылар бойынша",
    en: "By technician",
  },
  ОБОРУДОВАНИЕ: {
    kk: "ЖАБДЫҚ",
    en: "EQUIPMENT",
  },
  "Зафиксированный простой": {
    kk: "Тіркелген бос тұру",
    en: "Recorded downtime",
  },
  "Только явно внесённые интервалы, не выводится из статусов.": {
    kk: "Тек енгізілген аралықтар; күйлерден есептелмейді.",
    en: "Explicitly recorded intervals only; not inferred from statuses.",
  },
  "Плановый:": {
    kk: "Жоспарлы:",
    en: "Planned:",
  },
  "Неплановый:": {
    kk: "Жоспардан тыс:",
    en: "Unplanned:",
  },
  "Нет записи: {0}": {
    kk: "Жазба жоқ: {0}",
    en: "No record: {0}",
  },
  "Интервал записан": {
    kk: "Аралық тіркелді",
    en: "Interval recorded",
  },
  "Нет записанных интервалов простоя.": {
    kk: "Бос тұру аралықтары тіркелмеген.",
    en: "No downtime intervals recorded.",
  },
  "По неисправностям:": {
    kk: "Ақаулар бойынша:",
    en: "By fault:",
  },
  "Правило:": {
    kk: "Ереже:",
    en: "Rule:",
  },
  "Аномалий не найдено": {
    kk: "Ауытқулар табылмады",
    en: "No anomalies found",
  },
  "В периоде нет достаточных доказательств для сигнала.": {
    kk: "Бұл кезеңде белгі беруге жеткілікті дәлел жоқ.",
    en: "Insufficient evidence to raise a signal in this period.",
  },
  "СМЕННАЯ ЗАГРУЗКА": {
    kk: "АУЫСЫМ ЖҮКТЕМЕСІ",
    en: "SHIFT WORKLOAD",
  },
  "Показаны только подтверждённые интервалы по нарядам.": {
    kk: "Нарядтар бойынша тек расталған аралықтар көрсетілген.",
    en: "Only verified work order intervals are shown.",
  },
  "Работа / пауза": {
    kk: "Жұмыс / үзіліс",
    en: "Work / pause",
  },
  "Активных интервалов в выбранном периоде нет.": {
    kk: "Таңдалған кезеңде белсенді аралықтар жоқ.",
    en: "No active intervals in the selected period.",
  },
  "ещё не наблюдался": {
    kk: "әлі байқалмады",
    en: "not yet observed",
  },
  "Методика и ограничения (": {
    kk: "Әдістеме және шектеулер (",
    en: "Methodology and limitations (",
  },
  "Приложение установлено. Уведомления включаются отдельно в журнале уведомлений.": {
    kk: "Қолданба орнатылған. Хабарландырулар хабарламалар журналында бөлек қосылады.",
    en: "App installed. Enable notifications separately in the notification inbox.",
  },
  "Установка подтверждена браузером.": {
    kk: "Орнатуды браузер растады.",
    en: "Installation confirmed by the browser.",
  },
  "Установка отменена. Можно продолжить в браузере.": {
    kk: "Орнату тоқтатылды. Браузерде жалғастыруға болады.",
    en: "Installation cancelled. You can continue in the browser.",
  },
  "Установка приложения": {
    kk: "Қолданбаны орнату",
    en: "App installation",
  },
  "Работа с телефона": {
    kk: "Телефонмен жұмыс",
    en: "Working on your phone",
  },
  "Чтобы установить ТехНаряд на iPhone или iPad: откройте меню «Поделиться» в Safari и выберите «На экран Домой».":
    {
      kk: "ТехНарядты iPhone не iPad құрылғысына орнату үшін Safari браузеріндегі «Бөлісу» мәзірінен «Басты экранға қосу» тармағын таңдаңыз.",
      en: "To install TechNaryad on iPhone or iPad, open Share in Safari and choose Add to Home Screen.",
    },
  "Установите приложение, чтобы открывать наряды с домашнего экрана и получать фоновые уведомления после отдельного разрешения.":
    {
      kk: "Нарядтарды басты экраннан ашу және бөлек рұқсат бергеннен кейін фондық хабарландыру алу үшін қолданбаны орнатыңыз.",
      en: "Install the app to open work orders from your home screen and receive background notifications after granting permission.",
    },
  "Установить приложение": {
    kk: "Қолданбаны орнату",
    en: "Install app",
  },
  "Не удалось ": {
    kk: "Орындалмады: ",
    en: "Could not ",
  },
  ". Проверьте соединение и повторите.": {
    kk: ". Байланысты тексеріп, қайталаңыз.",
    en: ". Check your connection and try again.",
  },
  "Нельзя изменить собственную роль или статус. Это ограничение защищает доступ администратора.": {
    kk: "Өз рөліңізді не күйіңізді өзгертуге болмайды. Бұл әкімші қолжетімділігін қорғайды.",
    en: "You cannot change your own role or status. This protects administrator access.",
  },
  "Логин уже используется или выбранная бригада либо участок изменились. Обновите список и повторите.": {
    kk: "Логин қолданылуда немесе таңдалған бригада не учаске өзгерген. Тізімді жаңартып, қайталаңыз.",
    en: "The login is already in use, or the selected team or area has changed. Refresh and retry.",
  },
  "Нельзя изменить доступ: у сотрудника есть незавершённый наряд. Завершите или отмените его сначала.": {
    kk: "Қолжетімділікті өзгертуге болмайды: қызметкерде аяқталмаған наряд бар. Алдымен оны аяқтаңыз не тоқтатыңыз.",
    en: "Cannot change access while the employee has an unfinished work order. Complete or cancel it first.",
  },
  "Данные сотрудника изменились. Обновите список и повторите действие.": {
    kk: "Қызметкер деректері өзгерген. Тізімді жаңартып, әрекетті қайталаңыз.",
    en: "Employee data has changed. Refresh the list and retry.",
  },
  "Проверьте поля: логин, пароль и доступы должны соответствовать правилам.": {
    kk: "Өрістерді тексеріңіз: логин, пароль және рұқсаттар ережелерге сай болуы керек.",
    en: "Check the fields: login, password and access must meet the requirements.",
  },
  ". Повторите попытку.": {
    kk: ". Қайталап көріңіз.",
    en: ". Try again.",
  },
  "получить список сотрудников": {
    kk: "қызметкерлер тізімін алу",
    en: "load the employee list",
  },
  "открыть параметры доступа": {
    kk: "қолжетімділік параметрлерін ашу",
    en: "open access settings",
  },
  АДМИНИСТРИРОВАНИЕ: {
    kk: "ӘКІМШІЛЕНДІРУ",
    en: "ADMINISTRATION",
  },
  "Сотрудники и доступ": {
    kk: "Қызметкерлер және қолжетімділік",
    en: "Employees and access",
  },
  "Добавьте сотрудника или откройте его запись, чтобы настроить права и пароль.": {
    kk: "Қызметкерді қосыңыз немесе құқықтары мен паролін баптау үшін оның жазбасын ашыңыз.",
    en: "Add an employee or open their record to manage permissions and password.",
  },
  "Добавить сотрудника": {
    kk: "Қызметкер қосу",
    en: "Add employee",
  },
  "Фильтры сотрудников": {
    kk: "Қызметкер сүзгілері",
    en: "Employee filters",
  },
  Поиск: {
    kk: "Іздеу",
    en: "Search",
  },
  "Имя, логин или специальность": {
    kk: "Аты-жөні, логин немесе мамандық",
    en: "Name, login or specialty",
  },
  Фильтры: {
    kk: "Сүзгілер",
    en: "Filters",
  },
  Роль: {
    kk: "Рөл",
    en: "Role",
  },
  "Все роли": {
    kk: "Барлық рөлдер",
    en: "All roles",
  },
  Статус: {
    kk: "Күй",
    en: "Status",
  },
  "Все статусы": {
    kk: "Барлық күйлер",
    en: "All statuses",
  },
  "Доступ активен": {
    kk: "Қолжетімділік белсенді",
    en: "Access active",
  },
  "Доступ отключён": {
    kk: "Қолжетімділік өшірілген",
    en: "Access disabled",
  },
  "Обновляем…": {
    kk: "Жаңартылуда…",
    en: "Refreshing…",
  },
  Обновить: {
    kk: "Жаңарту",
    en: "Refresh",
  },
  "Закрыть подтверждение": {
    kk: "Растауды жабу",
    en: "Dismiss confirmation",
  },
  "Найдено:": {
    kk: "Табылды:",
    en: "Found:",
  },
  "Сбросить поиск и фильтры": {
    kk: "Іздеу мен сүзгілерді тазалау",
    en: "Clear search and filters",
  },
  "Загружаем сотрудников…": {
    kk: "Қызметкерлер жүктелуде…",
    en: "Loading employees…",
  },
  "Список сотрудников": {
    kk: "Қызметкерлер тізімі",
    en: "Employee list",
  },
  "Специальность не указана": {
    kk: "Мамандық көрсетілмеген",
    en: "Specialty not specified",
  },
  " разряд": {
    kk: " разряд",
    en: " grade",
  },
  "Разряд не указан": {
    kk: "Разряд көрсетілмеген",
    en: "Grade not specified",
  },
  "Это ваша учётная запись": {
    kk: "Бұл — сіздің есептік жазбаңыз",
    en: "This is your account",
  },
  Настроить: {
    kk: "Баптау",
    en: "Configure",
  },
  "Сотрудники не найдены": {
    kk: "Қызметкерлер табылмады",
    en: "No employees found",
  },
  "Измените строку поиска или фильтры.": {
    kk: "Іздеу мәтінін немесе сүзгілерді өзгертіңіз.",
    en: "Change the search text or filters.",
  },
  "Сотрудник создан. Передайте ему логин и пароль для входа.": {
    kk: "Қызметкер қосылды. Оған кіру үшін логин мен парольді беріңіз.",
    en: "Employee created. Give them their login and password.",
  },
  "Права доступа сохранены. Сотруднику нужно войти заново.": {
    kk: "Қолжетімділік құқықтары сақталды. Қызметкер қайта кіруі керек.",
    en: "Access permissions saved. The employee needs to sign in again.",
  },
  "Пароль изменён. Старый пароль больше не действует.": {
    kk: "Пароль өзгертілді. Ескі пароль енді жарамсыз.",
    en: "Password changed. The old password no longer works.",
  },
  "Доступ отключён. История работы сохранена.": {
    kk: "Қолжетімділік өшірілді. Жұмыс тарихы сақталды.",
    en: "Access disabled. Work history preserved.",
  },
  "Доступ восстановлен. Сотрудник может войти в систему.": {
    kk: "Қолжетімділік қалпына келтірілді. Қызметкер жүйеге кіре алады.",
    en: "Access restored. The employee can sign in.",
  },
  "Участки допуска": {
    kk: "Рұқсат етілген учаскелер",
    en: "Permitted areas",
  },
  "Сотрудник видит и обрабатывает данные только этих участков.": {
    kk: "Қызметкер тек осы учаскелердің деректерін көреді және өңдейді.",
    en: "The employee can view and process data for these areas only.",
  },
  "Выберите хотя бы один участок, иначе сотрудник не увидит доступные ему данные.": {
    kk: "Кемінде бір учаскені таңдаңыз, әйтпесе қызметкер деректерді көрмейді.",
    en: "Select at least one area so the employee can see available data.",
  },
  "создать сотрудника": {
    kk: "қызметкер жасау",
    en: "create the employee",
  },
  "Новый сотрудник": {
    kk: "Жаңа қызметкер",
    en: "New employee",
  },
  "Сначала укажите сотрудника и его работу, затем выберите участки и задайте пароль.": {
    kk: "Алдымен қызметкер мен жұмысын көрсетіп, кейін учаскелерді таңдап, пароль орнатыңыз.",
    en: "Enter the employee and their job, then select areas and set a password.",
  },
  "Логин: от 3 до 64 символов — строчные латинские буквы, цифры, точка, дефис или подчёркивание. Пароль: от 8 символов.":
    {
      kk: "Логин: 3–64 таңба — кіші латын әріптері, сандар, нүкте, дефис немесе астын сызу. Пароль: кемінде 8 таңба.",
      en: "Login: 3–64 characters using lowercase Latin letters, digits, dots, hyphens or underscores. Password: at least 8 characters.",
    },
  Логин: {
    kk: "Логин",
    en: "Login",
  },
  "ФИО сотрудника": {
    kk: "Қызметкердің аты-жөні",
    en: "Employee full name",
  },
  Специальность: {
    kk: "Мамандық",
    en: "Specialty",
  },
  "Выберите специальность": {
    kk: "Мамандықты таңдаңыз",
    en: "Select specialty",
  },
  Разряд: {
    kk: "Разряд",
    en: "Grade",
  },
  "Не назначена": {
    kk: "Тағайындалмаған",
    en: "Not assigned",
  },
  "Администратор работает со всеми справочниками; участки не ограничивают его доступ.": {
    kk: "Әкімші барлық анықтамалықтармен жұмыс істейді; учаскелер оның қолжетімділігін шектемейді.",
    en: "Administrators manage all directories; areas do not limit their access.",
  },
  Пароль: {
    kk: "Пароль",
    en: "Password",
  },
  Отмена: {
    kk: "Бас тарту",
    en: "Cancel",
  },
  "Создаём…": {
    kk: "Жасалуда…",
    en: "Creating…",
  },
  "Создать сотрудника": {
    kk: "Қызметкер жасау",
    en: "Create employee",
  },
  "Неизвестный участок": {
    kk: "Белгісіз учаске",
    en: "Unknown area",
  },
  "Участки не назначены": {
    kk: "Учаскелер тағайындалмаған",
    en: "No areas assigned",
  },
  "сохранить доступ": {
    kk: "қолжетімділікті сақтау",
    en: "save access",
  },
  "Доступ сотрудника": {
    kk: "Қызметкер қолжетімділігі",
    en: "Employee access",
  },
  "Для собственной учётной записи нельзя менять роль и статус. Это защищает доступ администратора.": {
    kk: "Өз есептік жазбаңыздың рөлі мен күйін өзгертуге болмайды. Бұл әкімші қолжетімділігін қорғайды.",
    en: "You cannot change your own role or status. This protects administrator access.",
  },
  "Изменение роли или участков завершит активные сеансы сотрудника.": {
    kk: "Рөл не учаскелер өзгерсе, қызметкердің белсенді сеанстары аяқталады.",
    en: "Changing roles or areas ends the employee's active sessions.",
  },
  "Пароль сотрудника": {
    kk: "Қызметкер паролі",
    en: "Employee password",
  },
  "Задайте новый пароль, если сотрудник потерял доступ.": {
    kk: "Қызметкер кіре алмаса, жаңа пароль орнатыңыз.",
    en: "Set a new password if the employee has lost access.",
  },
  "Сбросить пароль": {
    kk: "Парольді жаңарту",
    en: "Reset password",
  },
  "Доступ включён": {
    kk: "Қолжетімділік қосылған",
    en: "Access enabled",
  },
  "При изменении статуса все активные сеансы сотрудника будут завершены.": {
    kk: "Күй өзгергенде қызметкердің барлық белсенді сеанстары аяқталады.",
    en: "Changing the status ends all active sessions for this employee.",
  },
  "Отключить доступ": {
    kk: "Қолжетімділікті өшіру",
    en: "Disable access",
  },
  "Включить доступ": {
    kk: "Қолжетімділікті қосу",
    en: "Enable access",
  },
  "Сохраняем…": {
    kk: "Сақталуда…",
    en: "Saving…",
  },
  "Сохранить доступ": {
    kk: "Қолжетімділікті сақтау",
    en: "Save access",
  },
  "Пароли не совпадают. Проверьте оба поля.": {
    kk: "Парольдер сәйкес келмейді. Екі өрісті тексеріңіз.",
    en: "Passwords do not match. Check both fields.",
  },
  "сбросить пароль": {
    kk: "парольді жаңарту",
    en: "reset the password",
  },
  "Сброс пароля": {
    kk: "Парольді жаңарту",
    en: "Password reset",
  },
  "Новый пароль для": {
    kk: "Жаңа пароль:",
    en: "New password for",
  },
  ". После сохранения все активные сеансы будут завершены.": {
    kk: ". Сақтағаннан кейін барлық белсенді сеанстар аяқталады.",
    en: ". Saving ends all active sessions.",
  },
  "Новый пароль": {
    kk: "Жаңа пароль",
    en: "New password",
  },
  "Скрыть пароль": {
    kk: "Парольді жасыру",
    en: "Hide password",
  },
  "Показать пароль": {
    kk: "Парольді көрсету",
    en: "Show password",
  },
  "Повторите пароль": {
    kk: "Парольді қайталаңыз",
    en: "Confirm password",
  },
  "Сохранить пароль": {
    kk: "Парольді сақтау",
    en: "Save password",
  },
  "включить доступ": {
    kk: "қолжетімділікті қосу",
    en: "enable access",
  },
  "отключить доступ": {
    kk: "қолжетімділікті өшіру",
    en: "disable access",
  },
  Включить: {
    kk: "Қосу",
    en: "Enable",
  },
  Отключить: {
    kk: "Өшіру",
    en: "Disable",
  },
  "учётную запись": {
    kk: "есептік жазба",
    en: "account",
  },
  "Сотрудник сможет снова войти в систему.": {
    kk: "Қызметкер жүйеге қайта кіре алады.",
    en: "The employee will be able to sign in again.",
  },
  "Все активные сеансы сотрудника будут немедленно завершены.": {
    kk: "Қызметкердің барлық белсенді сеанстары дереу аяқталады.",
    en: "All active sessions for this employee will end immediately.",
  },
  "Подтвердить отключение": {
    kk: "Өшіруді растау",
    en: "Confirm disabling",
  },
  "Неверный логин или пароль.": {
    kk: "Логин немесе пароль қате.",
    en: "Incorrect login or password.",
  },
  "Слишком много попыток. Повторите позже.": {
    kk: "Тым көп әрекет. Кейінірек қайталаңыз.",
    en: "Too many attempts. Try again later.",
  },
  "Не удалось войти. Проверьте подключение.": {
    kk: "Кіру мүмкін болмады. Байланысты тексеріңіз.",
    en: "Could not sign in. Check your connection.",
  },
  "Костанайские минералы": {
    kk: "Қостанай минералдары",
    en: "Kostanay Minerals",
  },
  "СИСТЕМА РЕМОНТА": {
    kk: "ЖӨНДЕУ ЖҮЙЕСІ",
    en: "MAINTENANCE SYSTEM",
  },
  "Рабочий контур смены: наряды, ремонт и загрузка участка.": {
    kk: "Ауысымның жұмыс ортасы: нарядтар, жөндеу және учаске жүктемесі.",
    en: "Your shift workspace: work orders, repairs and area workload.",
  },
  "Возможности системы": {
    kk: "Жүйе мүмкіндіктері",
    en: "System features",
  },
  Ремонт: {
    kk: "Жөндеу",
    en: "Repairs",
  },
  "Вход в смену": {
    kk: "Ауысымға кіру",
    en: "Sign in to your shift",
  },
  "Введите данные учётной записи для начала смены.": {
    kk: "Ауысымды бастау үшін есептік жазба деректерін енгізіңіз.",
    en: "Enter your account details to start your shift.",
  },
  "Проверяем…": {
    kk: "Тексерілуде…",
    en: "Checking…",
  },
  Войти: {
    kk: "Кіру",
    en: "Sign in",
  },
  "Этот браузер не поддерживает фоновые уведомления или страница открыта не по защищённому адресу.": {
    kk: "Бұл браузер фондық хабарландыруларды қолдамайды немесе бет қорғалған мекенжаймен ашылмаған.",
    en: "This browser does not support background notifications, or this page is not using a secure connection.",
  },
  "Уведомления заблокированы в настройках браузера для этого сайта.": {
    kk: "Осы сайттың хабарландырулары браузер параметрлерінде бұғатталған.",
    en: "Notifications for this site are blocked in your browser settings.",
  },
  "Разрешение браузера выдано. Проверяем подписку этого устройства…": {
    kk: "Браузер рұқсаты берілген. Құрылғы жазылымы тексерілуде…",
    en: "Browser permission granted. Checking this device's subscription…",
  },
  "Получайте уведомления, когда приложение свёрнуто.": {
    kk: "Қолданба жиырылғанда хабарландырулар алыңыз.",
    en: "Receive notifications while the app is in the background.",
  },
  "Уведомления: непрочитанных {0}": {
    kk: "Хабарламалар: оқылмағаны {0}",
    en: "Notifications: {0} unread",
  },
  Уведомления: {
    kk: "Хабарламалар",
    en: "Notifications",
  },
  "Не удалось получить уведомления.": {
    kk: "Хабарламалар алынбады.",
    en: "Could not load notifications.",
  },
  "Уведомления на этом устройстве включены.": {
    kk: "Бұл құрылғыда хабарландырулар қосылған.",
    en: "Notifications are enabled on this device.",
  },
  "Разрешение браузера выдано, но устройство ещё не подписано на уведомления.": {
    kk: "Браузер рұқсаты берілген, бірақ құрылғы әлі хабарландыруларға жазылмаған.",
    en: "Browser permission is granted, but this device is not subscribed yet.",
  },
  "Не удалось проверить подписку устройства.": {
    kk: "Құрылғы жазылымы тексерілмеді.",
    en: "Could not check the device subscription.",
  },
  "Фоновые уведомления пока недоступны. Обратитесь к администратору.": {
    kk: "Фондық хабарландырулар әзірге қолжетімсіз. Әкімшіге хабарласыңыз.",
    en: "Background notifications are not available yet. Contact your administrator.",
  },
  "Разрешение на уведомления не выдано.": {
    kk: "Хабарландыруларға рұқсат берілмеген.",
    en: "Notification permission was not granted.",
  },
  "Не удалось включить уведомления. Повторите позже.": {
    kk: "Хабарландырулар қосылмады. Кейінірек қайталаңыз.",
    en: "Could not enable notifications. Try again later.",
  },
  "Уведомления на устройстве": {
    kk: "Құрылғы хабарландырулары",
    en: "Device notifications",
  },
  "Подключить устройство": {
    kk: "Құрылғыны қосу",
    en: "Connect device",
  },
  "Включить уведомления": {
    kk: "Хабарландыруларды қосу",
    en: "Enable notifications",
  },
  "Только непрочитанные": {
    kk: "Тек оқылмағандар",
    en: "Unread only",
  },
  "Загрузка…": {
    kk: "Жүктелуде…",
    en: "Loading…",
  },
  "Уведомлений нет.": {
    kk: "Хабарламалар жоқ.",
    en: "No notifications.",
  },
  "Открыть наряд": {
    kk: "Нарядты ашу",
    en: "Open work order",
  },
  "Не удалось отметить уведомление.": {
    kk: "Хабарлама белгіленбеді.",
    en: "Could not mark the notification.",
  },
  Прочитано: {
    kk: "Оқылды",
    en: "Read",
  },
  "Не удалось подтвердить получение.": {
    kk: "Алынғаны расталмады.",
    en: "Could not acknowledge receipt.",
  },
  "Подтвердить получение": {
    kk: "Алынғанын растау",
    en: "Acknowledge receipt",
  },
  "Предыдущие уведомления": {
    kk: "Алдыңғы хабарламалар",
    en: "Previous notifications",
  },
  "Следующие уведомления": {
    kk: "Келесі хабарламалар",
    en: "Next notifications",
  },
  Выдан: {
    kk: "Берілген",
    en: "Issued",
  },
  Принят: {
    kk: "Қабылданған",
    en: "Accepted",
  },
  "В очереди": {
    kk: "Кезекте",
    en: "Queued",
  },
  "В работе": {
    kk: "Орындалуда",
    en: "In progress",
  },
  Сдан: {
    kk: "Тапсырылған",
    en: "Submitted",
  },
  Проверка: {
    kk: "Тексеру",
    en: "Review",
  },
  Закрыт: {
    kk: "Жабылған",
    en: "Closed",
  },
  Отменён: {
    kk: "Тоқтатылған",
    en: "Cancelled",
  },
  Доработка: {
    kk: "Қайта өңдеу",
    en: "Rework",
  },
  Аварийный: {
    kk: "Авариялық",
    en: "Emergency",
  },
  Обычный: {
    kk: "Қалыпты",
    en: "Normal",
  },
  Плановый: {
    kk: "Жоспарлы",
    en: "Planned",
  },
  Внеплановый: {
    kk: "Жоспардан тыс",
    en: "Unplanned",
  },
  "Наряд выдан": {
    kk: "Наряд берілді",
    en: "Work order issued",
  },
  "Наряд принят": {
    kk: "Наряд қабылданды",
    en: "Work order accepted",
  },
  "Добавлен в очередь": {
    kk: "Кезекке қосылды",
    en: "Added to queue",
  },
  "Отказ от наряда": {
    kk: "Нарядтан бас тарту",
    en: "Work order rejected",
  },
  "Работа начата": {
    kk: "Жұмыс басталды",
    en: "Work started",
  },
  "Работа возобновлена": {
    kk: "Жұмыс жалғастырылды",
    en: "Work resumed",
  },
  "Работа приостановлена": {
    kk: "Жұмыс кідіртілді",
    en: "Work paused",
  },
  "Работа сдана": {
    kk: "Жұмыс тапсырылды",
    en: "Work submitted",
  },
  "Проверка начата": {
    kk: "Тексеру басталды",
    en: "Review started",
  },
  "Возврат на доработку": {
    kk: "Қайта өңдеуге қайтару",
    en: "Returned for rework",
  },
  "Доработка назначена": {
    kk: "Қайта өңдеу тағайындалды",
    en: "Rework assigned",
  },
  "Наряд закрыт": {
    kk: "Наряд жабылды",
    en: "Work order closed",
  },
  "Наряд закрыт вручную": {
    kk: "Наряд қолмен жабылды",
    en: "Work order manually closed",
  },
  "Приоритет изменён": {
    kk: "Басымдық өзгерді",
    en: "Priority changed",
  },
  "Исполнитель переназначен": {
    kk: "Орындаушы қайта тағайындалды",
    en: "Technician reassigned",
  },
  Комментарий: {
    kk: "Түсініктеме",
    en: "Comment",
  },
  "Оценка отказа": {
    kk: "Бас тартуды бағалау",
    en: "Rejection assessment",
  },
  "Наряд больше недоступен.": {
    kk: "Наряд енді қолжетімсіз.",
    en: "This work order is no longer available.",
  },
  "Журнал превышает предел 2 000 событий. Сузьте период в отчёте или обратитесь к администратору.": {
    kk: "Журналда 2 000-нан астам оқиға бар. Есеп кезеңін қысқартыңыз немесе әкімшіге хабарласыңыз.",
    en: "The log exceeds 2,000 events. Narrow the report period or contact your administrator.",
  },
  "Не удалось загрузить карточку.": {
    kk: "Карточка жүктелмеді.",
    en: "Could not load the work order.",
  },
  "Наряд изменился. Проверьте обновлённые данные и повторите действие.": {
    kk: "Наряд өзгерді. Жаңартылған деректерді тексеріп, әрекетті қайталаңыз.",
    en: "The work order has changed. Check the updated data and retry.",
  },
  "Сессия завершена.": {
    kk: "Сеанс аяқталды.",
    en: "Session ended.",
  },
  "Действие не выполнено.": {
    kk: "Әрекет орындалмады.",
    en: "Action failed.",
  },
  "Укажите причину отсутствия материалов.": {
    kk: "Материалдар қолданылмау себебін көрсетіңіз.",
    en: "Explain why no materials were used.",
  },
  "Добавьте материал и положительное количество либо отметьте отсутствие материалов.": {
    kk: "Материал мен оң санды енгізіңіз немесе материалдар қолданылмағанын белгілеңіз.",
    en: "Add a material and a positive quantity, or mark that no materials were used.",
  },
  "Не удалось скачать отчёт Excel.": {
    kk: "Excel есебі жүктелмеді.",
    en: "Could not download the Excel report.",
  },
  "Простой не сохранён. Проверьте время и причину.": {
    kk: "Бос тұру сақталмады. Уақыт пен себепті тексеріңіз.",
    en: "Downtime was not saved. Check the times and reason.",
  },
  "Оценка отказа не сохранена.": {
    kk: "Бас тарту бағасы сақталмады.",
    en: "Rejection assessment was not saved.",
  },
  "Карточка наряда": {
    kk: "Наряд карточкасы",
    en: "Work order details",
  },
  "Ознакомьтесь с заданием и примите наряд. Если заняты, поставьте его в очередь.": {
    kk: "Тапсырмамен танысып, нарядты қабылдаңыз. Бос болмасаңыз, кезекке қойыңыз.",
    en: "Read the task and accept the work order. If you are busy, add it to your queue.",
  },
  "Когда будете готовы приступить, нажмите «Начать работу».": {
    kk: "Дайын болғанда «Жұмысты бастау» түймесін басыңыз.",
    en: "Select Start work when you are ready.",
  },
  "Наряд в очереди. Начните его, когда завершите текущую работу.": {
    kk: "Наряд кезекте. Ағымдағы жұмысты аяқтаған соң бастаңыз.",
    en: "This work order is queued. Start it after finishing your current work.",
  },
  "Опишите выполненные работы, добавьте материалы и фото, затем сдайте наряд мастеру.": {
    kk: "Орындалған жұмысты сипаттап, материалдар мен фото қосыңыз, кейін шеберге тапсырыңыз.",
    en: "Describe the work, add materials and photos, then submit to the supervisor.",
  },
  "Работа приостановлена. Нажмите «Возобновить», чтобы продолжить.": {
    kk: "Жұмыс кідіртілген. Жалғастыру үшін «Жалғастыру» түймесін басыңыз.",
    en: "Work is paused. Select Resume to continue.",
  },
  "Прочитайте замечания мастера ниже и начните доработку.": {
    kk: "Төмендегі шебер ескертулерін оқып, қайта өңдеуді бастаңыз.",
    en: "Read the supervisor's comments below and start rework.",
  },
  "Работа сдана. Ожидайте решения мастера — повторная сдача не нужна.": {
    kk: "Жұмыс тапсырылды. Шебер шешімін күтіңіз — қайта тапсыру қажет емес.",
    en: "Work submitted. Wait for the supervisor's decision; do not submit again.",
  },
  "Наряд закрыт. Здесь сохранены отчёт, фотографии и история работы.": {
    kk: "Наряд жабылған. Есеп, фотолар және жұмыс тарихы осында сақталған.",
    en: "Work order closed. The report, photos and history are preserved here.",
  },
  "Наряд отменён. Выполнять это задание больше не нужно.": {
    kk: "Наряд тоқтатылған. Бұл тапсырманы орындау қажет емес.",
    en: "Work order cancelled. This task no longer needs to be performed.",
  },
  "Отказ передан мастеру. Дальнейшее назначение определяет мастер.": {
    kk: "Бас тарту шеберге жіберілді. Одан кейінгі тағайындауды шебер шешеді.",
    en: "Rejection sent to the supervisor, who will decide the next assignment.",
  },
  "Изучите отчёт исполнителя и проверку, затем примите ремонт или верните на доработку.": {
    kk: "Орындаушы есебі мен тексеруді қарап, жөндеуді қабылдаңыз немесе қайта өңдеуге қайтарыңыз.",
    en: "Read the technician's report and review, then accept the repair or request rework.",
  },
  "Работа сдана. Дождитесь результатов проверки перед решением по ремонту.": {
    kk: "Жұмыс тапсырылды. Жөндеу туралы шешім қабылдамас бұрын тексеру нәтижесін күтіңіз.",
    en: "Work submitted. Wait for the review before making a repair decision.",
  },
  "Исполнитель отказался от наряда. Изучите причину и назначьте дальнейшие действия.": {
    kk: "Орындаушы нарядтан бас тартты. Себебін қарап, келесі әрекеттерді тағайындаңыз.",
    en: "The technician rejected the order. Review the reason and decide the next steps.",
  },
  "Наряд завершён. Отчёт и история доступны для просмотра.": {
    kk: "Наряд аяқталған. Есеп пен тарихты көруге болады.",
    en: "Work order finished. The report and history are available.",
  },
  "Наряд назначен исполнителю. При необходимости уточните приоритет или назначение.": {
    kk: "Наряд орындаушыға тағайындалған. Қажет болса, басымдықты не тағайындауды өзгертіңіз.",
    en: "Work order assigned. Adjust priority or assignment if needed.",
  },
  "Режим просмотра. Изменять наряд и принимать ремонт может выдавший его мастер.": {
    kk: "Көру режимі. Нарядты өзгерту және жөндеуді қабылдау тек оны берген шеберге рұқсат.",
    en: "Read-only mode. Only the issuing supervisor can change this order and accept the repair.",
  },
  "Готовим…": {
    kk: "Дайындалуда…",
    en: "Preparing…",
  },
  "Отчёт Excel": {
    kk: "Excel есебі",
    en: "Excel report",
  },
  Итог: {
    kk: "Қорытынды",
    en: "Outcome",
  },
  "Что дальше": {
    kk: "Келесі қадам",
    en: "Next step",
  },
  "К действиям": {
    kk: "Әрекеттерге өту",
    en: "Go to actions",
  },
  "Вид работ": {
    kk: "Жұмыс түрі",
    en: "Work type",
  },
  Приоритет: {
    kk: "Басымдық",
    en: "Priority",
  },
  "Попытка ремонта": {
    kk: "Жөндеу әрекеті",
    en: "Repair attempt",
  },
  Начат: {
    kk: "Басталған",
    en: "Started",
  },
  "Последний комментарий": {
    kk: "Соңғы түсініктеме",
    en: "Latest comment",
  },
  "Отчёт исполнителя": {
    kk: "Орындаушы есебі",
    en: "Technician report",
  },
  "Неисправность:": {
    kk: "Ақау:",
    en: "Fault:",
  },
  "Не указана": {
    kk: "Көрсетілмеген",
    en: "Not specified",
  },
  "Без расхода материалов:": {
    kk: "Материалдарсыз:",
    en: "No materials used:",
  },
  "Что исправить": {
    kk: "Нені түзету керек",
    en: "What to fix",
  },
  "Свяжитесь с мастером, чтобы уточнить замечания перед продолжением работы.": {
    kk: "Жұмысты жалғастырмас бұрын ескертулерді нақтылау үшін шеберге хабарласыңыз.",
    en: "Contact the supervisor to clarify the comments before continuing.",
  },
  "Действия исполнителя": {
    kk: "Орындаушы әрекеттері",
    en: "Technician actions",
  },
  "Действие не выполнено": {
    kk: "Әрекет орындалмады",
    en: "Action failed",
  },
  "Ожидаем подтверждения": {
    kk: "Растау күтілуде",
    en: "Awaiting confirmation",
  },
  "К очереди отправки": {
    kk: "Жіберу кезегіне өту",
    en: "Go to pending uploads",
  },
  "Наряд в работе. Выполните задание, затем добавьте фото, опишите результат и сдайте работу мастеру.": {
    kk: "Наряд орындалуда. Тапсырманы орындап, фото қосыңыз, нәтижені сипаттап, шеберге тапсырыңыз.",
    en: "Work is in progress. Complete the task, add photos, describe the result and submit to the supervisor.",
  },
  "Заполнить отчёт": {
    kk: "Есепті толтыру",
    en: "Complete report",
  },
  Принять: {
    kk: "Қабылдау",
    en: "Accept",
  },
  "В очередь": {
    kk: "Кезекке қою",
    en: "Add to queue",
  },
  "Начинаем…": {
    kk: "Басталуда…",
    en: "Starting…",
  },
  "Начать работу": {
    kk: "Жұмысты бастау",
    en: "Start work",
  },
  Возобновить: {
    kk: "Жалғастыру",
    en: "Resume",
  },
  "Не могу выполнить наряд": {
    kk: "Нарядты орындай алмаймын",
    en: "I cannot complete this work order",
  },
  "Причина отказа": {
    kk: "Бас тарту себебі",
    en: "Rejection reason",
  },
  Отказаться: {
    kk: "Бас тарту",
    en: "Reject",
  },
  "Приостановить работу": {
    kk: "Жұмысты кідірту",
    en: "Pause work",
  },
  "Причина паузы": {
    kk: "Үзіліс себебі",
    en: "Pause reason",
  },
  "Поставить на паузу": {
    kk: "Үзіліске қою",
    en: "Pause",
  },
  "Фото после": {
    kk: "Кейінгі фото",
    en: "After photos",
  },
  "Сдать работу": {
    kk: "Жұмысты тапсыру",
    en: "Submit work",
  },
  "Что выполнено": {
    kk: "Не орындалды",
    en: "Work completed",
  },
  "Шифр неисправности": {
    kk: "Ақау коды",
    en: "Fault code",
  },
  "Выберите шифр": {
    kk: "Кодты таңдаңыз",
    en: "Select code",
  },
  "Материалы не использовались": {
    kk: "Материалдар қолданылмады",
    en: "No materials used",
  },
  "Причина отсутствия материалов": {
    kk: "Материалдар қолданылмау себебі",
    en: "Reason for no materials",
  },
  "Выберите материал": {
    kk: "Материалды таңдаңыз",
    en: "Select material",
  },
  "Удалить строку": {
    kk: "Жолды жою",
    en: "Remove row",
  },
  "Добавить материал": {
    kk: "Материал қосу",
    en: "Add material",
  },
  "Сдать наряд": {
    kk: "Нарядты тапсыру",
    en: "Submit work order",
  },
  "Учёт простоя": {
    kk: "Бос тұру есебі",
    en: "Downtime tracking",
  },
  "Последняя запись простоя аннулирована.": {
    kk: "Бос тұрудың соңғы жазбасы жойылған.",
    en: "The latest downtime record was voided.",
  },
  "Последняя запись: {0}": {
    kk: "Соңғы жазба: {0}",
    en: "Latest record: {0}",
  },
  "Интервал вносится мастером и не выводится из статуса наряда.": {
    kk: "Аралықты шебер енгізеді; наряд күйінен есептелмейді.",
    en: "The supervisor records the interval; it is not inferred from the order status.",
  },
  "Начало простоя": {
    kk: "Бос тұру басталуы",
    en: "Downtime start",
  },
  "Окончание (можно оставить открытым)": {
    kk: "Аяқталуы (ашық қалдыруға болады)",
    en: "End (may be left open)",
  },
  "Причина записи или исправления": {
    kk: "Жазу не түзету себебі",
    en: "Reason for recording or correction",
  },
  "Зафиксировать простой": {
    kk: "Бос тұруды тіркеу",
    en: "Record downtime",
  },
  "Аннулировать последнюю запись": {
    kk: "Соңғы жазбаны жою",
    en: "Void latest record",
  },
  "Решение добавляется к исходному отказу и не меняет статус наряда.": {
    kk: "Шешім бастапқы бас тартуға қосылады және наряд күйін өзгертпейді.",
    en: "The decision is added to the original rejection and does not change the order status.",
  },
  "Выберите отказ…": {
    kk: "Бас тартуды таңдаңыз…",
    en: "Select rejection…",
  },
  "без причины": {
    kk: "себепсіз",
    en: "no reason",
  },
  Оценка: {
    kk: "Баға",
    en: "Assessment",
  },
  Обоснован: {
    kk: "Негізді",
    en: "Justified",
  },
  Необоснован: {
    kk: "Негізсіз",
    en: "Unjustified",
  },
  "Основание решения": {
    kk: "Шешім негіздемесі",
    en: "Decision rationale",
  },
  "Сохранить оценку": {
    kk: "Бағаны сақтау",
    en: "Save assessment",
  },
  "Управление мастера": {
    kk: "Шебер басқаруы",
    en: "Supervisor controls",
  },
  "Каждое действие оформляется отдельно: причина относится только к выбранному изменению.": {
    kk: "Әр әрекет бөлек тіркеледі: себеп тек таңдалған өзгеріске қатысты.",
    en: "Each action is recorded separately; its reason applies only to that change.",
  },
  "Решение мастера": {
    kk: "Шебер шешімі",
    en: "Supervisor decision",
  },
  "Вывод и оценка ИИ предварительные. Закрытие или возврат — решение мастера; итоговая оценка берётся из вашей оценки либо из действительной рекомендации ИИ.":
    {
      kk: "ЖИ қорытындысы мен бағасы алдын ала берілген. Жабу не қайтару шешімін шебер қабылдайды; қорытынды баға сіздің бағаңыздан немесе жарамды ЖИ ұсынымынан алынады.",
      en: "AI findings and scores are preliminary. The supervisor decides whether to close or return the order; the final score uses your assessment or a valid AI recommendation.",
    },
  "Рекомендация ИИ не меняет статус наряда. Примите работу или верните её на доработку: решение и причина будут записаны от вашего имени.":
    {
      kk: "ЖИ ұсынымы нарядтың күйін өзгертпейді. Жұмысты қабылдаңыз немесе пысықтауға қайтарыңыз: шешім мен себеп сіздің атыңыздан жазылады.",
      en: "The AI recommendation does not change the work order status. Accept the work or return it for rework; your decision and reason will be recorded.",
    },
  "Причина решения": {
    kk: "Шешім себебі",
    en: "Decision reason",
  },
  "Оценка мастера (необязательно)": {
    kk: "Шебер бағасы (міндетті емес)",
    en: "Supervisor score (optional)",
  },
  "Оценка мастера (обязательно при принятии)": {
    kk: "Шебер бағасы (қабылдағанда міндетті)",
    en: "Supervisor score (required to accept)",
  },
  "Вернуть на доработку": {
    kk: "Қайта өңдеуге қайтару",
    en: "Return for rework",
  },
  "Закрыть с оценкой мастера": {
    kk: "Шебер бағасымен жабу",
    en: "Close with supervisor score",
  },
  "Принять рекомендацию ИИ и закрыть": {
    kk: "ЖИ ұсынымын қабылдап жабу",
    en: "Accept AI recommendation and close",
  },
  "Закрыть вручную": {
    kk: "Қолмен жабу",
    en: "Close manually",
  },
  "Принять работу": {
    kk: "Жұмысты қабылдау",
    en: "Accept work",
  },
  "Фото до ремонта": {
    kk: "Жөндеуге дейінгі фото",
    en: "Photos before repair",
  },
  "Необязательно. Добавьте исходное состояние оборудования до начала работ.": {
    kk: "Міндетті емес. Жұмыс басталғанға дейінгі жабдық күйін қосыңыз.",
    en: "Optional. Add the equipment condition before work starts.",
  },
  Фотография: {
    kk: "Фотосурет",
    en: "Photo",
  },
  "Изменить приоритет": {
    kk: "Басымдықты өзгерту",
    en: "Change priority",
  },
  "Новый приоритет": {
    kk: "Жаңа басымдық",
    en: "New priority",
  },
  "Выберите приоритет…": {
    kk: "Басымдықты таңдаңыз…",
    en: "Select priority…",
  },
  "Причина изменения приоритета": {
    kk: "Басымдықты өзгерту себебі",
    en: "Reason for priority change",
  },
  "Сохранить приоритет": {
    kk: "Басымдықты сақтау",
    en: "Save priority",
  },
  "Переназначить исполнителя": {
    kk: "Орындаушыны қайта тағайындау",
    en: "Reassign technician",
  },
  "Новый исполнитель": {
    kk: "Жаңа орындаушы",
    en: "New technician",
  },
  "Выберите исполнителя…": {
    kk: "Орындаушыны таңдаңыз…",
    en: "Select technician…",
  },
  "Причина переназначения": {
    kk: "Қайта тағайындау себебі",
    en: "Reassignment reason",
  },
  Переназначить: {
    kk: "Қайта тағайындау",
    en: "Reassign",
  },
  "Отменить наряд": {
    kk: "Нарядты тоқтату",
    en: "Cancel work order",
  },
  "Отменённый наряд нельзя вернуть в работу.": {
    kk: "Тоқтатылған нарядты жұмысқа қайтаруға болмайды.",
    en: "A cancelled order cannot be reopened.",
  },
  "Причина отмены": {
    kk: "Тоқтату себебі",
    en: "Cancellation reason",
  },
  "Я понимаю, что наряд будет отменён": {
    kk: "Нарядтың тоқтатылатынын түсінемін",
    en: "I understand that the work order will be cancelled",
  },
  "Текст комментария": {
    kk: "Түсініктеме мәтіні",
    en: "Comment text",
  },
  "Добавить комментарий": {
    kk: "Түсініктеме қосу",
    en: "Add comment",
  },
  "Материалы текущей сдачи и фотографии": {
    kk: "Ағымдағы тапсыру материалдары мен фотолар",
    en: "Current submission materials and photos",
  },
  "Материалы не зафиксированы.": {
    kk: "Материалдар тіркелмеген.",
    en: "No materials recorded.",
  },
  Журнал: {
    kk: "Журнал",
    en: "Log",
  },
  "Показать историю действий": {
    kk: "Әрекеттер тарихын көрсету",
    en: "Show action history",
  },
  Сотрудник: {
    kk: "Қызметкер",
    en: "Employee",
  },
  "Простой аннулирован": {
    kk: "Бос тұру жазбасы жойылды",
    en: "Downtime voided",
  },
  "Простой зафиксирован": {
    kk: "Бос тұру тіркелді",
    en: "Downtime recorded",
  },
  ": с {0}": {
    kk: ": {0} бастап",
    en: ": from {0}",
  },
  " по {0}": {
    kk: " {0} дейін",
    en: " to {0}",
  },
  "Отказ:": {
    kk: "Бас тарту:",
    en: "Rejection:",
  },
  обоснован: {
    kk: "негізді",
    en: "justified",
  },
  необоснован: {
    kk: "негізсіз",
    en: "unjustified",
  },
  "Фото не загружено. Проверьте тип, размер, соединение и доступ.": {
    kk: "Фото жүктелмеді. Түрін, өлшемін, байланысты және қолжетімділікті тексеріңіз.",
    en: "Photo upload failed. Check file type, size, connection and access.",
  },
  "Подготовка загрузки фото": {
    kk: "Фото жүктеуге дайындық",
    en: "Preparing photo upload",
  },
  "Предпросмотр: {0}": {
    kk: "Алдын ала қарау: {0}",
    en: "Preview: {0}",
  },
  МБ: {
    kk: "МБ",
    en: "MB",
  },
  "Проведите по фотографии, чтобы скрыть участок": {
    kk: "Аймақты жасыру үшін фото үстінен жүргізіңіз",
    en: "Drag over the photo to hide an area",
  },
  "Предпросмотр для скрытия участков": {
    kk: "Аймақтарды жасыру көрінісі",
    en: "Area redaction preview",
  },
  "Предпросмотр для ручного скрытия данных": {
    kk: "Деректерді қолмен жасыру көрінісі",
    en: "Manual data redaction preview",
  },
  "Завершить скрытие": {
    kk: "Жасыруды аяқтау",
    en: "Finish redacting",
  },
  "Скрыть личные данные": {
    kk: "Жеке деректерді жасыру",
    en: "Hide personal data",
  },
  "Отменить последнее": {
    kk: "Соңғысын болдырмау",
    en: "Undo last",
  },
  "Очистить скрытия": {
    kk: "Жасыруларды тазалау",
    en: "Clear redactions",
  },
  "Скрытие ручное: проведите по участку на фото. После загрузки будет сохранён JPEG с чёрными прямоугольниками, исходный файл не отправляется.":
    {
      kk: "Қолмен жасыру: фото аймағының үстінен жүргізіңіз. Жүктелген JPEG файлында қара тіктөртбұрыштар болады, бастапқы файл жіберілмейді.",
      en: "Manual redaction: drag over an area. Only the JPEG with black rectangles is uploaded; the original is not sent.",
    },
  "Ввести область скрытия точно": {
    kk: "Жасыру аймағын дәл енгізу",
    en: "Enter exact redaction area",
  },
  "Координаты в процентах от левого верхнего угла изображения.": {
    kk: "Координаттар кескіннің сол жақ жоғарғы бұрышынан пайызбен берілген.",
    en: "Coordinates are percentages from the top-left corner of the image.",
  },
  Ширина: {
    kk: "Ені",
    en: "Width",
  },
  Высота: {
    kk: "Биіктігі",
    en: "Height",
  },
  "Добавить область": {
    kk: "Аймақ қосу",
    en: "Add area",
  },
  "На фото только оборудование, личные и конфиденциальные данные скрыты. Разрешить анализ ИИ.": {
    kk: "Фотода тек жабдық бар, жеке және құпия деректер жасырылған. ЖИ талдауына рұқсат беремін.",
    en: "The photo shows equipment only; personal and confidential data are hidden. Allow AI analysis.",
  },
  "Без этой отметки фото сохранится во внутреннем наряде и не будет передано внешнему ИИ. Отметка не заменяет проверку кадра человеком.":
    {
      kk: "Белгіленбесе, фото ішкі нарядта сақталып, сыртқы ЖИ-ге жіберілмейді. Бұл белгі адамның фотоны тексеруін алмастырмайды.",
      en: "Without this selection, the photo stays in the internal order and is not sent to external AI. This does not replace human inspection.",
    },
  "Загружаем…": {
    kk: "Жүктелуде…",
    en: "Uploading…",
  },
  "Загрузить фото": {
    kk: "Фото жүктеу",
    en: "Upload photo",
  },
  "До ремонта": {
    kk: "Жөндеуге дейін",
    en: "Before repair",
  },
  "После ремонта": {
    kk: "Жөндеуден кейін",
    en: "After repair",
  },
  "Загружаем фото…": {
    kk: "Фотолар жүктелуде…",
    en: "Loading photos…",
  },
  "Фото не загружены.": {
    kk: "Фотолар жүктелмеген.",
    en: "No photos uploaded.",
  },
  "Исходные фото до ремонта": {
    kk: "Жөндеуге дейінгі бастапқы фотолар",
    en: "Original photos before repair",
  },
  "Фото после: текущая попытка {0}": {
    kk: "Кейінгі фото: ағымдағы әрекет {0}",
    en: "After photos: current attempt {0}",
  },
  "Фото предыдущих попыток (": {
    kk: "Алдыңғы әрекеттер фотолары (",
    en: "Photos from previous attempts (",
  },
  "Предыдущие доказательства": {
    kk: "Алдыңғы дәлелдер",
    en: "Previous evidence",
  },
  "МОЯ СМЕНА": {
    kk: "МЕНІҢ АУЫСЫМЫМ",
    en: "MY SHIFT",
  },
  "Мои наряды": {
    kk: "Менің нарядтарым",
    en: "My work orders",
  },
  "Откройте наряд, чтобы принять его, начать работу или завершить выполнение.": {
    kk: "Нарядты қабылдау, жұмысты бастау не аяқтау үшін оны ашыңыз.",
    en: "Open an order to accept it, start work or complete it.",
  },
  "УПРАВЛЕНИЕ СМЕНОЙ": {
    kk: "АУЫСЫМДЫ БАСҚАРУ",
    en: "SHIFT MANAGEMENT",
  },
  "Наряды участка": {
    kk: "Учаске нарядтары",
    en: "Area work orders",
  },
  "Выдавайте наряды и контролируйте ход работ по участку.": {
    kk: "Нарядтар беріп, учаскедегі жұмыс барысын бақылаңыз.",
    en: "Issue work orders and monitor progress in your area.",
  },
  "КОНТРОЛЬ РАБОТ": {
    kk: "ЖҰМЫСТЫ БАҚЫЛАУ",
    en: "WORK MONITORING",
  },
  "Просматривайте ход работ и переключайте список по текущей задаче.": {
    kk: "Жұмыс барысын қарап, тізімді ағымдағы міндетке сай ауыстырыңыз.",
    en: "Monitor progress and switch the list to match your current task.",
  },
  "ПРОСМОТР РАБОТ": {
    kk: "ЖҰМЫСТАРДЫ КӨРУ",
    en: "WORK OVERVIEW",
  },
  "Просматривайте текущий список нарядов.": {
    kk: "Нарядтардың ағымдағы тізімін қараңыз.",
    en: "View the current work order list.",
  },
  "Выдать наряд": {
    kk: "Наряд беру",
    en: "Issue work order",
  },
  "Сводка очереди": {
    kk: "Кезек жиынтығы",
    en: "Queue summary",
  },
  "ТРЕБУЮТ ВНИМАНИЯ": {
    kk: "НАЗАР АУДАРУДЫ ҚАЖЕТ ЕТЕДІ",
    en: "NEEDS ATTENTION",
  },
  "Показаны срочные": {
    kk: "Шұғылдары көрсетілген",
    en: "Showing urgent orders",
  },
  "Сроки и высокий приоритет": {
    kk: "Мерзімдер және жоғары басымдық",
    en: "Deadlines and high priority",
  },
  Выполняются: {
    kk: "Орындалып жатыр",
    en: "In progress",
  },
  "В выборке": {
    kk: "Іріктемеде",
    en: "In selection",
  },
  "Список нарядов": {
    kk: "Нарядтар тізімі",
    en: "Work order list",
  },
  История: {
    kk: "Тарих",
    en: "History",
  },
  "Поиск наряда": {
    kk: "Наряд іздеу",
    en: "Search work orders",
  },
  "Номер, задача или оборудование": {
    kk: "Нөмір, тапсырма немесе жабдық",
    en: "Number, task or equipment",
  },
  "Фильтры: выбрано ": {
    kk: "Сүзгілер: таңдалғаны ",
    en: "Filters selected: ",
  },
  "Сбросить фильтры": {
    kk: "Сүзгілерді тазалау",
    en: "Clear filters",
  },
  Все: {
    kk: "Барлығы",
    en: "All",
  },
  "Все участки": {
    kk: "Барлық учаскелер",
    en: "All areas",
  },
  "Всё оборудование": {
    kk: "Барлық жабдық",
    en: "All equipment",
  },
  "Все доступные мастера": {
    kk: "Барлық қолжетімді шеберлер",
    en: "All available supervisors",
  },
  "Все исполнители": {
    kk: "Барлық орындаушылар",
    en: "All technicians",
  },
  "Только просроченные": {
    kk: "Тек мерзімі өткендер",
    en: "Overdue only",
  },
  Найдено: {
    kk: "Табылды",
    en: "Found",
  },
  "В списке": {
    kk: "Тізімде",
    en: "Listed",
  },
  " из {0}": {
    kk: " / {0}",
    en: " of {0}",
  },
  "Обновляем наряды…": {
    kk: "Нарядтар жаңартылуда…",
    en: "Refreshing work orders…",
  },
  "История пока пуста": {
    kk: "Тарих әзірге бос",
    en: "No history yet",
  },
  "Нет текущих нарядов": {
    kk: "Ағымдағы нарядтар жоқ",
    en: "No current work orders",
  },
  "По выбранным условиям нарядов нет": {
    kk: "Таңдалған шарттарға сәйкес нарядтар жоқ",
    en: "No work orders match these filters",
  },
  "Здесь появятся закрытые и отменённые наряды.": {
    kk: "Мұнда жабылған және тоқтатылған нарядтар пайда болады.",
    en: "Closed and cancelled orders will appear here.",
  },
  "Создайте первый наряд, когда появится работа на участке.": {
    kk: "Учаскеде жұмыс пайда болғанда алғашқы нарядты жасаңыз.",
    en: "Create the first order when work is needed in your area.",
  },
  "Новые наряды появятся здесь после выдачи мастером.": {
    kk: "Шебер берген жаңа нарядтар мұнда пайда болады.",
    en: "New work orders will appear here when issued by the supervisor.",
  },
  "Сбросьте дополнительные фильтры или выберите другой список нарядов.": {
    kk: "Қосымша сүзгілерді тазалаңыз немесе басқа нарядтар тізімін таңдаңыз.",
    en: "Clear additional filters or select another work order list.",
  },
  "Переключитесь между текущими нарядами и историей.": {
    kk: "Ағымдағы нарядтар мен тарих арасында ауысыңыз.",
    en: "Switch between current orders and history.",
  },
  Назад: {
    kk: "Артқа",
    en: "Back",
  },
  Далее: {
    kk: "Келесі",
    en: "Next",
  },
  "К выдаче": {
    kk: "Беруге дайын",
    en: "To issue",
  },
  "На проверке": {
    kk: "Тексерілуде",
    en: "Under review",
  },
  "Доработка и отказы": {
    kk: "Қайта өңдеу және бас тартулар",
    en: "Rework and rejections",
  },
  Закрытые: {
    kk: "Жабылғандар",
    en: "Closed",
  },
  Отменённые: {
    kk: "Тоқтатылғандар",
    en: "Cancelled",
  },
  "Доска нарядов": {
    kk: "Нарядтар тақтасы",
    en: "Work order board",
  },
  "Нет нарядов": {
    kk: "Нарядтар жоқ",
    en: "No work orders",
  },
  "Открыть наряд {0}": {
    kk: "{0} нарядын ашу",
    en: "Open work order {0}",
  },
  "История {0}": {
    kk: "{0} тарихы",
    en: "History of {0}",
  },
  "Укажите срок выполнения.": {
    kk: "Орындау мерзімін көрсетіңіз.",
    en: "Set a completion deadline.",
  },
  "Наряд не создан. Проверьте обязательные поля и доступ участка.": {
    kk: "Наряд жасалмады. Міндетті өрістер мен учаске рұқсатын тексеріңіз.",
    en: "Could not create the order. Check required fields and area access.",
  },
  "Шаги выдачи наряда": {
    kk: "Наряд беру қадамдары",
    en: "Steps to issue a work order",
  },
  "Где работа": {
    kk: "Жұмыс орны",
    en: "Where",
  },
  Кому: {
    kk: "Кімге",
    en: "Who",
  },
  "Что сделать": {
    kk: "Не істеу керек",
    en: "What to do",
  },
  "Выберите оборудование, исполнителя, описание и реальный срок. Система не подставляет срок сама.": {
    kk: "Жабдықты, орындаушыны, сипаттаманы және нақты мерзімді таңдаңыз. Жүйе мерзімді өзі қоймайды.",
    en: "Select equipment, technician, description and a realistic deadline. The system does not set a deadline automatically.",
  },
  "Выберите оборудование": {
    kk: "Жабдықты таңдаңыз",
    en: "Select equipment",
  },
  "Выберите исполнителя": {
    kk: "Орындаушыны таңдаңыз",
    en: "Select technician",
  },
  "разряд ·": {
    kk: "разряд ·",
    en: "grade ·",
  },
  "Не на смене": {
    kk: "Ауысымда емес",
    en: "Off shift",
  },
  "В работе {0}": {
    kk: "Жұмыста {0}",
    en: "Working on {0}",
  },
  Свободен: {
    kk: "Бос",
    en: "Available",
  },
  "Ожидает работы": {
    kk: "Жұмыс күтуде",
    en: "Waiting for work",
  },
  " · В очереди {0}": {
    kk: " · Кезекте {0}",
    en: " · Queued: {0}",
  },
  "Подсказка по загрузке": {
    kk: "Жүктеме бойынша кеңес",
    en: "Workload suggestion",
  },
  "ПОДСКАЗКА ПО ЗАГРУЗКЕ": {
    kk: "ЖҮКТЕМЕ БОЙЫНША КЕҢЕС",
    en: "WORKLOAD SUGGESTION",
  },
  "Свободен в смене": {
    kk: "Ауысымда бос",
    en: "Available on shift",
  },
  "В очереди: {0}": {
    kk: "Кезекте: {0}",
    en: "Queued: {0}",
  },
  "Занят, но с наименьшей очередью": {
    kk: "Бос емес, бірақ кезегі ең қысқа",
    en: "Busy, but with the shortest queue",
  },
  " · пауз: {0}": {
    kk: " · үзілістер: {0}",
    en: " · paused: {0}",
  },
  "Выбрать рекомендованного": {
    kk: "Ұсынылғанды таңдау",
    en: "Select suggested technician",
  },
  "Подсказка учитывает смену и текущую загрузку. Допуск к работе проверяет мастер.": {
    kk: "Кеңес ауысым мен ағымдағы жүктемені ескереді. Жұмысқа рұқсатты шебер тексереді.",
    en: "The suggestion considers shift and workload. The supervisor checks work authorization.",
  },
  Описание: {
    kk: "Сипаттама",
    en: "Description",
  },
  Тип: {
    kk: "Түрі",
    en: "Type",
  },
  "Исполнитель предложен по участку и загрузке — проверьте его допуск перед выдачей. Срок задаёт мастер.": {
    kk: "Орындаушы учаске мен жүктеме бойынша ұсынылған — бермес бұрын рұқсатын тексеріңіз. Мерзімді шебер белгілейді.",
    en: "The technician is suggested by area and workload; verify authorization before issuing. The supervisor sets the deadline.",
  },
  "Срок (Asia/Almaty)": {
    kk: "Мерзім (Asia/Almaty)",
    en: "Deadline (Asia/Almaty)",
  },
  "Быстрый выбор срока": {
    kk: "Мерзімді жылдам таңдау",
    en: "Quick deadline selection",
  },
  "Быстрый срок после проверки мастером:": {
    kk: "Шебер тексергеннен кейінгі жылдам мерзім:",
    en: "Quick deadline after supervisor review:",
  },
  "Через 1 час": {
    kk: "1 сағаттан кейін",
    en: "In 1 hour",
  },
  "Через 2 часа": {
    kk: "2 сағаттан кейін",
    en: "In 2 hours",
  },
  "До конца смены": {
    kk: "Ауысым соңына дейін",
    en: "By end of shift",
  },
  "Комментарий для исполнителя": {
    kk: "Орындаушыға түсініктеме",
    en: "Comment for the technician",
  },
  СМЕНА: {
    kk: "АУЫСЫМ",
    en: "SHIFT",
  },
  "Загрузка исполнителей": {
    kk: "Орындаушылар жүктемесі",
    en: "Technician workload",
  },
  "Сводка загрузки": {
    kk: "Жүктеме жиынтығы",
    en: "Workload summary",
  },
  "в смене": {
    kk: "ауысымда",
    en: "on shift",
  },
  заняты: {
    kk: "бос емес",
    en: "busy",
  },
  "в очереди": {
    kk: "кезекте",
    en: "queued",
  },
  разряд: {
    kk: "разряд",
    en: "grade",
  },
  Занят: {
    kk: "Бос емес",
    en: "Busy",
  },
  Очередь: {
    kk: "Кезек",
    en: "Queue",
  },
  "Не в смене": {
    kk: "Ауысымда емес",
    en: "Off shift",
  },
  "В очереди:": {
    kk: "Кезекте:",
    en: "Queued:",
  },
  "Загрузка справочников…": {
    kk: "Анықтамалықтар жүктелуде…",
    en: "Loading directories…",
  },
  Участки: {
    kk: "Учаскелер",
    en: "Areas",
  },
  "{0} активных · зоны обслуживания и выдачи работ": {
    kk: "{0} белсенді · қызмет көрсету және жұмыс беру аймақтары",
    en: "{0} active · service and work assignment areas",
  },
  "{0} активных · инвентарные номера и критичность": {
    kk: "{0} белсенді · түгендеу нөмірлері және маңыздылық",
    en: "{0} active · inventory numbers and criticality",
  },
  "Состав ремонтных групп и назначение сотрудников": {
    kk: "Жөндеу топтарының құрамы мен қызметкерлерді тағайындау",
    en: "Repair teams and employee assignments",
  },
  "Расходники и единицы измерения для отчётов": {
    kk: "Есептерге арналған шығын материалдары мен өлшем бірліктері",
    en: "Consumables and units for reports",
  },
  "Шифры неисправностей": {
    kk: "Ақау кодтары",
    en: "Fault codes",
  },
  "Коды и специализации для сдачи работ": {
    kk: "Жұмысты тапсыру кодтары мен маманданулар",
    en: "Codes and specialties for work submissions",
  },
  "Нормативы времени": {
    kk: "Уақыт нормативтері",
    en: "Time standards",
  },
  "Ориентир по шифру неисправности и типу оборудования": {
    kk: "Ақау коды мен жабдық түрі бойынша бағдар",
    en: "Reference by fault code and equipment type",
  },
  Сотрудники: {
    kk: "Қызметкерлер",
    en: "Employees",
  },
  "Учётные записи и доступы": {
    kk: "Есептік жазбалар мен рұқсаттар",
    en: "Accounts and access",
  },
  "Состав смены и доступность исполнителей": {
    kk: "Ауысым құрамы және орындаушылар қолжетімділігі",
    en: "Shift roster and technician availability",
  },
  "По этим условиям ничего не найдено.": {
    kk: "Бұл шарттарға сәйкес ештеңе табылмады.",
    en: "Nothing matches these filters.",
  },
  "Измените поиск или сбросьте фильтры.": {
    kk: "Іздеуді өзгертіңіз немесе сүзгілерді тазалаңыз.",
    en: "Change the search or clear the filters.",
  },
  Активные: {
    kk: "Белсенді",
    en: "Active",
  },
  Архив: {
    kk: "Мұрағат",
    en: "Archive",
  },
  "Поиск по справочнику": {
    kk: "Анықтамалықтан іздеу",
    en: "Search directory",
  },
  Активна: {
    kk: "Белсенді",
    en: "Active",
  },
  "В архиве": {
    kk: "Мұрағатта",
    en: "Archived",
  },
  "не в смене": {
    kk: "ауысымда емес",
    en: "off shift",
  },
  СПРАВОЧНИКИ: {
    kk: "АНЫҚТАМАЛЫҚТАР",
    en: "DIRECTORIES",
  },
  "КОНТЕКСТ УЧАСТКА": {
    kk: "УЧАСКЕ ДЕРЕКТЕРІ",
    en: "AREA CONTEXT",
  },
  "Справочные данные": {
    kk: "Анықтамалық деректер",
    en: "Reference data",
  },
  Справочники: {
    kk: "Анықтамалықтар",
    en: "Directories",
  },
  "Выберите раздел, чтобы посмотреть сведения и выполнить доступные действия.": {
    kk: "Мәліметтерді көру және қолжетімді әрекеттерді орындау үшін бөлімді таңдаңыз.",
    en: "Select a section to view information and perform available actions.",
  },
  "Разделы справочника": {
    kk: "Анықтамалық бөлімдері",
    en: "Directory sections",
  },
  "Открыть раздел: {0}": {
    kk: "Бөлімді ашу: {0}",
    en: "Open section: {0}",
  },
  "Открыть раздел →": {
    kk: "Бөлімді ашу →",
    en: "Open section →",
  },
  "Открыть раздел": { kk: "Бөлімді ашу", en: "Open section" },
  "Добавить участок": {
    kk: "Учаске қосу",
    en: "Add area",
  },
  "Добавить оборудование": {
    kk: "Жабдық қосу",
    en: "Add equipment",
  },
  "Добавить бригаду": {
    kk: "Бригада қосу",
    en: "Add team",
  },
  "Добавить шифр": {
    kk: "Код қосу",
    en: "Add fault code",
  },
  "Добавить норматив": {
    kk: "Норматив қосу",
    en: "Add time standard",
  },
  "Навигация справочника": {
    kk: "Анықтамалық навигациясы",
    en: "Directory navigation",
  },
  "Все разделы": {
    kk: "Барлық бөлімдер",
    en: "All sections",
  },
  "ТОЛЬКО ЧТЕНИЕ": {
    kk: "ТЕК ОҚУ",
    en: "READ ONLY",
  },
  "Управляйте участками и оборудованием. Архив не используется при выдаче новых нарядов, но сохраняется в истории.":
    {
      kk: "Учаскелер мен жабдықты басқарыңыз. Мұрағат жаңа нарядтарға қолданылмайды, бірақ тарихта сақталады.",
      en: "Manage areas and equipment. Archived records cannot be used for new orders but remain in history.",
    },
  "Список участков": {
    kk: "Учаскелер тізімі",
    en: "Area list",
  },
  "Код, инвентарный номер или название": {
    kk: "Код, түгендеу нөмірі немесе атау",
    en: "Code, inventory number or name",
  },
  "Статус участков": {
    kk: "Учаскелер күйі",
    en: "Area status",
  },
  Изменить: {
    kk: "Өзгерту",
    en: "Edit",
  },
  "Список оборудования": {
    kk: "Жабдық тізімі",
    en: "Equipment list",
  },
  "Участок оборудования": {
    kk: "Жабдық учаскесі",
    en: "Equipment area",
  },
  "Статус оборудования": {
    kk: "Жабдық күйі",
    en: "Equipment status",
  },
  "Участок не найден": {
    kk: "Учаске табылмады",
    en: "Area not found",
  },
  "· критичность": {
    kk: "· маңыздылық",
    en: "· criticality",
  },
  "Список материалов": {
    kk: "Материалдар тізімі",
    en: "Material list",
  },
  "Код или название материала": {
    kk: "Материал коды немесе атауы",
    en: "Material code or name",
  },
  "Ед. изм.:": {
    kk: "Өлшем бірлігі:",
    en: "Unit:",
  },
  "Список шифров неисправностей": {
    kk: "Ақау кодтары тізімі",
    en: "Fault code list",
  },
  "Шифр или название неисправности": {
    kk: "Ақау коды немесе атауы",
    en: "Fault code or name",
  },
  "Специализация:": {
    kk: "Мамандану:",
    en: "Specialty:",
  },
  "Список бригад": {
    kk: "Бригадалар тізімі",
    en: "Team list",
  },
  "Код или название бригады": {
    kk: "Бригада коды немесе атауы",
    en: "Team code or name",
  },
  "Список нормативов времени": {
    kk: "Уақыт нормативтері тізімі",
    en: "Time standard list",
  },
  "Шифр, тип оборудования или минуты": {
    kk: "Код, жабдық түрі немесе минуттар",
    en: "Code, equipment type or minutes",
  },
  "Шифр не найден": {
    kk: "Код табылмады",
    en: "Fault code not found",
  },
  "Норма:": {
    kk: "Норма:",
    en: "Standard:",
  },
  мин: {
    kk: "мин",
    en: "min",
  },
  "Имя, роль или смена": {
    kk: "Аты-жөні, рөл немесе ауысым",
    en: "Name, role or shift",
  },
  "В смене": {
    kk: "Ауысымда",
    en: "On shift",
  },
  "Оборудование с историей нарядов нельзя перенести на другой участок.": {
    kk: "Нарядтар тарихы бар жабдықты басқа учаскеге ауыстыруға болмайды.",
    en: "Equipment with work order history cannot be moved to another area.",
  },
  "Такой код уже есть или ссылка недействительна.": {
    kk: "Мұндай код бар немесе сілтеме жарамсыз.",
    en: "This code already exists or the reference is invalid.",
  },
  "Не удалось сохранить изменения.": {
    kk: "Өзгерістер сақталмады.",
    en: "Could not save changes.",
  },
  "{0} нельзя архивировать: есть незавершённые наряды. Завершите или отмените их, затем повторите.": {
    kk: "{0} мұрағатталмайды: аяқталмаған нарядтар бар. Алдымен оларды аяқтаңыз не тоқтатыңыз.",
    en: "Cannot archive {0}: unfinished work orders exist. Complete or cancel them, then retry.",
  },
  "Не удалось изменить статус записи.": {
    kk: "Жазба күйі өзгертілмеді.",
    en: "Could not change the record status.",
  },
  Добавить: {
    kk: "Қосу",
    en: "Add",
  },
  участок: {
    kk: "учаске",
    en: "area",
  },
  оборудование: {
    kk: "жабдық",
    en: "equipment",
  },
  Код: {
    kk: "Код",
    en: "Code",
  },
  Название: {
    kk: "Атау",
    en: "Name",
  },
  "Инвентарный номер": {
    kk: "Түгендеу нөмірі",
    en: "Inventory number",
  },
  Критичность: {
    kk: "Маңыздылық",
    en: "Criticality",
  },
  Сохранить: {
    kk: "Сақтау",
    en: "Save",
  },
  "Статус записи": {
    kk: "Жазба күйі",
    en: "Record status",
  },
  Архивирование: {
    kk: "Мұрағаттау",
    en: "Archiving",
  },
  Восстановление: {
    kk: "Қалпына келтіру",
    en: "Restoring",
  },
  "Архив не участвует в выдаче новых нарядов. История останется доступной.": {
    kk: "Мұрағат жаңа нарядтар беруге қолданылмайды. Тарих қолжетімді болып қалады.",
    en: "Archived records are not used for new orders. History remains available.",
  },
  "Восстановленная запись снова доступна при выдаче нарядов.": {
    kk: "Қалпына келтірілген жазба қайтадан наряд беруге қолжетімді.",
    en: "Restored records can be used for new orders again.",
  },
  "Архивировать запись": {
    kk: "Жазбаны мұрағаттау",
    en: "Archive record",
  },
  "Подтвердить архивирование": {
    kk: "Мұрағаттауды растау",
    en: "Confirm archiving",
  },
  "Восстановить запись": {
    kk: "Жазбаны қалпына келтіру",
    en: "Restore record",
  },
  бригада: {
    kk: "бригада",
    en: "team",
  },
  материал: {
    kk: "материал",
    en: "material",
  },
  "шифр неисправности": {
    kk: "ақау коды",
    en: "fault code",
  },
  "норматив времени": {
    kk: "уақыт нормативі",
    en: "time standard",
  },
  "Не удалось удалить запись.": {
    kk: "Жазба жойылмады.",
    en: "Could not delete the record.",
  },
  "Запись используется в связанных данных и не может быть удалена. Сохраните историю или сначала измените связанные записи.":
    {
      kk: "Жазба байланысты деректерде қолданылғандықтан жойылмайды. Тарихты сақтаңыз немесе алдымен байланысты жазбаларды өзгертіңіз.",
      en: "This record is used by related data and cannot be deleted. Keep its history or update related records first.",
    },
  "Материал уже использован в нарядах. Чтобы сохранить историю, его код, название и единицу менять нельзя. Добавьте новую позицию.":
    {
      kk: "Материал нарядтарда қолданылған. Тарихты сақтау үшін оның кодын, атауын және бірлігін өзгертуге болмайды. Жаңа позиция қосыңыз.",
      en: "This material has been used in orders. Its code, name and unit cannot change because history must be preserved. Add a new item.",
    },
  "Шифр уже использован в нарядах. Чтобы сохранить историю, добавьте новый шифр вместо изменения существующего.":
    {
      kk: "Код нарядтарда қолданылған. Тарихты сақтау үшін оны өзгертудің орнына жаңа код қосыңыз.",
      en: "This fault code has been used in orders. Add a new code to preserve history.",
    },
  "Такой код уже существует или выбранная ссылка больше недействительна.": {
    kk: "Мұндай код бар немесе таңдалған сілтеме енді жарамсыз.",
    en: "This code already exists or the selected reference is no longer valid.",
  },
  "Запись уже удалена. Обновите список справочника.": {
    kk: "Жазба жойылған. Анықтамалық тізімін жаңартыңыз.",
    en: "This record was already deleted. Refresh the directory.",
  },
  "Тип оборудования": {
    kk: "Жабдық түрі",
    en: "Equipment type",
  },
  "Норма, минут": {
    kk: "Норма, минут",
    en: "Standard, minutes",
  },
  Специализация: {
    kk: "Мамандану",
    en: "Specialty",
  },
  "Единица измерения": {
    kk: "Өлшем бірлігі",
    en: "Unit of measurement",
  },
  "Удаление записи": {
    kk: "Жазбаны жою",
    en: "Record deletion",
  },
  "Удаление доступно только пока запись не используется в нарядах, нормативах или составе бригады.": {
    kk: "Жазба нарядтарда, нормативтерде немесе бригада құрамында қолданылмаса ғана жойылады.",
    en: "Deletion is available only when the record is not used in orders, standards or team assignments.",
  },
  "Удалить запись": {
    kk: "Жазбаны жою",
    en: "Delete record",
  },
  "Не удалять": {
    kk: "Жоймау",
    en: "Keep record",
  },
  "Удаляем…": {
    kk: "Жойылуда…",
    en: "Deleting…",
  },
  "Подтвердить удаление": {
    kk: "Жоюды растау",
    en: "Confirm deletion",
  },
  "Локальное хранилище недоступно. Освободите место или используйте обычный режим браузера.": {
    kk: "Жергілікті сақтау қолжетімсіз. Орын босатыңыз немесе браузердің қалыпты режимін қолданыңыз.",
    en: "Local storage is unavailable. Free up space or use normal browsing mode.",
  },
  "Закройте другие вкладки приложения и повторите.": {
    kk: "Қолданбаның басқа қойындыларын жауып, қайталаңыз.",
    en: "Close other app tabs and try again.",
  },
  "Не указан владелец локальных данных.": {
    kk: "Жергілікті деректер иесі көрсетілмеген.",
    en: "Local data owner is not specified.",
  },
  "Это действие нельзя сохранить для отправки без связи.": {
    kk: "Бұл әрекетті офлайн жіберу үшін сақтау мүмкін емес.",
    en: "This action cannot be queued offline.",
  },
  "По этому наряду уже ожидается отправка. Сначала отправьте или удалите предыдущее действие.": {
    kk: "Бұл наряд бойынша жіберу күтілуде. Алдымен алдыңғы әрекетті жіберіңіз не жойыңыз.",
    en: "An action for this order is already pending. Send or remove it first.",
  },
  "У вас уже есть наряд в работе. Завершите или приостановите его, затем удалите отклонённое действие из очереди и повторите начало работы.":
    {
      kk: "Сізде орындалып жатқан наряд бар. Оны аяқтаңыз не кідіртіңіз, қабылданбаған әрекетті кезектен жойып, қайта бастаңыз.",
      en: "You already have an order in progress. Complete or pause it, remove the rejected action from the queue and try starting again.",
    },
  "Не удалось начать работу: ваш доступ или смена неактивны. Обратитесь к мастеру или администратору. После исправления удалите отклонённое действие из очереди и повторите.":
    {
      kk: "Жұмыс басталмады: қолжетімділігіңіз немесе ауысымыңыз белсенді емес. Шеберге не әкімшіге хабарласыңыз. Түзетілген соң қабылданбаған әрекетті кезектен жойып, қайталаңыз.",
      en: "Could not start work: your access or shift is inactive. Contact the supervisor or administrator. Once fixed, remove the rejected action and retry.",
    },
  "Этот участок недоступен вам. Обратитесь к мастеру для проверки назначения.": {
    kk: "Бұл учаске сізге қолжетімсіз. Тағайындауды тексеру үшін шеберге хабарласыңыз.",
    en: "You do not have access to this area. Ask the supervisor to check the assignment.",
  },
  "Наряд изменился. Откройте актуальную карточку; удалите это действие и повторите осознанно.": {
    kk: "Наряд өзгерді. Ағымдағы карточканы ашыңыз; осы әрекетті жойып, қайта тексеріп орындаңыз.",
    en: "The work order changed. Open the current details, remove this action and retry after reviewing.",
  },
  "Сервер отклонил действие. Проверьте права и актуальную карточку перед повтором.": {
    kk: "Сервер әрекетті қабылдамады. Қайталаудан бұрын құқықтар мен ағымдағы карточканы тексеріңіз.",
    en: "The server rejected the action. Check permissions and current details before retrying.",
  },
  "Не удалось подтвердить отправку. Повторите её, когда появится связь.": {
    kk: "Жіберу расталмады. Байланыс пайда болғанда қайталаңыз.",
    en: "Could not confirm delivery. Retry when connected.",
  },
  "ИИ-проверка недоступна.": {
    kk: "ЖИ тексеруі қолжетімсіз.",
    en: "AI review is unavailable.",
  },
  "ИИ-проверка временно недоступна. Требуется решение мастера.": {
    kk: "ЖИ тексеруі уақытша қолжетімсіз. Шебер шешімі қажет.",
    en: "AI review is temporarily unavailable. A supervisor decision is required.",
  },
  "ИИ-проверка недоступна. Требуется решение мастера.": {
    kk: "ЖИ тексеруі қолжетімсіз. Шебер шешімі қажет.",
    en: "AI review is unavailable. A supervisor decision is required.",
  },
  "ИИ-сводка недоступна. Показан обзор рассчитанных показателей.": {
    kk: "ЖИ жиынтығы қолжетімсіз. Есептелген көрсеткіштер шолуы көрсетілген.",
    en: "AI summary unavailable. Showing calculated metrics instead.",
  },
  "Для рекомендаций ИИ пока недостаточно данных.": {
    kk: "ЖИ ұсынымдары үшін деректер әзірге жеткіліксіз.",
    en: "Not enough data for AI recommendations yet.",
  },
  "Моя работа": {
    kk: "Менің жұмысым",
    en: "My work",
  },
  "Мои результаты": {
    kk: "Менің нәтижелерім",
    en: "My results",
  },
  Загрузка: {
    kk: "Жүктеме",
    en: "Workload",
  },
  Отчёт: {
    kk: "Есеп",
    en: "Report",
  },
  Система: {
    kk: "Жүйе",
    en: "System",
  },
};

export const translations: Record<string, { kk: string; en: string }> = {
  "Групп на странице: {0} из {1}.": {
    kk: "Беттегі топтар: {1} ішінен {0}.",
    en: "Groups on this page: {0} of {1}.",
  },
  "События показаны от новых к старым.": {
    kk: "Оқиғалар жаңадан ескіге қарай көрсетілген.",
    en: "Events are shown newest first.",
  },
  "История событий": { kk: "Оқиғалар тарихы", en: "Event history" },
  "События {0}–{1} из {2}": { kk: "{2} ішінен {0}–{1} оқиғалар", en: "Events {0}–{1} of {2}" },
  Новее: { kk: "Жаңарақ", en: "Newer" },
  Ранее: { kk: "Ертерек", en: "Older" },
  "Сканировать QR оборудования": { kk: "Жабдықтың QR-кодын сканерлеу", en: "Scan equipment QR" },
  "Сканировать оборудование": { kk: "Жабдықты сканерлеу", en: "Scan equipment" },
  "Наведите камеру на QR-код на наклейке.": {
    kk: "Камераны жапсырмадағы QR-кодқа бағыттаңыз.",
    en: "Point the camera at the QR code on the label.",
  },
  "Это не QR оборудования ТехНаряда. Наведите камеру на наклейку оборудования.": {
    kk: "Бұл ТехНаряд жабдығының QR-коды емес. Камераны жабдық жапсырмасына бағыттаңыз.",
    en: "This is not a TechNaryad equipment QR. Point the camera at the equipment label.",
  },
  "Камера доступна по HTTPS. Откройте защищённый адрес сайта или выберите фото QR.": {
    kk: "Камера HTTPS арқылы қолжетімді. Сайттың қауіпсіз мекенжайын ашыңыз немесе QR фотосын таңдаңыз.",
    en: "The camera requires HTTPS. Open the secure site or select a QR photo.",
  },
  "Не удалось прочитать изображение. Попробуйте другое фото QR.": {
    kk: "Суретті оқу мүмкін болмады. Басқа QR фотосын таңдаңыз.",
    en: "Could not read the image. Try another QR photo.",
  },
  "Доступ к камере запрещён. Разрешите его в настройках браузера или выберите фото QR.": {
    kk: "Камераға қолжетімділік бұғатталған. Браузер баптауларында рұқсат беріңіз немесе QR фотосын таңдаңыз.",
    en: "Camera access is blocked. Allow it in browser settings or select a QR photo.",
  },
  "Не удалось включить камеру. Закройте другие приложения с камерой или выберите фото QR.": {
    kk: "Камераны қосу мүмкін болмады. Камераны қолданатын басқа қолданбаларды жабыңыз немесе QR фотосын таңдаңыз.",
    en: "Could not start the camera. Close other camera apps or select a QR photo.",
  },
  "Выберите изображение размером до 20 МБ.": {
    kk: "Өлшемі 20 МБ дейінгі суретті таңдаңыз.",
    en: "Select an image up to 20 MB.",
  },
  "QR-код не найден. Выберите чёткое фото, на котором код виден целиком.": {
    kk: "QR-код табылмады. Код толық көрінетін анық фото таңдаңыз.",
    en: "No QR code found. Select a clear photo showing the entire code.",
  },
  "Камера сканера": { kk: "Сканер камерасы", en: "Scanner camera" },
  "Включаем камеру…": { kk: "Камера қосылуда…", en: "Starting camera…" },
  "Читаем QR-код…": { kk: "QR-код оқылуда…", en: "Reading QR code…" },
  "QR на оборудовании": { kk: "Жабдықтағы QR", en: "Equipment QR" },
  "Держите код в рамке. Карточка откроется автоматически.": {
    kk: "Кодты жақтау ішінде ұстаңыз. Карточка автоматты түрде ашылады.",
    en: "Keep the code inside the frame. The equipment card will open automatically.",
  },
  "Откроется карточка оборудования с доступными вам сведениями и действиями.": {
    kk: "Сізге қолжетімді мәліметтер мен әрекеттер бар жабдық карточкасы ашылады.",
    en: "Opens the equipment card with information and actions available to you.",
  },
  "Выключить камеру": { kk: "Камераны өшіру", en: "Stop camera" },
  "Включить камеру": { kk: "Камераны қосу", en: "Start camera" },
  "Выбрать фото QR": { kk: "QR фотосын таңдау", en: "Select QR photo" },
  "Изображение обрабатывается на устройстве и не отправляется на сервер.": {
    kk: "Сурет құрылғыда өңделеді және серверге жіберілмейді.",
    en: "The image is processed on your device and is not sent to the server.",
  },
  ...baseTranslations,
  ...uiTranslations,
};
