#!/usr/bin/env python3
"""docs/ 内部链接与页内锚点体检（只读，零写入）。

为什么要有这个脚本：
  2026-09-18 的 Phase-0-MVP.md 瘦身（「只搬家不重写」）把 docs/ 下的一整段
  搬进 docs/cards/，原文里 `./Decisions.md#adr-0xx` 这类**相对 docs/ 的链接**
  跟着搬了家 → 在新位置指向不存在的 docs/cards/Decisions.md（8 处失效），
  而 `verify-phase0-docs-split.py` 只守「原文有没有被改写」，**不守链接可达性**，
  所以没人发现。这个脚本补的就是那一半。

查两类：
  ① 相对路径指向的文件不存在（搬家后最常见）
  ② 页内 / 跨文件锚点在目标文件的标题里找不到（GitHub 的 slug 规则近似实现）

【2026-09-18 已清零】原先 84 处「既有债」（80 处 `#adr-00x` + 4 处 `#gate-X→Y`）已一次性修完，
`KNOWN_DEBT_PREFIXES` 随之收紧为空 —— **现在任何锚点失配都算失败**。修法（不碰任何链接文本，
因此不会破坏 `verify-phase0-docs-split.py` 的逐字契约）：
  - `#adr-00x`：`Decisions.md` 标题 slug 不是 `adr-003` → 已给 27 个 ADR 标题各插一行
    `<a id="adr-0NN"></a>`（锚点值 = 链接文本，两者对齐）。
  - `#gate-0→1`：`→` 会被 GitHub 剥掉 → 已给 4 个 Gate 标题各插 `<a id="gate-X→Y"></a>`。
  ⚠️ 配套要求：`anchors_of()` 必须认「显式锚点」，否则插了 `<a id=…>` 也照样被判失配。

用法：python3 scripts/check-docs-links.py            # 全量
      python3 scripts/check-docs-links.py --strict    # 含上面两类既有债（用于清零时）
退出码：0 = 无新问题；1 = 有新问题。
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
if not (REPO / "docs" / "Phase-0-MVP.md").exists():
    REPO = Path("/Users/youchengli/Desktop/Tempo")

LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)\s]+)\)")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$", re.M)
# 显式锚点（`<a id="adr-003"></a>` / `<a name="…">`）：GitHub 与本地渲染器都认，是「标题 slug 不是人写
# 的那个词」时的正解 —— 改标题会牵动别处引用，改链接会破坏拆分契约，插锚点两边都不动。
EXPLICIT_ANCHOR_RE = re.compile(r"""<a\s+(?:id|name)\s*=\s*["']([^"']+)["']""", re.I)

# 既有债白名单（锚点前缀）。2026-09-18 清零后收紧为空：白名单里留前缀 = 放过一整类锚点，
# 所以只在「确有还未修的整类债」时才往里加，并在注释里写明数量与计划。
KNOWN_DEBT_PREFIXES: tuple[str, ...] = ()


def slug(title: str) -> str:
    """近似 GitHub 的标题 → 锚点：小写、剥标点（含 →）、空格转连字符。"""
    s = title.strip().lower()
    s = re.sub(r"[^\w\u4e00-\u9fff\- ]", "", s)
    return s.replace(" ", "-")


def anchors_of(text: str) -> set[str]:
    """目标文件里所有合法锚点：标题 slug（含重复标题的 -1/-2/-3 后缀）+ 显式 `<a id=…>`。

    显式锚点这一半是 2026-09-18 补的 —— 没有它，`<a id="adr-003"></a>` 这类修法等于白插：
    链接 `#adr-003` 依然落在「标题 slug 集合」之外，被判失配。
    """
    base = {slug(m.group(2)) for m in HEADING_RE.finditer(text)}
    dup = {f"{a}-{i}" for a in base for i in range(1, 4)}
    explicit = set(EXPLICIT_ANCHOR_RE.findall(text))
    return base | dup | explicit


def is_known_debt(anchor: str) -> bool:
    return anchor.startswith(KNOWN_DEBT_PREFIXES)


def main() -> int:
    strict = "--strict" in sys.argv
    missing_file: list[tuple[str, str]] = []
    bad_anchor: list[tuple[str, str]] = []
    debt: Counter[str] = Counter()

    for f in sorted(REPO.glob("docs/**/*.md")):
        text = f.read_text(encoding="utf-8")
        own = anchors_of(text)
        for m in LINK_RE.finditer(text):
            target = m.group(2)
            if target.startswith(("http://", "https://", "mailto:")):
                continue
            path_part, _, anchor = target.partition("#")
            if path_part:
                dest = (f.parent / path_part).resolve()
                if not dest.exists():
                    missing_file.append((str(f.relative_to(REPO)), target))
                    continue
                dest_text = dest.read_text(encoding="utf-8") if dest.suffix == ".md" else ""
                pool = anchors_of(dest_text)
            else:
                pool = own
            if not anchor:
                continue
            if anchor in pool:
                continue
            if is_known_debt(anchor):
                debt[anchor] += 1
                if strict:
                    bad_anchor.append((str(f.relative_to(REPO)), target))
                continue
            bad_anchor.append((str(f.relative_to(REPO)), target))

    print("=" * 70)
    print("docs/ 链接体检")
    print("=" * 70)

    print(f"\n① 指向不存在的文件：{len(missing_file)} 处")
    for f, t in missing_file:
        print(f"   ✗ {f} -> {t}")
    if not missing_file:
        print("   ✓ 无")

    print(f"\n② 锚点失效（新）：{len(bad_anchor)} 处")
    for f, t in bad_anchor:
        print(f"   ✗ {f} -> {t}")
    if not bad_anchor:
        print("   ✓ 无")

    print(f"\n③ 既有债（非 --strict 不计失败）：{sum(debt.values())} 处")
    for a, c in debt.most_common():
        print(f"   · {a:<12} {c} 处")

    print()
    print("=" * 70)
    if missing_file or bad_anchor:
        print(f"❌ 有 {len(missing_file) + len(bad_anchor)} 处新问题")
        print("=" * 70)
        return 1
    print("✅ 链接体检通过"
          + ("" if strict else f"（另有 {sum(debt.values())} 处既有锚点债，--strict 可见）"))
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
