"""Excel rendering: literal user strings, cached numbers, no external links/macros."""

# ruff: noqa: RUF001
from collections.abc import Sequence
from datetime import datetime
from decimal import Decimal
from io import BytesIO
from typing import Any

from xlsxwriter import Workbook  # type: ignore[import-untyped]

from naryadai.application.common import OperationError


class ReportWorkbook:
    def __init__(self, title: str) -> None:
        self.buffer = BytesIO()
        self.book = Workbook(
            self.buffer,
            {
                "in_memory": True,
                "strings_to_formulas": False,
                "strings_to_urls": False,
                "strings_to_numbers": False,
            },
        )
        self.book.set_properties(
            {"title": title, "author": "НарядAI", "comments": "Отчёт по доступным данным"}
        )
        self.header = self.book.add_format(
            {"bold": True, "font_color": "#FFFFFF", "bg_color": "#174D45", "text_wrap": True}
        )
        self.text = self.book.add_format(
            {"text_wrap": True, "valign": "top", "font_name": "Calibri", "font_size": 11}
        )
        self.integer = self.book.add_format({"num_format": "0", "valign": "top"})
        self.number = self.book.add_format({"num_format": "0.00#", "valign": "top"})

    def table(self, name: str, headers: Sequence[str], rows: Sequence[Sequence[object]]) -> Any:
        sheet = self.book.add_worksheet(name)
        sheet.hide_gridlines(2)
        sheet.freeze_panes(1, 0)
        sheet.set_default_row(32)
        sheet.set_row(0, 34)
        sheet.set_column(0, len(headers) - 1, 26, self.text)
        for column, label in enumerate(headers):
            sheet.write_string(0, column, label, self.header)
        for index, row in enumerate(rows, 1):
            longest = max((len(str(value)) for value in row if value is not None), default=0)
            sheet.set_row(index, min(240, max(32, ((longest + 59) // 60) * 15)))
            for column, value in enumerate(row):
                if value is None:
                    sheet.write_string(index, column, "Нет данных", self.text)
                elif isinstance(value, bool):
                    sheet.write_string(index, column, "Да" if value else "Нет", self.text)
                elif isinstance(value, int | float | Decimal):
                    sheet.write_number(
                        index,
                        column,
                        float(value),
                        self.integer if isinstance(value, int) else self.number,
                    )
                else:
                    rendered = value.isoformat() if isinstance(value, datetime) else str(value)
                    if len(rendered) > 32767:
                        raise OperationError(413, "report_cell_too_long")
                    sheet.write_string(index, column, rendered, self.text)
        if rows:
            sheet.autofilter(0, 0, len(rows), len(headers) - 1)
        sheet.set_landscape()
        sheet.fit_to_pages(1, 0)
        sheet.repeat_rows(0)
        sheet.set_footer("НарядAI · &P / &N")
        return sheet

    def finish(self) -> bytes:
        self.book.close()
        return self.buffer.getvalue()
