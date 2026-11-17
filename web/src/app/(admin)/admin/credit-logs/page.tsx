import { redirect } from "next/navigation";

// 第一期不用算力点（生成走用户自己的 openai.fit 令牌计费）；菜单里已去掉，直接打开地址也回后台首页。
export default function AdminCreditLogsPage() {
    redirect("/admin");
}
