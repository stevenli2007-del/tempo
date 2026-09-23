#!/usr/bin/env python3
"""校验 Phase-0-MVP.md 的拆分：只搬家、没重写、没丢东西。

三条断言（对应任务书硬性要求 2）：
  ① 字符总量：拆分前原始行的字符总量 == 拆分后所有文件里「原文行」的字符总量。
     新增的指针 / 标题 / 出处注释单独计数，不混进去。
  ② 逐卡逐字：每一张 P0-3 卡的原文，在其新文件里**逐字出现**
     （用「完整子串命中」+ 原文长度 + 首尾片段三重校验）。
  ③ 卡号清单：拆分前卡号集合 == 拆分后卡号集合，一张不多一张不少。

核心手法 = 「行游标」：对每个输出文件，按契约顺序推进基线行的游标；
  命中的算原文，没命中的算新增。这样可以机械地把「原文/新增」分开，
  且任何一处改写（某行内容变了）都会让它落进「新增」→ 字数对不上 → 报警。
  本脚本**不读** split 脚本的 manifest，独立重算。

用法：python3 scripts/verify-phase0-docs-split.py
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
if not (REPO / "docs" / "Phase-0-MVP.md").exists():
    REPO = Path("/Users/youchengli/Desktop/Tempo")

SRC_REL = "docs/Phase-0-MVP.md"
# 拆分**前**的版本。🔴 **必须写死 commit，绝不能用 "HEAD"**：
# 拆分一旦提交，HEAD 就变成薄索引（227 行），下方 CONTRACT 里的 1914 行基线
# 会全部越界 → IndexError 崩溃（2026-09-18 实测）。
# 将来若再整体重切：把这里改成「新一次拆分前」的 commit，并同步更新 CONTRACT。
BASELINE_REV = "f625a5a"       # 拆分前最后一版 1914 行清单（= 4881c1d 的父提交）

# 契约：每个输出文件应该承载基线的哪些行范围（1-based 闭区间，按顺序）
CONTRACT: dict[str, list[tuple[int, int]]] = {
    "docs/Phase-0-MVP.md": [
        (1, 29), (196, 211), (276, 297), (598, 618),
        (1099, 1135), (1156, 1172), (1816, 1844),
    ],
    "docs/cards/progress-pointer-archive.md": [(30, 195)],
    "docs/cards/P0-0.md": [(212, 275)],
    "docs/cards/P0-1.md": [(298, 597)],
    "docs/cards/P0-2.md": [(619, 1098)],
    "docs/cards/P0-3-overview.md": [(1136, 1155), (1173, 1176)],
    "docs/Phase-0-changelog.md": [(1845, 1914)],
    # P0-3 各卡的范围按 🎫 锚点动态推导，见下
}

CARD_ANCHOR = re.compile(r"^#### 🎫 (P0-3-\S+?) · ")
CARD_RE = re.compile(r"P0-[0-4]-\d+[a-z]?")

# ── 已声明修订（2026-09-18，经 Steven 裁决）────────────────────────────────
# 拆分时发现「薄索引卡表状态」与「详情文件标题状态」有 9 处矛盾，
# Steven 裁决「一律以卡表为准」→ 机械对齐标题里的状态标记。
# **只改状态标记，不动正文。** 除下面这 9 处之外，任何一行与基线的差异都算事故。
# 表达为 (文件, 行前缀, 旧后缀, 新后缀)；行以旧后缀结尾者替换为新后缀。
DECLARED_EDITS: list[tuple[str, str, str, str]] = [
    ("docs/cards/P0-2.md", "## P0-2-11 总览页合并：",
     "🔵 开工中（2026-09-05 晚）",
     "✅ 已验收 2026-09-05 深夜（28/28 核对，零功能代码，M2 收官）"),
    ("docs/cards/P0-3-1.md", "#### 🎫 P0-3-1 · 量化指标埋点（",
     "🔵 代码完成 2026-09-07，Bud；待 Steven 跑迁移 + 验收）",
     "✅ 已验收 2026-09-09）"),
    ("docs/cards/P0-3-3.md", "#### 🎫 P0-3-3 · 设计基线：移植 Stride 令牌 + 应用外壳 ",
     "⚪", "✅ 已验收 2026-09-13"),
    ("docs/cards/P0-3-4.md", "#### 🎫 P0-3-4 · 解析质量修复：`L1–L40` 讲座编号课表漏抽 ",
     "⚪", "✅ 已验收 2026-09-13"),
    ("docs/cards/P0-3-5.md", "#### 🎫 P0-3-5 · 模块与上传解耦 ",
     "⚪", "✅ 验收 2026-09-13"),
    ("docs/cards/P0-3-6.md", "#### 🎫 P0-3-6 · 总览页列表收敛 ",
     "⚪", "✅ 验收 2026-09-13"),
    ("docs/cards/P0-3-16.md", "#### 🎫 P0-3-16 · Dashboard 精修（文案 + 今日任务） ",
     "🔵 **代码完成 2026-09-17，待 Steven 验收**",
     "✅ **验收通过 2026-09-17**"),
    ("docs/cards/P0-3-18.md", "#### 🎫 P0-3-18 · 消息栏（侧栏入口 + 全屏对话页） ",
     "⚪", "✅ **验收通过 2026-09-17 晚**"),
    ("docs/Phase-0-MVP.md", "| **P0-3-25b** |",
     "| ⚪ |", "| ✅ **Steven 验收通过 2026-09-18** |"),
    ("docs/Phase-0-MVP.md", "| **P0-1-11** |",
     "| ✅ 代码完成（2026-09-17；重新定性为\"解析进度四阶段 stepper\"，纯前端独立组件，不触碰 3-26 的 messages 路径；待用户验收） |",
     "| ✅ 已验收 2026-09-21（四阶段 stepper + 文本预览；tsc/eslint/build 全绿） |"),
]

# ── 已声明修订（其二）：相对链接 / 页内锚点重定基（2026-09-18，拆分的机械副作用）──
# 「只搬家不重写」会把原文里**相对 docs/ 的链接**一起搬进 docs/cards/，
# 于是 `./Decisions.md#adr-0xx` 在新位置指向不存在的 docs/cards/Decisions.md（8 处失效）；
# 薄索引里两个页内锚点也因为标题改名 / 含 `→` 而失效（2 处）。
# 这些都是纯路径重定基，**不碰任何文字**。表达为 (文件, 旧子串, 新子串)。
DECLARED_SUBS: list[tuple[str, str, str]] = [
    # 8 处 ADR 链接：`./Decisions.md` → `../Decisions.md`
    ("docs/cards/P0-1.md", "(./Decisions.md#", "(../Decisions.md#"),
    ("docs/cards/P0-2.md", "(./Decisions.md#", "(../Decisions.md#"),
    ("docs/cards/progress-pointer-archive.md",
     "(./Decisions.md#", "(../Decisions.md#"),
    # 2 处薄索引页内锚点
    ("docs/Phase-0-MVP.md",
     "](#p0-4-验证期m4--原-gate-0→1-内容下移)",
     "](#p0-4-验证期m4-原-gate-01-内容下移)"),
    ("docs/Phase-0-MVP.md",
     "](#当前进度指针)",
     "](./cards/progress-pointer-archive.md#当前进度指针)"),
]

# ── 已声明新增卡（拆分**之后**才开的卡，不在基线卡号集合里）──
# ③ 卡号集合这条断言守的是「拆分时一张不多一张不少」；拆分之后新开的卡是**计划内**的增量，
# 但同样不该悄悄出现 —— 所以必须在这里逐张登记并写明理由，闸门才继续有意义。
DECLARED_NEW_CARDS: set[str] = {
    'P0-3-28',   # 2026-09-18 新开：同步写入幂等（numeric 定标），必须在 P0-3-13 freeze 之前
    # ── M3 第二批（2026-09-19 Steven 拍板「发布前必须补的六件事」，全部排在 P0-3-12 之前）──
    'P0-3-29',   # 考试写入去重：改期语义 = 更新提案，不新增重复 exam_dates
    'P0-3-30',   # Canvas syllabus 自动发现 + 一键导入（免除用户手动上传）
    'P0-3-31',   # 考试复习模式 v1（含上传额外文件；仅限归类为考试的）
    'P0-3-32',   # 新手引导教程卡 + 侧栏反馈链接（占位符）
    'P0-3-33',   # 视觉区分强化（考试 / 课程色 / 登录页水印）
    'P0-3-34',   # 成绩速记最小版 + 成绩条（明确不做独立成绩单视图）
    'P0-3-35',   # 2026-09-23 新开：总览取数「已完成的历史吃掉窗口」修复 + 重复考试行诊断（数据准确性 bug，按 Steven 拍板排在 P0-3-12 之前）
}


def declared_edit(rel: str, line: str) -> tuple[str, int | None, int | None]:
    """若该行命中已声明修订，返回 (新行, 后缀修订下标, 子串修订下标)；否则原样返回。"""
    body = line[:-1] if line.endswith("\n") else line
    nl = "\n" if line.endswith("\n") else ""
    for idx, (f, old_sub, new_sub) in enumerate(DECLARED_SUBS):
        if f == rel and old_sub in body:
            return body.replace(old_sub, new_sub) + nl, None, idx
    for idx, (f, prefix, old_sfx, new_sfx) in enumerate(DECLARED_EDITS):
        if f == rel and body.startswith(prefix) and body.endswith(old_sfx):
            cut = len(body) - len(old_sfx) if old_sfx else len(body)
            return body[:cut] + new_sfx + nl, idx, None
    return line, None, None

failures: list[str] = []
notes: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def load_baseline() -> str:
    out = subprocess.run(
        ["git", "show", f"{BASELINE_REV}:{SRC_REL}"],
        cwd=REPO, capture_output=True, check=True,
    )
    return out.stdout.decode("utf-8")


def to_lines(text: str) -> list[str]:
    parts = text.split("\n")
    if parts[-1] != "":
        raise SystemExit("基线不以换行结尾")
    lines = [p + "\n" for p in parts[:-1]]
    assert "".join(lines) == text
    return lines


def main() -> int:
    baseline = load_baseline()
    base_lines = to_lines(baseline)

    # ── 动态推导 P0-3 各卡的范围 ──
    anchors: list[tuple[int, str]] = []
    for i, ln_text in enumerate(base_lines):
        if CARD_ANCHOR.match(ln_text):
            anchors.append((i + 1, ln_text))
    card_ranges: list[tuple[str, int, int]] = []
    for idx, (start, line) in enumerate(anchors):
        end = anchors[idx + 1][0] - 1 if idx + 1 < len(anchors) else 1815
        card_ranges.append((CARD_ANCHOR.match(line).group(1), start, end))

    contract = dict(CONTRACT)
    for card, a, b in card_ranges:
        contract[f"docs/cards/{card}.md"] = [(a, b)]
    # README 是纯新增文件，不承载任何原文行
    contract["docs/cards/README.md"] = []

    print("=" * 78)
    print("Phase-0 文档拆分校验")
    print("=" * 78)
    print(f"基线：{SRC_REL} @ {BASELINE_REV}"
          f"  {len(base_lines)} 行 / {len(baseline)} 字符 / "
          f"{len(baseline.encode('utf-8'))} 字节")
    print()

    # ═══════════ ① 字符总量 ═══════════
    orig_chars_total = 0
    added_chars_total = 0
    edited_delta = 0                            # 已声明修订带来的净字符变化
    applied_edits: set[int] = set()             # 哪些状态修订被真正用上
    applied_subs: set[int] = set()              # 哪些链接/锚点重定基被真正用上
    added_lines_all: list[str] = []
    consumed_all: list[tuple[str, int]] = []   # (文件名, 基线行号)
    per_file: list[tuple[str, int, int, int]] = []

    for rel, ranges in sorted(contract.items()):
        path = REPO / rel
        if not path.exists():
            fail(f"① 缺少输出文件：{rel}")
            continue

        content = path.read_text(encoding="utf-8")
        out_lines = [l + "\n" for l in content.split("\n")]
        if content.endswith("\n"):
            out_lines = out_lines[:-1]        # 末元素是终止符产物

        expected: list[tuple[int, str]] = []
        for a, b in ranges:
            for ln in range(a, b + 1):
                t = base_lines[ln - 1]
                t2, decl, sub = declared_edit(rel, t)
                if decl is not None:
                    edited_delta += len(t2) - len(t)
                    applied_edits.add(decl)
                    t = t2
                if sub is not None:
                    edited_delta += len(t2) - len(t)
                    applied_subs.add(sub)
                    t = t2
                expected.append((ln, t))

        i = 0
        added_here: list[str] = []
        consumed_here: list[int] = []
        for ol in out_lines:
            if i < len(expected) and ol == expected[i][1]:
                consumed_here.append(expected[i][0]); i += 1
            else:
                added_here.append(ol)

        if i != len(expected):
            fail(f"① {rel}：预期承载 {len(expected)} 行原文，只能匹配到 {i} 行"
                 f"（第 {i + 1} 个预期行 = 基线 L{expected[i][0] if i < len(expected) else '-'}）")

        o = sum(len(t) for _, t in expected[:i])
        ad = sum(len(t) for t in added_here)
        orig_chars_total += o
        added_chars_total += ad
        added_lines_all += added_here
        consumed_all += [(rel, ln) for ln in consumed_here]
        per_file.append((rel, o, ad, len(content)))

    # 覆盖率：基线的每一行都应被某个文件消耗，且**只消耗一次**
    consumed_counts: dict[int, int] = {}
    for _rel, ln in consumed_all:
        consumed_counts[ln] = consumed_counts.get(ln, 0) + 1

    missing = [ln for ln in range(1, len(base_lines) + 1) if ln not in consumed_counts]
    dup = {ln: c for ln, c in consumed_counts.items() if c > 1}

    expected_total = len(baseline) + edited_delta
    print("① 字符总量")
    print(f"  拆分前原始行字符总量 : {len(baseline)}")
    print(f"  已声明修订净变化     : {edited_delta:+d}"
          f"（{len(applied_edits)}/{len(DECLARED_EDITS)} 处状态统一；"
          f"{len(applied_subs)}/{len(DECLARED_SUBS)} 处链接重定基）")
    print(f"  拆分后原文行字符总量 : {orig_chars_total}（应 = {expected_total}）")
    print(f"  新增内容字符总量     : {added_chars_total}"
          f"（{len(added_lines_all)} 行，单独计数，不混入上面两个数）")
    if missing:
        fail(f"① 有 {len(missing)} 行基线内容没有任何落点，例如 L{missing[:5]}")
    if dup:
        fail(f"① 有 {len(dup)} 行基线内容被重复承载，例如 L{list(dup)[:5]}×{list(dup.values())[:5]}")
    if len(applied_edits) != len(DECLARED_EDITS):
        fail(f"① 声明的 {len(DECLARED_EDITS)} 处修订只命中 {len(applied_edits)} 处"
             f"（未命中下标：{sorted(set(range(len(DECLARED_EDITS))) - applied_edits)}）")
    if len(applied_subs) != len(DECLARED_SUBS):
        fail(f"① 声明的 {len(DECLARED_SUBS)} 处链接/锚点重定基只命中 {len(applied_subs)} 处"
             f"（未命中下标：{sorted(set(range(len(DECLARED_SUBS))) - applied_subs)}）")
    if orig_chars_total != expected_total:
        fail(f"① 字符总量不等：{orig_chars_total} ≠ {expected_total}"
             f"（基线 {len(baseline)}，修订净变化 {edited_delta:+d}）")
    if (not missing and not dup and orig_chars_total == expected_total
            and len(applied_edits) == len(DECLARED_EDITS)
            and len(applied_subs) == len(DECLARED_SUBS)):
        print(f"  ✓ 通过（{len(base_lines)} 行全部有且只有一个落点；"
              f"另有 {len(applied_edits)} 处已声明状态修订"
              f" + {len(applied_subs)} 处已声明链接重定基）")
    print()

    # ═══════════ ② 逐卡逐字 ═══════════
    print("② 逐卡逐字（23 张 P0-3 卡）")
    bad_cards: list[str] = []
    for card, a, b in card_ranges:
        rel = f"docs/cards/{card}.md"
        path = REPO / rel
        if not path.exists():
            bad_cards.append(f"{card}（缺文件）")
            continue
        content = path.read_text(encoding="utf-8")
        # 卡的原文 = 基线原文 + 该文件上已声明的状态修订
        text = "".join(
            declared_edit(rel, base_lines[ln - 1])[0]
            for ln in range(a, b + 1)
        )
        hit = text in content
        head_ok = text[:60] in content
        tail_ok = text[-60:] in content
        if not (hit and head_ok and tail_ok):
            bad_cards.append(
                f"{card}（逐字命中={hit} 首段={head_ok} 尾段={tail_ok}）"
            )
        else:
            print(f"  ✓ {card:<10} L{a}–L{b}  {len(text):>5} 字符  逐字命中")
    if bad_cards:
        fail(f"② 有卡未逐字出现：{', '.join(bad_cards)}")
    else:
        print(f"  ✓ 通过（{len(card_ranges)}/{len(card_ranges)} 张卡原文逐字保留）")
    print()

    # ═══════════ ③ 卡号集合 ═══════════
    print("③ 卡号清单")
    before = set(CARD_RE.findall(baseline))
    after: set[str] = set()
    for rel in contract:
        p = REPO / rel
        if p.exists():
            after |= set(CARD_RE.findall(p.read_text(encoding="utf-8")))
    only_before = sorted(before - after)
    only_after = sorted(after - before)
    undeclared = sorted(set(only_after) - DECLARED_NEW_CARDS)
    declared_hit = sorted(set(only_after) & DECLARED_NEW_CARDS)
    print(f"  拆分前 {len(before)} 个卡号 / 拆分后 {len(after)} 个")
    if only_before:
        fail(f"③ 拆分后丢失卡号：{only_before}")
    if undeclared:
        fail(f"③ 拆分后凭空多出卡号（且未在 DECLARED_NEW_CARDS 登记）：{undeclared}")
    if not only_before and not undeclared:
        extra = f"；已登记的新卡 {declared_hit}" if declared_hit else ""
        print(f"  ✓ 通过（无丢失、无未登记新增{extra}）")
    print()

    print()
    print("=" * 78)
    if failures:
        print(f"❌ 校验失败（{len(failures)} 项）")
        for f in failures:
            print(f"   - {f}")
        print("=" * 78)
        return 1
    print("✅ 校验全部通过")
    print(f"   ① 原文总量 {orig_chars_total} 字符 = 基线 {len(baseline)} "
          f"{edited_delta:+d}（{len(applied_edits)} 处已声明状态统一" 
          f" + {len(applied_subs)} 处已声明链接重定基）；"
          f"逐行覆盖无遗漏、无重复、无未声明改写")
    print(f"   ② {len(card_ranges)} 张 P0-3 卡原文逐字保留")
    print(f"   ③ 卡号集合相同（{len(before)} 个）")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
