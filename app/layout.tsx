import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { cn } from "@/lib/utils";
import { ThemeScript } from "@/components/shell/theme-script";
import { getLang } from "@/lib/i18n/server";
import { t } from "@/lib/i18n/translate";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export async function generateMetadata(): Promise<Metadata> {
  const lang = await getLang();
  return {
    title: "Tempo",
    description: t(lang, "app.description"),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // P0-5-1：<html lang> 跟随用户语言偏好（tempo-lang cookie），无 cookie → zh-CN。
  const lang = await getLang();
  return (
    // suppressHydrationWarning：ThemeScript 在 React 水合**之前**就往 <html>
    // 加了 `dark` 类（这是「无闪烁」的必要手段），服务端 HTML 里必然没有它。
    // 不加这行 → React 报 hydration mismatch → 开发环境整页被报错浮层压暗。
    // 只作用于 <html> 自身的属性差异，不掩盖子树里的真实 hydration 问题。
    <html lang={lang === "en" ? "en" : "zh-CN"} suppressHydrationWarning className={cn(geistSans.variable)}>
    <body className={`${geistMono.variable} antialiased`}>
      <ThemeScript />
      {children}
    </body>
    </html>
  );
}
