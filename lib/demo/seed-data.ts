/**
 * Demo Workspace 预置数据（P0-1-10）。
 *
 * 数据来源：Steven 提供的真实 syllabus —— Syllabus 2.pdf（CHEM 1A Fall 2026，
 * Berkeley Dr. Debjani Roy & Dr. Alexis Shusterman）。五板块由 lib/parse 的真实解析
 * 结果固化而来（非手写），每条 sourceExcerpt 都是 syllabus 逐字摘录，抗幻觉不破。
 *
 * 约定（Steven 2026-09-03 拍板）：
 * - courseOutline：留空。真实 syllabus 用 L1-L40 讲座编号，解析器 prompt 未覆盖该格式，
 *   稳定漏抽（已在解析层记 bug，归 P0 期后改进卡）。demo 不阻塞于此。
 * - officeHours：留空。原文只写 "see calendar on bCourses"，无具体时间，模型正确返回空。
 *
 * 本文件是静态常量，seed 端点直接复用 persistParsedSections 落库，运行时不再调 LLM。
 */

import type { ParsedSyllabus, ParsedSyllabusResult } from '@/types/parse'
import type { CreateCourseInput } from '@/types/course'

/** Demo 课程的元信息（与五板块解析结果一一对应）。 */
export const DEMO_COURSE: CreateCourseInput = {
  semester: 'Fall 2026',
  courseName: 'Chemistry 1A',
  courseCode: 'CHEM 1A',
  instructorName: 'Dr. Debjani Roy & Dr. Alexis Shusterman',
}

/** 五板块预置数据（真实解析结果固化）。 */
export const DEMO_SEED_SECTIONS: ParsedSyllabus = {
  "gradeComposition": [
    {
      "name": "Lecture participation",
      "weightPercent": 5.45,
      "notes": "1 point per lecture up to a maximum of 30 points; 40 lectures total",
      "sourceExcerpt": "There are 40 lectures; you can earn 1 point per lecture up to a maximum of 30 points."
    },
    {
      "name": "Homework",
      "weightPercent": 9.09,
      "notes": "2.5 points each, graded for accuracy; 28 assignments total, credit for best 20 scores, up to a maximum of 50 points",
      "sourceExcerpt": "These assignments are worth 2.5 points each, graded for accuracy. There are 28 homework assignments total, but you will receive credit for your best 20 scores, up to a maximum of 50 points."
    },
    {
      "name": "Discussion quizzes",
      "weightPercent": 9.09,
      "notes": "5 points each, awarded based on effort; 13 quizzes, credit for best 10 scores, up to a maximum of 50 points",
      "sourceExcerpt": "This discussion will include a quiz worth 5 points, awarded based on effort. There are 13 quizzes; you will receive credit for your best 10 scores, up to a maximum of 50 points."
    },
    {
      "name": "Unit exams",
      "weightPercent": 51.82,
      "notes": "3 exams, 95 points each; lowest unit exam percentage automatically replaced with final exam percentage if it improves overall grade",
      "sourceExcerpt": "285 points for unit exams (3 x 95 points each)"
    },
    {
      "name": "Final exam",
      "weightPercent": 24.55,
      "notes": "135 points",
      "sourceExcerpt": "135 points for final exam"
    }
  ],
  "courseOutline": [],
  "testDates": [
    {
      "examName": "Unit 1 Exam",
      "examDate": "2026-09-22",
      "examTime": "8-10pm Pacific",
      "location": null,
      "sourceExcerpt": "Unit 1 Exam: Tues Sep 22 from 8-10pm Pacific (95 points)",
      "status": "confirmed"
    },
    {
      "examName": "Unit 2 Exam",
      "examDate": "2026-10-20",
      "examTime": "8-10pm Pacific",
      "location": null,
      "sourceExcerpt": "Unit 2 Exam: Tues Oct 20, from 8-10pm Pacific (95 points)",
      "status": "confirmed"
    },
    {
      "examName": "Unit 3 Exam",
      "examDate": "2026-11-10",
      "examTime": "8-10pm Pacific",
      "location": null,
      "sourceExcerpt": "Unit 3 Exam: Tues Nov 10, from 8-10pm Pacific (95 points)",
      "status": "confirmed"
    },
    {
      "examName": "Final Exam",
      "examDate": "2026-12-14",
      "examTime": "3-6pm Pacific",
      "location": null,
      "sourceExcerpt": "Final Exam: Mon Dec 14 from 3-6pm Pacific (135 points)",
      "status": "confirmed"
    }
  ],
  "officeHours": [],
  "submissionPolicy": [
    {
      "description": "Homework assignments are due on gradescope every Thursday and Sunday at 11:59pm.",
      "platformName": "gradescope",
      "sourceExcerpt": "Homework assignments are due on gradescope every Thursday and Sunday at 11:59pm (starting on Aug 27)."
    },
    {
      "description": "Missed discussion quizzes can be downloaded from the bCourses > Assignments section. Email your completed quiz and the follow-up reflection questions to your U/GSI by the end of your discussion section to receive credit.",
      "platformName": "bCourses",
      "sourceExcerpt": "Missed discussion quizzes can be downloaded from the bCourses > Assignments section. Email your completed quiz and the follow-up reflection questions to your U/GSI by the end of your discussion section to receive credit."
    },
    {
      "description": "Homework assignments are submitted electronically by default, and so can be completed remotely in the case of illness or other circumstances preventing you from attending in person. Submit by the “normal” deadline (e.g., 11:59pm on Thurs/Sun) to receive credit.",
      "platformName": null,
      "sourceExcerpt": "Homework assignments are submitted electronically by default, and so can be completed remotely in the case of illness or other circumstances preventing you from attending in person. Submit by the “normal” deadline (e.g., 11:59pm on Thurs/Sun) to receive credit."
    },
    {
      "description": "Late work is not generally accepted.",
      "platformName": null,
      "sourceExcerpt": "Because of the large number of dropped assignments available, late work is not generally accepted."
    }
  ]
}

/**
 * 包成 persistParsedSections 期望的入参形状（每个板块带 ok 标记）。
 * 空板块也标 ok:true + 空数组，确保 replaceAll 走「删旧插新」一致路径。
 */
export function toDemoSectionsResult(): ParsedSyllabusResult['sections'] {
  return {
    gradeComposition: { ok: true, data: DEMO_SEED_SECTIONS.gradeComposition },
    courseOutline: { ok: true, data: DEMO_SEED_SECTIONS.courseOutline },
    testDates: { ok: true, data: DEMO_SEED_SECTIONS.testDates },
    officeHours: { ok: true, data: DEMO_SEED_SECTIONS.officeHours },
    submissionPolicy: { ok: true, data: DEMO_SEED_SECTIONS.submissionPolicy },
  }
}
