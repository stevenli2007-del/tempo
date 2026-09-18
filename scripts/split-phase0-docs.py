#!/usr/bin/env python3
"""Phase-0-MVP.md 瘦身：按锚点机械切分为「薄索引 + 分卡详情」。

设计原则（对应任务书硬性要求 1）：
  **只搬家，不重写。** 原文件被视为「1914 个带行终止符的行」，切分 = 把这些行
  按不重叠、无遗漏的方式分配给若干输出文件。除显式声明的「新增块」外，
  任何一行的内容都不改动。

  因此「原文一行都没丢」是可以被机械证明的：
      所有输出文件里的「原文部分」拼接起来 == 基线文件全文。

锚点纪律（严禁硬编码行号含义）：
  - 本脚本的行号范围是**当前基线的快照**；脚本运行时会先用锚点断言校验
    每个范围的边界行确实是预期的标题行，不对就中止。
  - 基线的唯一权威来源 = `git show <BASELINE_REV>:docs/Phase-0-MVP.md`。

产出：
  docs/Phase-0-MVP.md                薄索引
  docs/cards/README.md               卡片索引（新增）
  docs/cards/progress-pointer-archive.md
  docs/cards/P0-0.md / P0-1.md / P0-2.md / P0-3-overview.md
  docs/cards/P0-3-<卡号>.md          × 23
  docs/Phase-0-changelog.md
  /tmp/tempo-split/manifest.json     chunk 记账（供 verify 脚本使用）
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# 脚本入库后位于 <repo>/scripts/，此时 parent.parent 即仓库根。
# 在 /tmp 下试跑时用 TEMPO_REPO 环境变量或回落到本机路径。
REPO = Path(__file__).resolve().parent.parent
if not (REPO / "docs" / "Phase-0-MVP.md").exists():
    REPO = Path(os.environ.get("TEMPO_REPO", "/Users/youchengli/Desktop/Tempo"))
if not (REPO / "docs" / "Phase-0-MVP.md").exists():
    raise SystemExit(f"找不到仓库根：{REPO}")

SRC_REL = "docs/Phase-0-MVP.md"
BASELINE_REV = "HEAD"          # 拆分前，工作树该文件必须与 HEAD 一致
MANIFEST = Path("/tmp/tempo-split/manifest.json")

# ────────────────────────── 基线 ──────────────────────────

def load_baseline() -> str:
    out = subprocess.run(
        ["git", "show", f"{BASELINE_REV}:{SRC_REL}"],
        cwd=REPO, capture_output=True, check=True,
    )
    return out.stdout.decode("utf-8")


def to_lines(text: str) -> list[str]:
    """切成长度 1914、每个元素带行终止符的行表（等价于原文全文）。"""
    parts = text.split("\n")
    if parts[-1] != "":
        raise SystemExit("基线文件不以换行结尾，切分假设不成立")
    lines = [p + "\n" for p in parts[:-1]]
    assert "".join(lines) == text, "行表还原失败"
    return lines


# ────────────────────────── 切分表 ──────────────────────────
# (key, start_line, end_line)  1-based，闭区间，必须无缝覆盖全文
SECTIONS: list[tuple[str, int, int]] = [
    ("index",             1,   29),   # h1 + 引言 + ## 使用方式
    ("pointer_archive",  30,  195),   # ## 当前进度指针（166 行）
    ("index",           196,  211),   # P0-0 h2 + 引言 + 卡表 + ---
    ("P0-0",            212,  275),   # P0-0 执行卡
    ("index",           276,  297),   # P0-1 h2 + 引言 + 卡表 + ---
    ("P0-1",            298,  597),   # P0-1 执行卡
    ("index",           598,  618),   # P0-2 h2 + 引言 + 卡表
    ("P0-2",            619, 1098),   # P0-2 执行卡 + 6 段二级卡
    ("index",          1099, 1135),   # P0-3 h2 + 引言 + 卡表
    ("P0-3-overview",  1136, 1155),   # 排序纪律 + 明确移出 M3
    ("index",          1156, 1172),   # --- + P0-4 h2 + 卡表 + note
    ("P0-3-overview",  1173, 1176),   # P0-3 执行卡前言
    ("P0-3-CARDS",     1177, 1815),   # ★ 特殊：按 #### 🎫 锚点二次切
    ("index",          1816, 1844),   # 关键路径 + 风险登记
    ("changelog",      1845, 1914),   # ## 变更记录
]

CARD_ANCHOR = re.compile(r"^#### 🎫 (P0-3-\S+?) · ")

# ────────────────────────── 新增块（唯一允许写入的新内容） ──────────────────────────
# 记账规则：这些文本的字符数单独统计，不计入「原文总量」。

ADDED_INTRO = """\
## 本索引怎么用（2026-09-18 拆分后）

> **本文件已瘦身为「薄索引」**：只留「当前进度 + 逐卡一行表 + 关键路径 + 风险登记」。
> 逐卡详情（执行卡 / 验收留档）已按标题锚点**逐字**搬到 [`docs/cards/`](./cards/README.md)，
> **原文一个字都没改**（由 `scripts/verify-phase0-docs-split.py` 机械校验：字符总量 / 逐卡逐字 / 卡号集合）。
>
> **开工顺序（取代旧的「一次读 6 份 docs」）**：
> ① 读本索引 → ② 读当前卡的 `docs/cards/P0-3-XX.md` → ③ 按
> [`cards/README.md`](./cards/README.md) 里该卡的**依赖清单按需**读其余 Docs →
> ④ `grep -rn "// ?"` **收窄到本卡涉及的 `lib/` 子目录**，不再全仓扫。

| 去向 | 内容 |
|---|---|
| [`cards/progress-pointer-archive.md`](./cards/progress-pointer-archive.md) | 本文件原「当前进度指针」全段（166 行完整留档） |
| [`cards/P0-0.md`](./cards/P0-0.md) | P0-0 执行卡（7 张） |
| [`cards/P0-1.md`](./cards/P0-1.md) | P0-1 M1 执行卡（11 张） |
| [`cards/P0-2.md`](./cards/P0-2.md) | P0-2 M2 执行卡（4 张 🎫 + 6 段二级卡） |
| [`cards/P0-3-overview.md`](./cards/P0-3-overview.md) | P0-3 排序纪律 + 「明确移出 M3」 + 执行卡前言 |
| [`cards/P0-3-XX.md`](./cards/P0-3-1.md) | P0-3 每张卡一个文件（23 个，按 🎫 锚点切） |
| [`Phase-0-changelog.md`](./Phase-0-changelog.md) | 原「变更记录」段（70 行） |

## 当前进度指针（压缩版）

> **完整原文（166 行，含 3-8 ~ 3-20 的逐卡收尾细节）见
> [`cards/progress-pointer-archive.md`](./cards/progress-pointer-archive.md)。**

| 项 | 值 |
|---|---|
| **当前卡** | `P0-3-12` 全站视觉统一扫尾（⚪ 未开始；依赖 `P0-3-23` ✅ 已满足） |
| **上一张** | `P0-3-23` practice test 生成（✅ Steven 验收通过 2026-09-18，第 31 张卡） |
| **下一张** | `P0-3-13` 版本 freeze + 内部试用 = **出口门**（依赖 `P0-3-12`） |
| **里程碑** | M1 ✅ ｜ M2 ✅ ｜ M3 + M3.5 ✅（31 张卡全验收）｜ M4 ⚪（进入条件 = `P0-3-13` freeze） |
| **待验收** | 无 ✅（M3 + M3.5 执行链 2026-09-18 全部收口） |

**两张未闭合的卡（别在索引里被忽略）**
- 🔵 `P0-3-9`（截图档课程更新对话框）：代码完成 2026-09-13，**真实识别从未验收** ——
  缺 `DASHSCOPE_API_KEY`（Qwen key 手机号未开通）。见 [`cards/P0-3-9.md`](./cards/P0-3-9.md)。
- 🔵 `P0-1-11`（解析进度可视化）：代码完成 2026-09-17，**待用户验收**；
  卡面只有卡表行，无独立详情卡。见 [`cards/P0-1.md`](./cards/P0-1.md)。

**未开卡的已知缺口（防止「没人记得」）**
- 🔴 同步层 tasks 写入不幂等（每轮 `updated 2`，两条 `graded` + 小数分）——
  Steven 已拍板「单开小卡查」，**卡至今未开**。见 [`cards/progress-pointer-archive.md`](./cards/progress-pointer-archive.md) 与 `.workbuddy/memory/MEMORY.md` 开放问题。
"""

ADDED_POINTER = """\
## 详情见 `docs/cards/`

- **逐卡索引**（卡号 → 文件 → 状态 → 该读哪几份 Docs）：[`docs/cards/README.md`](./cards/README.md)
- **阶段整段归档**：P0-0 / P0-1 / P0-2 / P0-3-overview 各一份（见上方「去向」表）
- **历史变更记录**：[`docs/Phase-0-changelog.md`](./Phase-0-changelog.md)
- **进度指针全量**：[`docs/cards/progress-pointer-archive.md`](./cards/progress-pointer-archive.md)

> 本索引与 `docs/cards/` 由 `scripts/split-phase0-docs.py` 机械生成（只搬家不重写），
> 由 `scripts/verify-phase0-docs-split.py` 校验。
"""


def header_for(src_range: str, what: str) -> str:
    """每个外迁文件的出处标注（新增行，计入新增不计入原文）。"""
    return (
        f"<!-- 出处：docs/Phase-0-MVP.md {src_range}｜{what}｜"
        f"2026-09-18 拆分，逐字保留 -->\n\n"
    )


def main() -> int:
    baseline = load_baseline()
    lines = to_lines(baseline)
    total_lines = len(lines)

    # ── 前置：切分表必须无缝覆盖且有边界断言 ──
    expect = 1
    for key, a, b in SECTIONS:
        if a != expect:
            raise SystemExit(f"切分表不连续：{key} 期望从 L{expect} 开始，实为 L{a}")
        if b < a:
            raise SystemExit(f"切分表范围非法：{key} L{a}-L{b}")
        expect = b + 1
    if expect != total_lines + 1:
        raise SystemExit(f"切分表未覆盖全文：覆盖到 L{expect - 1}，实际 L{total_lines}")

    def seg(a: int, b: int) -> str:
        return "".join(lines[a - 1:b])

    # ── 边界断言（锚点检查，防基线漂移后切错） ──
    checks = [
        (1, 1, "# Phase-0-MVP.md", "文件首行 h1"),
        (8, 8, "## 使用方式", "使用方式 h2"),
        (30, 30, "## 当前进度指针", "进度指针 h2"),
        (196, 196, "## P0-0 基础设施", "P0-0 h2"),
        (212, 212, "### P0-0 执行卡", "P0-0 执行卡 h3"),
        (276, 276, "## P0-1 M1", "P0-1 h2"),
        (298, 298, "### P0-1 执行卡", "P0-1 执行卡 h3"),
        (598, 598, "## P0-2 M2", "P0-2 h2"),
        (619, 619, "### P0-2 执行卡", "P0-2 执行卡 h3"),
        (1099, 1099, "## P0-3 打磨收敛期", "P0-3 h2"),
        (1136, 1136, "**排序纪律", "排序纪律"),
        (1158, 1158, "## P0-4 验证期", "P0-4 h2"),
        (1173, 1173, "### P0-3 执行卡", "P0-3 执行卡 h3"),
        (1177, 1177, "#### 🎫 P0-3-1 ·", "P0-3 首卡锚点"),
        (1816, 1816, "## 关键路径与并行建议", "关键路径 h2"),
        (1834, 1834, "## 风险登记", "风险登记 h2"),
        (1845, 1845, "## 变更记录", "变更记录 h2"),
        (total_lines, total_lines, "_", "文件末行存在性"),
    ]
    for ln, _col, needle, label in checks:
        if needle == "_":
            continue
        actual = lines[ln - 1]
        if not actual.startswith(needle):
            raise SystemExit(
                f"锚点断言失败 [{label}]：L{ln} 应为 {needle!r}，实际 {actual[:90]!r}\n"
                f"→ 基线已漂移，切分表需要按新锚点重算，禁止盲目重跑。"
            )
    print(f"✓ 锚点断言 17/17 通过（基线 {total_lines} 行）")

    # ── 组装 chunk 列表 ──
    chunks: list[dict] = []          # {target, src, text}
    for key, a, b in SECTIONS:
        if key == "P0-3-CARDS":
            continue
        chunks.append({"target": key, "src": f"L{a}–L{b}", "text": seg(a, b)})

    # P0-3 卡：按 #### 🎫 锚点二次切
    card_anchors = [
        i + 1 for i in range(1177 - 1, 1815)
        if CARD_ANCHOR.match(lines[i])
    ]
    if len(card_anchors) != 23:
        raise SystemExit(f"P0-3 卡锚点数异常：期望 23，实际 {len(card_anchors)}")
    for idx, start in enumerate(card_anchors):
        end = (card_anchors[idx + 1] - 1) if idx + 1 < len(card_anchors) else 1815
        m = CARD_ANCHOR.match(lines[start - 1])
        card = m.group(1)
        # 卡号形如 P0-3-7b；文件名去掉前缀
        fname = card
        chunks.append({
            "target": f"cards:{fname}",
            "src": f"L{start}–L{end}",
            "text": seg(start, end),
            "card": card,
        })
    print(f"✓ P0-3 卡锚点 23/23 命中"
          f"（{', '.join(c['card'] for c in chunks if c.get('card'))}）")

    # ── 输出文件映射 ──
    def out_path(target: str) -> Path:
        if target == "index":
            return REPO / "docs/Phase-0-MVP.md"
        if target == "changelog":
            return REPO / "docs/Phase-0-changelog.md"
        if target == "pointer_archive":
            return REPO / "docs/cards/progress-pointer-archive.md"
        if target.startswith("cards:"):
            return REPO / f"docs/cards/{target.split(':', 1)[1]}.md"
        return REPO / f"docs/cards/{target}.md"

    # ── 分组 & 组装（index 需插入新增块；其余仅加出处注释） ──
    grouped: dict[str, list[dict]] = {}
    for c in chunks:
        grouped.setdefault(c["target"], []).append(c)

    written: list[dict] = []

    for target, cs in grouped.items():
        path = out_path(target)
        body = "".join(c["text"] for c in cs)

        if target == "index":
            # 薄索引：原文块之间插入两个新增块
            # 顺序：1-29 → [新增 拆分说明+压缩指针] → 196-1172 → 1816-1844 → [新增 指针段]
            # 顺序：原文 1-29 → [新增 拆分说明+压缩指针] → 各阶段卡表 → 关键路径+风险登记 → [新增 指针段]
            first: list[str] = []
            tables: list[str] = []
            rest: list[str] = []
            for c in cs:
                if c["src"] == "L1–L29":
                    first.append(c["text"])
                elif c["src"] == "L1816–L1844":
                    rest.append(c["text"])
                else:
                    tables.append(c["text"])
            content = (
                "".join(first)
                + "\n"
                + ADDED_INTRO
                + "\n"
                + "".join(tables)
                + "\n"
                + "".join(rest)
                + "\n"
                + ADDED_POINTER
            )
        elif target.startswith("cards:"):
            content = (
                f"<!-- 出处：docs/Phase-0-MVP.md"
                f" {cs[0]['src']}｜P0-3 执行卡"
                f"｜2026-09-18 拆分，逐字保留 -->\n\n" + body
            )
        elif target == "P0-3-overview":
            content = (
                header_for("L1136–L1155 / L1173–L1176",
                           "P0-3 排序纪律 + 明确移出 M3 + 执行卡前言") + body
            )
        else:
            label = {"pointer_archive": "当前进度指针（166 行全量留档）",
                     "P0-0": "P0-0 基础设施 · 执行卡",
                     "P0-1": "P0-1 M1 · 执行卡",
                     "P0-2": "P0-2 M2 · 执行卡",
                     "changelog": "变更记录（历史）"}[target]
            content = header_for(cs[0]["src"], label) + body

        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        written.append({
            "target": target,
            "path": str(path.relative_to(REPO)),
            "sources": [c["src"] for c in cs],
            "original_chars": sum(len(c["text"]) for c in cs),
            "file_chars": len(content),
        })

    # ── manifest（记账：原文 vs 新增） ──
    orig_total = sum(len(c["text"]) for c in chunks)
    if orig_total != len(baseline):
        raise SystemExit(
            f"原文总量自检失败：chunk 合计 {orig_total} ≠ 基线 {len(baseline)}"
        )

    manifest = {
        "baseline_rev": subprocess.run(
            ["git", "rev-parse", BASELINE_REV], cwd=REPO,
            capture_output=True, check=True,
        ).stdout.decode().strip(),
        "baseline_chars": len(baseline),
        "baseline_bytes": len(baseline.encode("utf-8")),
        "baseline_lines": total_lines,
        "chunks": [{"target": c["target"], "src": c["src"],
                    "chars": len(c["text"]),
                    "head": c["text"][:60],
                    "tail": c["text"][-60:],
                    "card": c.get("card")} for c in chunks],
        "files": written,
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                        encoding="utf-8")

    print()
    print(f"基线：{total_lines} 行 / {len(baseline)} 字符 / "
          f"{len(baseline.encode('utf-8'))} 字节 (rev {manifest['baseline_rev'][:7]})")
    print(f"写出 {len(written)} 个文件：")
    for w in sorted(written, key=lambda x: x["path"]):
        print(f"  {w['original_chars']:>7} 原文 {w['file_chars']:>7} 实际  {w['path']}")
    print(f"\n原文总量：{orig_total}（= 基线 {len(baseline)}）✓")
    print(f"manifest → {MANIFEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
