"use client";

import { useEffect, useState } from "react";
import { Button, Modal } from "antd";

import { announceCanvasTab, isCanvasTabSuperseded } from "@/lib/canvas-tab-guard";

/**
 * 画布页面挂上它：打开时通知别的画布页面停止保存（见 lib/canvas-tab-guard.ts），
 * 本页被更新打开的画布页面取代时弹窗挡住操作；并向浏览器申请持久保存，免得磁盘紧张或久不打开时被浏览器清掉素材。
 */
export function CanvasTabGuard() {
    const [superseded, setSuperseded] = useState(isCanvasTabSuperseded);

    useEffect(() => announceCanvasTab(() => setSuperseded(true)), []);
    useEffect(() => {
        void navigator.storage?.persisted?.().then((persisted) => (persisted ? true : navigator.storage.persist?.())).catch(() => undefined);
    }, []);

    return (
        <Modal
            title="画布已在另一个页面打开"
            open={superseded}
            closable={false}
            maskClosable={false}
            keyboard={false}
            footer={
                <Button type="primary" onClick={() => window.location.reload()}>
                    在这里继续
                </Button>
            }
        >
            <p className="text-sm leading-6">
                你在另一个浏览器标签页里也打开了画布。为免两边互相覆盖、误删素材，本页已停止保存。请关闭本页，回到新打开的那个页面继续。
            </p>
            <p className="mt-2 text-sm leading-6 opacity-70">要在这里继续，点「在这里继续」：本页会刷新并读到最新内容，另一个页面会停止保存。</p>
        </Modal>
    );
}
