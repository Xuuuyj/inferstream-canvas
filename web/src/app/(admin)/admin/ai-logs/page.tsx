import { redirect } from "next/navigation";

// 第一期替用户调模型的路由已下线，没有 AI 日志可看；菜单里已去掉，直接打开地址也回后台首页。
export default function AdminAICallLogsPage() {
    redirect("/admin");
}
