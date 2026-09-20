/**
 * 站点署名水印（P0-3-33）。
 *
 * ### 只出现在登录 / 注册页 —— **不许全站铺**
 * 铺满全站会变成 admin 面板那种"到处盖个戳"的味道，也与 Tempo 的 hands-off 调性冲突
 * （ADR-016：产品越不打扰越好）。登录页是唯一"用户还没进入产品、页面本身没有内容"
 * 的地方，一行署名在那儿是装饰而不是噪音。注册页同理（同一对页面，一侧有一侧没有会很怪）。
 *
 * ### 为什么抽成组件
 * 登录页与注册页各写一遍就会出现两份措辞 —— 改一处忘一处，两边显示不同的署名。
 * 署名这种东西一旦不一致，看起来就是"有人改了一半"。
 */
export function BuildSignature() {
  return (
    <p className="text-[11px] tracking-wide text-ink-faint">Build by Youcheng Li · UC Berkeley</p>
  )
}
