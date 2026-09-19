/**
 * P0-3-30 回归：syllabus「从 Canvas 资料选一份」的**判定层**
 * （不依赖数据库、不依赖网络、不调模型）。
 *
 * 运行：`npm run regress:syllabus-import`
 *
 * 钉死四件事，它们分叉起来全都是"两边都绿、只有真机能发现"的那种：
 * 1. **三道闸门**（`checkFetchable`）：抽得动 / Tempo 读不了 / 太大。
 *    🔴 与「一键总结」（3-19b）、自测卷（3-23）、大纲漂移（3-20）**共用同一份** ——
 *    分叉的表现是"总结能读的文件、导入说不支持"。
 * 2. **清单排序**（`buildSyllabusImportCandidates`）：大纲命名者排最前、抽不动的排最后、
 *    且**必须是全序**（同分时留 DB 顺序就会让清单每次打开顺序不一样）。
 * 3. **抽不动的文件也要列出来**并给"Tempo 读不了"的原因 —— 不显示等于诬告
 *    "Canvas 上没传大纲"。
 * 4. **站内路径守卫**：`syllabi.file_url` 写的是站内路径，绝不能是 Canvas 的能力 `url`
 *    （`//host` 是协议相对外链，肉眼几乎看不出来）。
 */

import { MAX_DOWNLOAD_BYTES, checkFetchable } from "@/lib/course-files/fetch-content"
import { buildInternalPath, readInternalPath } from "@/lib/internal-path"
import { buildSyllabusImportCandidates } from "@/lib/syllabus-import/candidates"
import type { SyllabusFileCandidate } from "@/lib/syllabus-drift/files"

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

// ---------------------------------------------------------------
// 造数据
// ---------------------------------------------------------------

function file(over: Partial<SyllabusFileCandidate> & { id: string; displayName: string }): SyllabusFileCandidate {
  return {
    canvasFileId: `canvas-${over.id}`,
    folderPath: "",
    contentType: null,
    sizeBytes: 200_000,
    modifiedAt: "2026-09-01T00:00:00Z",
    isDeleted: false,
    fileUrl: `https://bcourses.example/files/${over.id}`,
    ...over,
  }
}

const COURSE_ID = "11111111-1111-4111-8111-111111111111"
const FILE_ID = "22222222-2222-4222-8222-222222222222"

// ---------------------------------------------------------------
// 1) 三道闸门（与「一键总结」共用同一份实现）
// ---------------------------------------------------------------

console.log("闸门（发请求之前判：扩展名/MIME → 大小已知 → 不超限）")
{
  const pdf = checkFetchable({ displayName: "Chem1A_Syllabus_Fall2026.pdf", contentType: null, sizeBytes: 278_880 })
  check("PDF → ok", pdf.kind === "ok" && pdf.ext === "pdf", JSON.stringify(pdf))

  // 真例：Chem 1AL 的 `Weekly Review 1 - PDF` 没有点后缀，靠 MIME 认出来。
  const noExt = checkFetchable({ displayName: "Weekly Review 1 - PDF", contentType: "application/pdf", sizeBytes: 1000 })
  check("无后缀但 MIME 是 PDF → ok", noExt.kind === "ok", JSON.stringify(noExt))

  const docx = checkFetchable({ displayName: "syllabus.docx", contentType: null, sizeBytes: 1000 })
  check("docx → ok", docx.kind === "ok" && docx.ext === "docx")

  const png = checkFetchable({ displayName: "Map_1A.png", contentType: "image/png", sizeBytes: 548_366 })
  check("图片 → unsupported", png.kind === "unsupported", JSON.stringify(png))
  check(
    "图片的原因说「Tempo 读不了」而不是「文件没内容」",
    png.kind === "unsupported" && png.reason.includes("Tempo") && !png.reason.includes("没有内容"),
    png.kind === "unsupported" ? png.reason : "",
  )

  const unknown = checkFetchable({ displayName: "syllabus.pdf", contentType: "application/pdf", sizeBytes: null })
  check("大小未知 → unsupported（ADR-026：判不了成本就拒绝）", unknown.kind === "unsupported", JSON.stringify(unknown))

  const huge = checkFetchable({ displayName: "huge.pdf", contentType: null, sizeBytes: MAX_DOWNLOAD_BYTES + 1 })
  check("已知太大 → too_large", huge.kind === "too_large", JSON.stringify(huge))

  // 顺序不能换：图片要在"下载了才发现抽不出字"之前就被判掉。
  const imageTooLarge = checkFetchable({
    displayName: "banner.png",
    contentType: "image/png",
    sizeBytes: MAX_DOWNLOAD_BYTES + 1,
  })
  check("类型闸门优先于大小闸门（图片不拿「太大」当借口）", imageTooLarge.kind === "unsupported")
}

// ---------------------------------------------------------------
// 2) 清单排序（全序 + 抽不动的也要列出来）
// ---------------------------------------------------------------

console.log("清单（排序 / 灰态 / 软删）")
{
  const files: SyllabusFileCandidate[] = [
    file({ id: "a", displayName: "Map_1A.png", contentType: "image/png" }),
    file({ id: "b", displayName: "Syllabus old version 2020 final.pdf", folderPath: "Archive" }),
    file({ id: "c", displayName: "Chem1A_Syllabus_Fall2026.pdf" }),
    file({ id: "d", displayName: "HW1_1A_F26.pdf", folderPath: "Homework" }),
    file({ id: "e", displayName: "Syllabus.pdf" }),
    file({ id: "f", displayName: "OldSyllabus.pdf", isDeleted: true }),
  ]

  const list = buildSyllabusImportCandidates(files, COURSE_ID)

  check("软删的文件不进清单", list.every((item) => item.id !== "f"), list.map((i) => i.id).join(","))
  check("抽不动的也要列出来（不显示 = 诬告「没传大纲」）", list.some((item) => item.id === "a"))

  const png = list.find((item) => item.id === "a")
  check("抽不动的 supported=false 且带原因", png?.supported === false && (png?.reason?.length ?? 0) > 0, JSON.stringify(png))

  // 第 0 档：抽得动 + 名字像 syllabus；根目录 → PDF → 名字短 → 名字 → id。
  const firstTwo = list.slice(0, 2).map((item) => item.displayName)
  check(
    "大纲命名者排最前，且根目录 + 名字短的赢",
    firstTwo[0] === "Syllabus.pdf" && firstTwo[1] === "Chem1A_Syllabus_Fall2026.pdf",
    firstTwo.join(" | "),
  )

  const syllabusNamed = list.filter((item) => item.looksLikeSyllabus && item.supported)
  check("三个 syllabus 命名的都认出来了（含 Archive 里那个）", syllabusNamed.length === 3, String(syllabusNamed.length))
  check("Archive 里的排在根目录之后", list.findIndex((i) => i.id === "b") > list.findIndex((i) => i.id === "c"))

  const lastItem = list[list.length - 1]
  check("抽不动的排最后", lastItem.id === "a", JSON.stringify(lastItem.displayName))

  // 全序：同输入必须同输出（换一下入参顺序，结果不变）。
  const shuffled = buildSyllabusImportCandidates([...files].reverse(), COURSE_ID)
  check(
    "全序：入参顺序变了，清单顺序不变",
    JSON.stringify(shuffled.map((i) => i.id)) === JSON.stringify(list.map((i) => i.id)),
    shuffled.map((i) => i.id).join(","),
  )

  check(
    "file_url 是站内路径（绝不能是 Canvas 能力 url）",
    list.every((item) => item.fileUrl?.startsWith(`/courses/${COURSE_ID}/files/`) === true),
    list[0]?.fileUrl ?? "null",
  )
}

// ---------------------------------------------------------------
// 3) 站内路径守卫
// ---------------------------------------------------------------

console.log("站内路径守卫")
{
  const path = buildInternalPath(["courses", COURSE_ID, "files", FILE_ID])
  check("能拼出 /courses/{cid}/files/{fid}", path === `/courses/${COURSE_ID}/files/${FILE_ID}`, String(path))

  check("协议相对 URL 拼不出来（段里带 / 直接拒）", buildInternalPath(["courses", "a/b"]) === null)
  check("空段 / . / .. 都拒", buildInternalPath(["courses", ""]) === null && buildInternalPath([".."]) === null)
  check("空数组 → null", buildInternalPath([]) === null)

  // 读侧守卫（payload 是 jsonb，一个手工改库就能塞进 //evil.com）
  check("readInternalPath 放行单斜杠站内路径", readInternalPath("/courses/x/files/y") === "/courses/x/files/y")
  check("readInternalPath 拒 //host（协议相对 = 外链）", readInternalPath("//evil.com/x") === null)
  check("readInternalPath 拒反斜杠形式", readInternalPath("/\\evil.com") === null)
  check("readInternalPath 拒 http(s)", readInternalPath("https://evil.com") === null)
  check("readInternalPath 拒非字符串", readInternalPath(42) === null)
  check("readInternalPath 拒控制字符", readInternalPath("/a\nb") === null)
}

// ---------------------------------------------------------------
// 4) 能力凭据绝不落库（写进 syllabi.file_url 的形状）
// ---------------------------------------------------------------

console.log("能力凭据（Canvas url 不落库）")
{
  const canvasUrl =
    "https://bcourses.example/files/123/download?download_frd=1&verifier=abc123"
  check("能力 url 不是站内路径 → 守卫判 null", readInternalPath(canvasUrl) === null)
  const built = buildInternalPath(["courses", COURSE_ID, "files", FILE_ID])
  check("落库的是站内路径，不含 verifier", built !== null && !built.includes("verifier"), String(built))
}

console.log("")
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
