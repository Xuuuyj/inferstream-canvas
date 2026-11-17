"use client";

import { downloadRemoteMedia } from "@/services/file-storage";
import { MEDIA_PROXY_LOGIN_REQUIRED, getProxyUrl, isFitMediaUrl } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";

export type VideoFramePosition = "first" | "last" | "current";

export async function captureVideoFrame(source: string, position: VideoFramePosition, currentTime: number) {
    try {
        return await captureFrameDirect(source, position, currentTime);
    } catch (error) {
        // 本地、同源地址截不出就是截不出；openai.fit 的成片退到签名链接时会 302 到没加跨域规则的 OSS，和其他远程地址一样登录后经代理下载到本地再截
        if (getProxyUrl(source) === source && !isFitMediaUrl(source)) throw error;
        if (!useUserStore.getState().token) throw new Error(MEDIA_PROXY_LOGIN_REQUIRED);

        const localUrl = URL.createObjectURL(await downloadRemoteMedia(source));
        try {
            return await captureFrameDirect(localUrl, position, currentTime);
        } finally {
            URL.revokeObjectURL(localUrl);
        }
    }
}

async function captureFrameDirect(source: string, position: VideoFramePosition, currentTime: number) {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    try {
        const metadataLoaded = waitForVideo(video, "loadedmetadata");
        video.src = source;
        video.load();

        await metadataLoaded;
        const endTime = Math.max(0, video.duration - 0.001);
        const time = position === "first" ? 0 : position === "last" ? endTime : Math.min(currentTime, endTime);
        if (time) {
            const seeked = waitForVideo(video, "seeked");
            video.currentTime = time;
            await seeked;
        } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            await waitForVideo(video, "loadeddata");
        }

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d")!.drawImage(video, 0, 0);
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("Failed to capture video frame"))), "image/png"));
    } finally {
        video.removeAttribute("src");
        video.load();
    }
}

function waitForVideo(video: HTMLVideoElement, eventName: "loadedmetadata" | "loadeddata" | "seeked") {
    return new Promise<void>((resolve, reject) => {
        const finish = () => {
            video.removeEventListener(eventName, finish);
            video.removeEventListener("error", fail);
            resolve();
        };
        const fail = () => {
            video.removeEventListener(eventName, finish);
            video.removeEventListener("error", fail);
            reject(new Error("Failed to read video frame"));
        };
        video.addEventListener(eventName, finish);
        video.addEventListener("error", fail);
    });
}
