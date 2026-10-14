import type { Language } from "../lib/i18n";

type Translation = { kk: string; en: string };

/** Kept beside the editor so the shared translation catalog can be merged independently. */
export const equipmentLabelTranslations: Record<string, Translation> = {
  "Можно вводить точку или запятую. Точность — 0,1 мм / пт.": {
    kk: "Нүкте немесе үтір енгізуге болады. Дәлдік — 0,1 мм / пт.",
    en: "Use a dot or comma. Precision: 0.1 mm / pt.",
  },
  "Наклейка не напечатана. Исправьте значения или размер содержимого в редакторе.": {
    kk: "Жапсырма басып шығарылмады. Өңдегіштегі мәндерді немесе мазмұн өлшемін түзетіңіз.",
    en: "Label not printed. Correct the values or content size in the editor.",
  },
  "Редактор наклейки": { kk: "Жапсырма өңдегіші", en: "Label editor" },
  "Настройте размер и содержимое перед печатью.": {
    kk: "Басып шығармас бұрын өлшемі мен мазмұнын реттеңіз.",
    en: "Set the size and content before printing.",
  },
  "Настройте размер, бумагу и положение перед печатью.": {
    kk: "Басып шығармас бұрын өлшемін, қағазын және орнын реттеңіз.",
    en: "Set the size, paper, and placement before printing.",
  },
  Наклейка: { kk: "Жапсырма", en: "Label" },
  "Бумага и положение": { kk: "Қағаз және орналасуы", en: "Paper and placement" },
  Бумага: { kk: "Қағаз", en: "Paper" },
  "Только наклейка": { kk: "Тек жапсырма", en: "Label only" },
  "Слева, мм": { kk: "Сол жақтан, мм", en: "From left, mm" },
  "Сверху, мм": { kk: "Жоғарыдан, мм", en: "From top, mm" },
  "По центру листа": { kk: "Парақ ортасына", en: "Centre on page" },
  "В верхний левый угол": { kk: "Жоғарғы сол жақ бұрышқа", en: "Top left" },
  "В нижний правый угол": { kk: "Төменгі оң жақ бұрышқа", en: "Bottom right" },
  "На A4 доступная область начинается в 8 мм от края листа.": {
    kk: "A4 қағазында қолжетімді аймақ парақ жиегінен 8 мм жерде басталады.",
    en: "On A4, the available area starts 8 mm from the page edge.",
  },
  "Макет и текст": { kk: "Орналасу және мәтін", en: "Layout and text" },
  "Предпросмотр листа": { kk: "Парақты алдын ала қарау", en: "Page preview" },
  "Масштаб экрана": { kk: "Экран масштабы", en: "Screen zoom" },
  "Наклейка: перетащите мышью или двигайте стрелками": {
    kk: "Жапсырма: тінтуірмен жылжытыңыз немесе көрсеткілермен орын ауыстырыңыз",
    en: "Label: drag with the mouse or move with arrow keys",
  },
  "Предпросмотр повторяет миллиметры и положение при печати. Выберите фактический размер в диалоге принтера.":
    {
      kk: "Алдын ала қарау басып шығарудағы миллиметрлер мен орынды қайталайды. Принтер тілқатысуында нақты өлшемді таңдаңыз.",
      en: "The preview uses the same millimetres and placement as printing. Choose actual size in the printer dialog.",
    },
  Формат: { kk: "Пішім", en: "Format" },
  "Свой размер": { kk: "Өз өлшемі", en: "Custom size" },
  Допустимо: { kk: "Рұқсат етіледі", en: "Allowed" },
  "Ширина, мм": { kk: "Ені, мм", en: "Width, mm" },
  "Высота, мм": { kk: "Биіктігі, мм", en: "Height, mm" },
  Макет: { kk: "Орналасу", en: "Layout" },
  "QR слева": { kk: "QR сол жақта", en: "QR on the left" },
  "QR справа": { kk: "QR оң жақта", en: "QR on the right" },
  "Текст сверху": { kk: "Мәтін жоғарыда", en: "Text above" },
  "QR-код, мм": { kk: "QR-код, мм", en: "QR code, mm" },
  "Отступ, мм": { kk: "Шегініс, мм", en: "Padding, mm" },
  Текст: { kk: "Мәтін", en: "Text" },
  "Инвентарный номер": { kk: "Мүлік нөмірі", en: "Inventory number" },
  Название: { kk: "Атауы", en: "Name" },
  Участок: { kk: "Учаске", en: "Area" },
  Тип: { kk: "Түрі", en: "Type" },
  "Размер шрифта, пт": { kk: "Қаріп өлшемі, пт", en: "Font size, pt" },
  Выравнивание: { kk: "Туралау", en: "Alignment" },
  "По левому краю": { kk: "Сол жақ шеті", en: "Left" },
  "По центру": { kk: "Ортаға", en: "Centre" },
  "Предпросмотр в масштабе": { kk: "Масштабтағы алдын ала қарау", en: "True-scale preview" },
  Сбросить: { kk: "Қалпына келтіру", en: "Reset" },
  Печать: { kk: "Басып шығару", en: "Print" },
  "Введите число в допустимом диапазоне.": {
    kk: "Рұқсат етілген ауқымда санды енгізіңіз.",
    en: "Enter a number within the allowed range.",
  },
  "Печать недоступна: часть текста не помещается на наклейке.": {
    kk: "Басып шығару қолжетімсіз: мәтіннің бір бөлігі жапсырмаға сыймайды.",
    en: "Printing is unavailable because part of the text does not fit on the label.",
  },
  "Уменьшите шрифт или QR-код, увеличьте формат либо скройте часть текста.": {
    kk: "Қаріпті не QR-кодты кішірейтіңіз, пішімді үлкейтіңіз немесе мәтіннің бір бөлігін жасырыңыз.",
    en: "Reduce the font or QR code, choose a larger label, or hide some text.",
  },
  "QR ограничен размером наклейки, чтобы сохранить белое поле вокруг кода.": {
    kk: "Кодтың айналасындағы ақ жиекті сақтау үшін QR өлшемі жапсырмаға сай шектелді.",
    en: "QR size is limited by the label to preserve a clear white edge.",
  },
  "Для точного физического размера выберите в диалоге печати фактический размер и носитель не меньше наклейки.":
    {
      kk: "Нақты өлшем үшін басып шығару терезесінде нақты масштабты және жапсырмадан кіші емес тасымалдағышты таңдаңыз.",
      en: "For physical size, select actual size and paper no smaller than the label in the print dialog.",
    },
};

export function labelText(source: string, language: Language): string {
  return language === "ru" ? source : (equipmentLabelTranslations[source]?.[language] ?? source);
}
