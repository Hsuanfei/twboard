# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
"""最小的 Excel（.xlsx）寫入器（0930a）：只用 Python 標準函式庫，給「資料 Excel」一次下載多檔股票用。

每張工作表是一個表格：第一列標題（粗體、凍結、可篩選），之後每列一筆資料。
數字存成數值、ISO 日期字串（YYYY-MM-DD）存成 Excel 日期，其餘存成文字；None 留空。
"""
import datetime as _dt
import io
import re
import zipfile
from xml.sax.saxutils import escape as _esc

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_BAD_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
_EPOCH = _dt.date(1899, 12, 30)
# 工作表名稱不能有這些字元，最長 31 字
_BAD_SHEET = re.compile(r"[\[\]:*?/\\]")

# 樣式索引：0 一般、1 標題、2 日期、3 小數、4 說明文字（灰）
_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="#,##0.00####"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Microsoft JhengHei"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft JhengHei"/><family val="2"/></font>
<font><sz val="10"/><color rgb="FF666666"/><name val="Microsoft JhengHei"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF2F5FC7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"""


def sheet_name(name, used):
    """合法且不重複的工作表名稱。"""
    base = _BAD_SHEET.sub(" ", str(name or "").strip()).strip("'") or "Sheet"
    base = base[:31]
    cand, k = base, 2
    while cand.lower() in used:
        tail = "(%d)" % k
        cand = base[:31 - len(tail)] + tail
        k += 1
    used.add(cand.lower())
    return cand


def _col(i):
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def _cell(ref, v, header=False, note=False):
    if v is None or v == "":
        return ""
    if header:
        return '<c r="%s" s="1" t="inlineStr"><is><t>%s</t></is></c>' % (ref, _esc(_BAD_XML.sub("", str(v))))
    if isinstance(v, bool):
        return '<c r="%s" t="b"><v>%d</v></c>' % (ref, int(v))
    if isinstance(v, (int, float)):
        if v != v or v in (float("inf"), float("-inf")):
            return ""
        style = ' s="3"' if isinstance(v, float) and not float(v).is_integer() else ""
        return '<c r="%s"%s><v>%s</v></c>' % (ref, style, repr(v) if isinstance(v, float) else v)
    text = _BAD_XML.sub("", str(v))
    if _DATE_RE.match(text):
        try:
            serial = (_dt.date.fromisoformat(text) - _EPOCH).days
            return '<c r="%s" s="2"><v>%d</v></c>' % (ref, serial)
        except ValueError:
            pass
    style = ' s="4"' if note else ""
    return '<c r="%s"%s t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (ref, style, _esc(text))


def _sheet_xml(header, rows, widths=None, notes=()):
    ncol = max([len(header)] + [len(r) for r in rows] or [1])
    last = _col(ncol - 1)
    cols = "".join('<col min="%d" max="%d" width="%s" customWidth="1"/>' % (i + 1, i + 1, w)
                   for i, w in enumerate(widths or [12] * ncol))
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
           'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
           '<dimension ref="A1:%s%d"/>' % (last, max(1, len(rows) + 1 + (len(notes) + 1 if notes else 0))),
           '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
           '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>',
           '<sheetFormatPr defaultRowHeight="16.5"/>', '<cols>%s</cols>' % cols, '<sheetData>']
    out.append('<row r="1" ht="33" customHeight="1">%s</row>' % "".join(
        _cell("%s1" % _col(j), h, header=True) for j, h in enumerate(header)))
    for i, r in enumerate(rows, start=2):
        out.append('<row r="%d">%s</row>' % (i, "".join(_cell("%s%d" % (_col(j), i), v) for j, v in enumerate(r))))
    if notes:
        start = len(rows) + 3
        for k, text in enumerate(notes):
            out.append('<row r="%d">%s</row>' % (start + k, _cell("A%d" % (start + k), text, note=True)))
    out.append('</sheetData>')
    if rows:
        out.append('<autoFilter ref="A1:%s%d"/>' % (last, len(rows) + 1))
    out.append('<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/></worksheet>')
    return "".join(out)


def workbook(sheets, title="", author=""):
    """sheets：[{"name", "header", "rows", "widths"(可省略), "notes"(可省略)}]，回傳 .xlsx 位元組。"""
    if not sheets:
        raise ValueError("沒有可以匯出的工作表")
    used, names = set(), []
    for s in sheets:
        names.append(sheet_name(s["name"], used))
    buf = io.BytesIO()
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                   + "".join('<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % (i + 1)
                             for i in range(len(sheets))) +
                   '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
                   '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
                   '</Types>')
        z.writestr("_rels/.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
                   '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
                   '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
                   '</Relationships>')
        z.writestr("docProps/core.xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
                   'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
                   'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
                   '<dc:title>%s</dc:title><dc:creator>%s</dc:creator>'
                   '<dcterms:created xsi:type="dcterms:W3CDTF">%s</dcterms:created>'
                   '<dcterms:modified xsi:type="dcterms:W3CDTF">%s</dcterms:modified></cp:coreProperties>'
                   % (_esc(title), _esc(author), now, now))
        z.writestr("docProps/app.xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
                   '<Application>%s</Application></Properties>' % _esc(title or "twboard"))
        z.writestr("xl/workbook.xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                   '<bookViews><workbookView activeTab="0"/></bookViews><sheets>'
                   + "".join('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (_esc(n, {'"': "&quot;"}), i + 1, i + 1)
                             for i, n in enumerate(names)) +
                   '</sheets><definedNames>'
                   + "".join('<definedName name="_xlnm._FilterDatabase" localSheetId="%d" hidden="1">\'%s\'!$A$1:$%s$%d</definedName>'
                             % (i, _esc(n.replace("'", "''")), _col(max(1, len(s["header"])) - 1), len(s["rows"]) + 1)
                             for i, (n, s) in enumerate(zip(names, sheets)) if s["rows"]) +
                   '</definedNames></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   + "".join('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>'
                             % (i + 1, i + 1) for i in range(len(sheets))) +
                   '<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
                   % (len(sheets) + 1) + '</Relationships>')
        z.writestr("xl/styles.xml", _STYLES)
        for i, s in enumerate(sheets):
            z.writestr("xl/worksheets/sheet%d.xml" % (i + 1),
                       _sheet_xml(s["header"], s["rows"], s.get("widths"), s.get("notes") or ()))
    return buf.getvalue()
