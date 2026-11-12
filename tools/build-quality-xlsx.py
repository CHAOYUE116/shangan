# -*- coding: utf-8 -*-
"""把质量审计的 CSV 合成一个带筛选、冻结表头、列宽自适应的 xlsx。"""
import csv, os, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REP = os.path.join(ROOT, "report")
DAY = os.environ.get("QDAY", "20261112")
OUT = os.path.join(REP, f"题库质量清单-{DAY}.xlsx")

SHEETS = [
    ("答案类", f"quality-answers-{DAY}.csv", "缺答案 / 答案与解析矛盾：看「参考答案(从解析推)」是否有值，核对后回填"),
    ("缺陷类", f"quality-errors-{DAY}.csv", "缺解析 / 缺材料 / 缺图 / 题干残缺 / 解析截断：多半要回原卷或重采"),
    ("全量", f"quality-audit-{DAY}.csv", "两份的并集，一题可命中多类"),
]

# 列宽（按内容类型给个合理上限，避免一格几千字把表撑爆）
WIDTH = {
    "问题码": 7, "问题类型": 16, "题号(questionId)": 14, "科目": 13, "章节": 14, "题型": 7,
    "来源卷": 44, "题干摘要": 60, "选项": 60, "库里答案": 10, "参考答案(从解析推)": 14,
    "解析摘要": 70, "建议动作": 22,
}

wb = Workbook()
wb.remove(wb.active)

CODE_FILL = {
    "A": "FFF2CC", "D": "FCE4D6", "B": "E2EFDA", "E": "DDEBF7",
    "F": "E4DFEC", "G": "EDEDED", "H": "FFF7E6",
}

for title, fname, desc in SHEETS:
    src = os.path.join(REP, fname)
    with open(src, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    ws = wb.create_sheet(title)
    header, body = rows[0], rows[1:]
    ws.append(header)
    for r in body:
        ws.append(r)

    # 表头样式
    for c in range(1, len(header) + 1):
        cell = ws.cell(row=1, column=c)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="2F5BEA")
        cell.alignment = Alignment(vertical="center", horizontal="center")
    ws.freeze_panes = "A2"
    if body:
        ws.auto_filter.ref = f"A1:{get_column_letter(len(header))}{len(body) + 1}"

    for i, name in enumerate(header, start=1):
        ws.column_dimensions[get_column_letter(i)].width = WIDTH.get(name, 18)

    # 按问题码上色（只染第一列，表体其余白底）
    code_col = header.index("问题码") + 1 if "问题码" in header else 0
    if code_col:
        for r in range(2, len(body) + 2):
            code = ws.cell(row=r, column=code_col).value
            fill = CODE_FILL.get(code)
            if fill:
                ws.cell(row=r, column=code_col).fill = PatternFill("solid", fgColor=fill)
    # 行高与换行
    for r in range(2, len(body) + 2):
        ws.row_dimensions[r].height = 60
        for c in range(1, len(header) + 1):
            ws.cell(row=r, column=c).alignment = Alignment(vertical="top", wrap_text=True)

    # 第一行下面插一行说明
    ws.insert_rows(2)
    note = ws.cell(row=2, column=1, value=desc)
    note.font = Font(italic=True, color="8A90A0")
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=min(6, len(header)))
    ws.freeze_panes = "A3"

# 汇总页放最前
ws = wb.create_sheet("汇总", 0)
lines = [
    ("题库质量体检 · 2026-11-11", ""),
    ("唯一题", 98611),
    ("其中客观题", 91778),
    ("有问题（一题可命中多类）", 13878),
    ("可从解析反推参考答案", 3271),
    ("", ""),
    ("问题码", "条数"),
    ("A 缺答案", 3302),
    ("B 缺解析（<20 字）", 3344),
    ("D 答案与解析矛盾", 195),
    ("E 缺材料", 1581),
    ("F 缺图片", 874),
    ("G 题干过短（<8 字）", 1776),
    ("H 解析疑似截断", 2806),
    ("", ""),
    ("怎么用", "先在「答案类」里挑「参考答案(从解析推)」有值的核对回填；「缺陷类」按问题码筛选后决定回原卷还是重采"),
]
for a, b in lines:
    ws.append([a, b])
ws["A1"].font = Font(bold=True, size=14)
for r in range(7, 15):
    ws.cell(row=r, column=1).font = Font(bold=True)
ws.column_dimensions["A"].width = 40
ws.column_dimensions["B"].width = 80
ws["B16"].alignment = Alignment(wrap_text=True, vertical="top")
ws.row_dimensions[16].height = 48

wb.save(OUT)
print("xlsx ->", OUT)
print("bytes:", os.path.getsize(OUT))
for title, fname, _ in SHEETS:
    with open(os.path.join(REP, fname), encoding="utf-8-sig") as f:
        print(title, sum(1 for _ in f) - 1, "rows")
