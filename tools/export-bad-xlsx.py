#!/usr/bin/env python
"""把事业编·职测的坏题导成 xlsx：汇总 + 每种错误类型一个 sheet。

数据来源：node 侧导出的 report/bad-zc.json（已按 questionId 去重、只含 q_bad=1）
"""
import json
import os
import re

import xlsxwriter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "report", "bad-zc.json")
OUT = os.path.join(ROOT, "report", "坏题清单-事业编职测-20261112.xlsx")

TAG = re.compile(r"<[^>]+>")
IMG = re.compile(r"<img\b[^>]*>", re.I)
DATAURI = re.compile(r"data:[^\"'\s)]+")
LATEX = re.compile(r"latex=([A-Za-z0-9_-]+)")

TYPE_NAME = {1: "单选", 2: "多选", 3: "不定项", 5: "判断", 4: "主观", 6: "主观"}


def plain(html, limit=None):
    if not html:
        return ""
    s = str(html)
    n_img = len(IMG.findall(s))
    s = IMG.sub("〔图〕", s)
    s = TAG.sub(" ", s)
    s = DATAURI.sub("〔图〕", s)
    s = re.sub(r"\s+", " ", s).strip()
    if limit and len(s) > limit:
        s = s[:limit] + "…"
    return s


def img_count(*fields):
    return sum(len(IMG.findall(str(f or ""))) for f in fields)


def latex_keys(*fields):
    keys = set()
    for f in fields:
        for m in LATEX.finditer(str(f or "")):
            keys.add(m.group(1))
    return sorted(keys)


def normalize_reason(r):
    r = str(r or "")
    if r.startswith("答案与解析不符"):
        return "答案与解析不符"
    if r.startswith("图片键缺失"):
        return "图片键缺失"
    return r.split("：")[0].split(":")[0]


def verdict(row, kind):
    """粗判这题还能不能救，方便你只看想救的那部分。"""
    stem = plain(row.get("content") or "", 200)
    has_fig_word = bool(re.search(r"\[图\]|（图）|\(图\)|如图|下图|上图|图中|规律性|折线图|柱状图", stem))
    n_content_img = len(IMG.findall(str(row.get("contentHtml") or "")))
    n_ana_img = len(IMG.findall(str(row.get("analysisHtml") or "")))
    generic = bool(re.search(r"所给的四个选项中|最合适的一个填入问号处|既有规律|分为两类|纸盒|展开图|立方体|六个图形", stem))
    if kind == "图丢了":
        if n_content_img:
            return "已修（题干已有图）"
        if generic:
            return "难以恢复：信息在图上，文字搜不到"
        if has_fig_word:
            return "可按卷重采（有卷且带图）"
        return "待核（题干没提图）"
    if kind == "公式丢了":
        if n_ana_img:
            return "已修（解析已有图）"
        return "可按卷/搜题重采（解析公式被吞）"
    if kind == "答案与解析不符":
        return "需人工核对（答案与粉笔一致率 99.91%，多半是解析写错）"
    if kind == "缺材料":
        return "难恢复：考点散题无材料"
    return ""


def main():
    with open(SRC, "r", encoding="utf-8") as f:
        rows = json.load(f)

    buckets = {}
    for r in rows:
        kind = normalize_reason(r.get("q_bad_reason"))
        buckets.setdefault(kind, []).append(r)

    wb = xlsxwriter.Workbook(OUT, {"constant_memory": True, "strings_to_urls": False})
    fmt_title = wb.add_format({"bold": True, "font_size": 15})
    fmt_sub = wb.add_format({"font_color": "#6B7280", "font_size": 10})
    fmt_head = wb.add_format({"bold": True, "bg_color": "#EEF2F7", "border": 1, "text_wrap": True, "valign": "vcenter"})
    fmt_cell = wb.add_format({"border": 1, "valign": "top", "text_wrap": True})
    fmt_num = wb.add_format({"border": 1, "valign": "top", "num_format": "0"})
    fmt_warn = wb.add_format({"border": 1, "valign": "top", "text_wrap": True, "bg_color": "#FFF4E5"})
    fmt_bad = wb.add_format({"border": 1, "valign": "top", "text_wrap": True, "bg_color": "#FDE8E8"})
    fmt_ok = wb.add_format({"border": 1, "valign": "top", "text_wrap": True, "bg_color": "#E8F6EC"})

    # ---------- 汇总 ----------
    ws = wb.add_worksheet("汇总")
    ws.set_column(0, 0, 22)
    ws.set_column(1, 6, 14)
    ws.write(0, 0, "事业编·职测 坏题清单", fmt_title)
    ws.write(1, 0, f"共 {len(rows)} 道（按 questionId 去重，只含被排除出抽题池的题）· 数据源 app-assets/tiku_app.db", fmt_sub)

    ws.write(3, 0, "按错误类型", fmt_head)
    ws.write(3, 1, "数量", fmt_head)
    ws.write(3, 2, "说明", fmt_head)
    ws.write(3, 3, "能不能救", fmt_head)
    notes = {
        "图丢了": "题干提到图/规律，但正文里没有图（图片在采集时丢了）",
        "公式丢了": "解析里公式被吞了，剩下「为元」「有名」这种断句",
        "答案与解析不符": "解析里写出的答案与库里答案不一致（多为解析写错）",
        "缺材料": "以「根据材料」开头，但材料整份缺失",
    }
    fixable = {
        "图丢了": "部分可救（非图形推理题可按卷重采）",
        "公式丢了": "多数可救（按卷重采或搜题）",
        "答案与解析不符": "需人工核对",
        "缺材料": "基本不可救（考点散题）",
    }
    r_i = 4
    for kind, lst in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
        ws.write(r_i, 0, kind, fmt_cell)
        ws.write_number(r_i, 1, len(lst), fmt_num)
        ws.write(r_i, 2, notes.get(kind, ""), fmt_cell)
        ws.write(r_i, 3, fixable.get(kind, ""), fmt_cell)
        r_i += 1
    ws.write_number(r_i, 0 if False else 0, len(rows), fmt_num)
    ws.write(r_i, 1, "合计", fmt_head)

    # 按章节
    r_i += 2
    ws.write(r_i, 0, "按章节", fmt_head)
    ws.write(r_i, 1, "题数", fmt_head)
    r_i += 1
    chap = {}
    for r in rows:
        chap[r.get("chapter") or "（空）"] = chap.get(r.get("chapter") or "（空）", 0) + 1
    for ch, n in sorted(chap.items(), key=lambda kv: -kv[1]):
        ws.write(r_i, 0, ch, fmt_cell)
        ws.write_number(r_i, 1, n, fmt_num)
        r_i += 1

    # ---------- 每种类型一个 sheet ----------
    headers = ["题号", "卷名", "章节", "题型", "题干", "选项", "库答案", "解析", "图片数", "坏题原因", "判断", "latex 键"]
    widths = [12, 34, 14, 8, 52, 40, 10, 60, 9, 26, 30, 22]

    for kind, lst in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
        sh = wb.add_worksheet(kind[:28])
        for i, w in enumerate(widths):
            sh.set_column(i, i, w)
        sh.write(0, 0, f"{kind} · {len(lst)} 道", fmt_title)
        for i, h in enumerate(headers):
            sh.write(2, i, h, fmt_head)
        sh.freeze_panes(3, 1)
        sh.autofilter(2, 0, 2 + len(lst), len(headers) - 1)

        for row_i, r in enumerate(lst, start=3):
            v = verdict(r, kind)
            cell = fmt_ok if v.startswith("已修") else (fmt_bad if v.startswith("难以恢复") or v.startswith("难恢复") else fmt_warn)
            sh.write_number(row_i, 0, int(r["questionId"]), fmt_num)
            sh.write(row_i, 1, r.get("paperName") or "", fmt_cell)
            sh.write(row_i, 2, r.get("chapter") or "", fmt_cell)
            sh.write(row_i, 3, TYPE_NAME.get(r.get("type"), str(r.get("type"))), fmt_cell)
            sh.write(row_i, 4, plain(r.get("content"), 600), fmt_cell)
            sh.write(row_i, 5, plain(r.get("options"), 400), fmt_cell)
            sh.write(row_i, 6, str(r.get("answer") or ""), fmt_cell)
            sh.write(row_i, 7, plain(r.get("analysis"), 900), fmt_cell)
            sh.write_number(row_i, 8, img_count(r.get("contentHtml"), r.get("analysisHtml"), r.get("material")), fmt_num)
            sh.write(row_i, 9, r.get("q_bad_reason") or "", fmt_cell)
            sh.write(row_i, 10, v, cell)
            sh.write(row_i, 11, ", ".join(latex_keys(r.get("contentHtml"), r.get("analysisHtml"), r.get("material"))), fmt_cell)

    wb.close()
    print(f"写出 {OUT} · 共 {len(rows)} 道 · {len(buckets)} 类")
    for k, v in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
        print(f"  {k}: {len(v)}")


if __name__ == "__main__":
    main()
