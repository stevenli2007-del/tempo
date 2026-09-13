// 无闪烁暗色初始化：在首次绘制前同步 .dark class，避免亮→暗闪一下。
// 跟随系统（D2），localStorage('tempo-theme') 优先级更高。
export function ThemeScript() {
  const code = `(function(){try{var t=localStorage.getItem('tempo-theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`
  return <script dangerouslySetInnerHTML={{ __html: code }} />
}
