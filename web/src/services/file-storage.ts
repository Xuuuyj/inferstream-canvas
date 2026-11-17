"use client";

import localforage from "localforage";
import { nanoid } from "nanoid";

import { deleteAnonymousStorageFile, uploadAnonymousStorageFile } from "@/services/anonymous-storage";
import { apiGet } from "@/services/api/request";
import { mirrorToLocalFolder, readFromLocalFolder } from "@/services/local-folder";
import { keysReadyToDelete } from "@/services/media-cleanup";
import {
    MEDIA_PROXY_LOGIN_REQUIRED,
    autoSyncToCloud,
    canUseGlobalStorage,
    clearAutoSyncCache,
    fetchViaProxy,
    getProxyUrl,
    isFitMediaUrl,
    loadUserStorageProvider,
    toProviderPayload,
    type StorageConfig,
    type UserWebDAVStorageProvider,
} from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();
let storageConfigPromise: Promise<StorageConfig> | null = null;

export async function uploadMediaFile(input: string | Blob, prefix = "file", syncId?: string, tokenOverride?: string): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const uploaded = await autoSyncToCloud(syncId || blob, async () => {
        const metadataUrl = blob.type.startsWith("video/") ? URL.createObjectURL(blob) : undefined;
        try {
            return await uploadMediaBlobToServer(blob, input instanceof File ? input.name : prefix, metadataUrl, tokenOverride);
        } finally {
            if (metadataUrl) URL.revokeObjectURL(metadataUrl);
        }
    });
    if (uploaded) return uploaded;
    const storageKey = `${prefix}:${nanoid()}`;
    await store.setItem(storageKey, blob);
    mirrorToLocalFolder(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = await uploadedMediaMeta(url, blob.type);
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function uploadAssetMediaFile(file: File, prefix = "asset-media"): Promise<UploadedFile> {
    try {
        return await uploadMediaBlobToServer(file, file.name || `${prefix}-${nanoid()}`);
    } catch (error) {
        if (error instanceof Error && !error.message.includes("服务端对象存储未启用")) throw error;
        return uploadMediaFile(file, prefix);
    }
}

export async function downloadRemoteMedia(url: string) {
    // openai.fit 和它的 OSS 先直连，直连失败时登录用户再走代理（见 fetchViaProxy）
    const response = await fetchViaProxy(url);
    // 代理对没登录（或登录已过期）的请求只放行图片，视频和音频回 401。
    if (response.status === 401 && (getProxyUrl(url) !== url || isFitMediaUrl(url))) throw new Error(MEDIA_PROXY_LOGIN_REQUIRED);
    if (!response.ok) throw new Error(`媒体下载失败：${response.status}`);
    const blob = await response.blob();
    if (blob.type.includes("json") || blob.type.startsWith("text/")) {
        const text = await blob.text().catch(() => "");
        let message = "";
        try {
            const payload = JSON.parse(text) as { msg?: string; message?: string };
            message = payload.msg || payload.message || "";
        } catch {
            message = text;
        }
        throw new Error(message || "媒体下载失败");
    }
    return blob;
}

export async function uploadRemoteMediaToServer(url: string, filename: string): Promise<UploadedFile> {
    const blob = await downloadRemoteMedia(url);
    return uploadMediaBlobToServer(blob, filename);
}

async function uploadMediaBlobToServer(blob: Blob, filename: string, metadataUrl?: string, tokenOverride?: string): Promise<UploadedFile> {
    const config = await loadStorageConfig().catch(() => null);
    if (tokenOverride !== undefined && useUserStore.getState().token !== tokenOverride) {
        throw new Error("登录状态已变化");
    }
    const userProvider = config?.allowUserProvider ? loadUserStorageProvider() : null;
    if (!config || (!canUseGlobalStorage(config) && !userProvider)) throw new Error("服务端对象存储未启用");
    const token = tokenOverride === undefined ? useUserStore.getState().token : tokenOverride;
    if (userProvider?.type === "webdav") {
        const directUpload = await uploadWebDAVMediaDirect(blob, filename, userProvider);
        if (directUpload) return directUpload;
    }
    if (!token) {
        if (!userProvider) throw new Error("请先登录后再同步媒体");
        const uploaded = await uploadAnonymousStorageFile<UploadedFile>(blob, filename, toProviderPayload(userProvider));
        return cacheAnonymousMedia(uploaded, blob);
    }
    const formData = new FormData();
    formData.append("file", blob, filename);
    if (userProvider) formData.append("provider", JSON.stringify(toProviderPayload(userProvider)));
    const response = await fetch("/api/v1/files", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: formData });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string; data?: UploadedFile } | null;
    if (!response.ok || payload?.code !== 0 || !payload.data) throw new Error(payload?.msg || "媒体同步失败");
    const meta = metadataUrl || payload.data.mimeType?.startsWith("video/") ? await readVideoMeta(metadataUrl || payload.data.url) : {};
    return { ...payload.data, bytes: payload.data.bytes || blob.size, mimeType: payload.data.mimeType || blob.type || "application/octet-stream", ...meta };
}

async function uploadWebDAVMediaDirect(blob: Blob, filename: string, provider: UserWebDAVStorageProvider): Promise<UploadedFile | null> {
    const direct = await import("@/services/webdav-direct-storage");
    const uploaded = await direct.persistDirectWebDAV(provider, blob, filename);
    return uploaded ? cacheAnonymousMedia(uploaded, blob) : null;
}

async function cacheAnonymousMedia(uploaded: UploadedFile, blob: Blob) {
    await store.setItem(uploaded.storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(uploaded.storageKey, url);
    const meta = await uploadedMediaMeta(url, blob.type);
    return { ...uploaded, url, bytes: uploaded.bytes || blob.size, mimeType: uploaded.mimeType || blob.type || "application/octet-stream", ...meta };
}

async function loadStorageConfig() {
    storageConfigPromise ||= apiGet<StorageConfig>("/api/storage/config");
    return storageConfigPromise;
}

export function clearStorageConfigCache() {
    storageConfigPromise = null;
}

export async function uploadMediaBlob(blob: Blob, filename: string): Promise<UploadedFile> {
    return uploadMediaBlobToServer(blob, filename);
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey).catch(() => null);
    if (blob) {
        const url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
        return url;
    }
    // 浏览器里没了（清缓存、空间不够被浏览器清掉）：从用户选的本地文件夹找回来，再存回浏览器
    const fromFolder = await readFromLocalFolder(storageKey);
    if (fromFolder) {
        await store.setItem(storageKey, fromFolder).catch(() => undefined);
        const url = URL.createObjectURL(fromFolder);
        objectUrls.set(storageKey, url);
        return url;
    }
    if (storageKey.startsWith("server:webdav:")) {
        const provider = loadUserStorageProvider();
        if (provider?.type !== "webdav") return fallback;
        const direct = await import("@/services/webdav-direct-storage");
        return direct.directWebDAVMediaUrl(provider, direct.directWebDAVObjectKey(storageKey));
    }
    if (storageKey.startsWith("server:")) {
        const id = storageKey.slice("server:".length);
        if (fallback && !fallback.startsWith("blob:") && !fallback.includes("direct=1") && !fallback.startsWith("/webdav-media/")) return fallback;
        const { getStorageObjectInfo } = await import("@/services/api/storage");
        const info = await getStorageObjectInfo(id).catch(() => null);
        if (!info) return fallback;
        const provider = loadUserStorageProvider();
        if (info.direct && provider?.type === "webdav") {
            const direct = await import("@/services/webdav-direct-storage");
            try {
                return await direct.directWebDAVMediaUrl(provider, info.objectKey);
            } catch (error) {
                if (!useUserStore.getState().token || !direct.isWebDAVDirectUnavailable(error)) throw error;
            }
        }
        const url = info.publicUrl || `/api/files/${encodeURIComponent(id)}/content`;
        return url;
    }
    return fallback;
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

/** 浏览器里还存着这个素材（不查本地文件夹、不查服务器）。 */
export async function hasLocalMedia(storageKey: string) {
    return objectUrls.has(storageKey) || Boolean(await store.getItem<Blob>(storageKey).catch(() => null));
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    mirrorToLocalFolder(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

async function deleteServerMedia(storageKey: string) {
    const id = storageKey.slice("server:".length);
    if (!id) return;
    const token = useUserStore.getState().token;
    const provider = loadUserStorageProvider();
    if (storageKey.startsWith("server:webdav:") && provider?.type !== "webdav") return;
    if (provider?.type === "webdav") {
        const direct = await import("@/services/webdav-direct-storage");
        if (await direct.deletePersistedDirectWebDAV(provider, storageKey)) {
            clearAutoSyncCache(storageKey);
            const url = objectUrls.get(storageKey);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(storageKey);
            await store.removeItem(storageKey);
            return;
        }
    }
    if (!token) {
        if (!provider) return;
        await deleteAnonymousStorageFile(id, toProviderPayload(provider));
        clearAutoSyncCache(storageKey);
        const url = objectUrls.get(storageKey);
        if (url) URL.revokeObjectURL(url);
        objectUrls.delete(storageKey);
        await store.removeItem(storageKey);
        return;
    }
    const response = await fetch(`/api/v1/files/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(provider ? { provider: toProviderPayload(provider) } : {}),
    });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string } | null;
    if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || "删除服务端视频失败");
    clearAutoSyncCache(storageKey);
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    const { useAssetStore } = await import("@/stores/use-asset-store");
    const assetKeys = new Set(
        useAssetStore.getState().assets
            .map((a) => (a.kind === "video" || a.kind === "audio" ? a.data.storageKey : null))
            .filter((k): k is string => Boolean(k))
    );
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            if (assetKeys.has(key)) return;
            if (key.startsWith("server:")) {
                await deleteServerMedia(key);
                return;
            }
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
            clearAutoSyncCache(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    const ready = await keysReadyToDelete("media", unused);
    await Promise.all(ready.map((key) => store.removeItem(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

const MEDIA_META_TIMEOUT_MS = 10_000;

/** 用媒体元素读一次元数据：宽高（音频没有）和片长（毫秒）；出错、读不出或 10 秒没读到都不给，浏览器外返回空。 */
async function readMediaMeta(source: Blob | string, kind: "video" | "audio") {
    if (typeof document === "undefined") return {};
    const url = typeof source === "string" ? source : URL.createObjectURL(source);
    const element = document.createElement(kind);
    element.preload = "metadata";
    try {
        return await new Promise<{ width?: number; height?: number; durationMs?: number }>((resolve) => {
            const timer = setTimeout(() => resolve({}), MEDIA_META_TIMEOUT_MS);
            element.onloadedmetadata = () => {
                clearTimeout(timer);
                const durationMs = Number.isFinite(element.duration) && element.duration > 0 ? Math.round(element.duration * 1000) : undefined;
                const video = kind === "video" ? (element as HTMLVideoElement) : null;
                resolve(video ? { width: video.videoWidth, height: video.videoHeight, durationMs } : { durationMs });
            };
            element.onerror = () => {
                clearTimeout(timer);
                resolve({});
            };
            element.src = url;
        });
    } finally {
        element.removeAttribute("src");
        if (typeof source !== "string") URL.revokeObjectURL(url);
    }
}

/** 音视频的真实片长（毫秒）；读不出返回 undefined。 */
export async function readMediaDurationMs(source: Blob | string, kind: "video" | "audio") {
    return (await readMediaMeta(source, kind)).durationMs;
}

async function readVideoMeta(url: string) {
    const { width, height, durationMs } = await readMediaMeta(url, "video");
    return { width: width || 1280, height: height || 720, ...(durationMs ? { durationMs } : {}) };
}

/** 存下的音视频顺手读元数据：视频的宽高和片长，音频的片长（UploadedFile.durationMs 是真实片长）。 */
async function uploadedMediaMeta(url: string, type: string) {
    if (type.startsWith("video/")) return readVideoMeta(url);
    const durationMs = type.startsWith("audio/") ? await readMediaDurationMs(url, "audio") : undefined;
    return durationMs ? { durationMs } : {};
}
