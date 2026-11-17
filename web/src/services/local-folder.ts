"use client";

import localforage from "localforage";

/**
 * 「本地素材文件夹」：用户选一个电脑上的文件夹，画布存进浏览器的每个素材（生成的视频、上传的图片 / 视频 / 音频）同时写一份到这里，
 * 浏览器里那份丢了（清缓存、浏览器空间不够被清、换了浏览器配置）时从这里读回来。浏览器存储照旧是主存储，这里只是镜像；
 * 画布从不删除这个文件夹里的文件（那是用户自己电脑上的东西），清理只清浏览器里的缓存。
 * 只有 Chrome / Edge 这类支持 File System Access 的浏览器能用；不支持时这里的函数什么都不做。
 */

type PermissionMode = { mode: "readwrite" };
/** TS 的 DOM 类型里还没有文件夹授权这两个方法。 */
type FolderHandle = FileSystemDirectoryHandle & {
    queryPermission?: (options: PermissionMode) => Promise<PermissionState>;
    requestPermission?: (options: PermissionMode) => Promise<PermissionState>;
};
export type LocalFolderState = { supported: boolean; name: string; permission: PermissionState | "none" };

const handleStore = localforage.createInstance({ name: "infinite-canvas", storeName: "local_folder" });
const HANDLE_KEY = "media-folder";
const READWRITE: PermissionMode = { mode: "readwrite" };
const EXTENSIONS: Record<string, string> = {
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
    "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/webm": "weba",
};
const ALL_EXTENSIONS = Array.from(new Set([...Object.values(EXTENSIONS), "bin"]));
const MIME_BY_EXTENSION: Record<string, string> = Object.fromEntries(Object.entries(EXTENSIONS).map(([mime, ext]) => [ext, mime]));

/** 素材键（如 generated-video:AbC12）→ 文件名主体；冒号等文件名里不能用的字符换成连字符。 */
export function folderBaseName(storageKey: string) {
    return storageKey.replace(/[^A-Za-z0-9_-]/g, "-");
}

export function folderFileName(storageKey: string, mimeType: string) {
    return `${folderBaseName(storageKey)}.${EXTENSIONS[mimeType.split(";")[0].trim().toLowerCase()] || "bin"}`;
}

export function localFolderSupported() {
    return typeof window !== "undefined" && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

async function storedHandle() {
    if (!localFolderSupported()) return null;
    return (await handleStore.getItem<FolderHandle>(HANDLE_KEY).catch(() => null)) || null;
}

/** 已选过文件夹且这次打开页面后已授权时返回它；没选、没授权（要用户点一下才能授权）都返回 null。 */
async function grantedHandle() {
    const handle = await storedHandle();
    if (!handle) return null;
    return (await handle.queryPermission?.(READWRITE).catch(() => "denied")) === "granted" ? handle : null;
}

export async function localFolderState(): Promise<LocalFolderState> {
    const supported = localFolderSupported();
    const handle = supported ? await storedHandle() : null;
    if (!handle) return { supported, name: "", permission: "none" };
    return { supported, name: handle.name, permission: (await handle.queryPermission?.(READWRITE).catch(() => "denied" as const)) || "prompt" };
}

/** 弹出选择文件夹（要在用户点击里调用）。用户取消时返回 null。 */
export async function chooseLocalFolder() {
    const picker = (window as unknown as { showDirectoryPicker: (options: { id: string; mode: string }) => Promise<FolderHandle> }).showDirectoryPicker;
    try {
        const handle = await picker({ id: "infinite-canvas-media", mode: "readwrite" });
        await handleStore.setItem(HANDLE_KEY, handle);
        return handle.name;
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return null;
        throw error;
    }
}

/** 重新打开浏览器后文件夹授权会变成「需要询问」，要用户点一下才能恢复（要在用户点击里调用）。 */
export async function reauthorizeLocalFolder() {
    const handle = await storedHandle();
    if (!handle) return false;
    return (await handle.requestPermission?.(READWRITE)) === "granted";
}

export async function forgetLocalFolder() {
    await handleStore.removeItem(HANDLE_KEY);
}

export async function writeToDirectory(dir: FileSystemDirectoryHandle, storageKey: string, blob: Blob) {
    const name = folderFileName(storageKey, blob.type);
    const existing = await dir.getFileHandle(name).catch(() => null);
    if (existing && (await existing.getFile()).size === blob.size) return false;
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
}

export async function readFromDirectory(dir: FileSystemDirectoryHandle, storageKey: string): Promise<Blob | null> {
    const base = folderBaseName(storageKey);
    for (const ext of ALL_EXTENSIONS) {
        const handle = await dir.getFileHandle(`${base}.${ext}`).catch(() => null);
        if (!handle) continue;
        const file = await handle.getFile();
        if (!file.size) continue;
        return file.type ? file : new Blob([file], { type: MIME_BY_EXTENSION[ext] || "application/octet-stream" });
    }
    return null;
}

/** 存进浏览器的同时写一份到本地文件夹；没选文件夹、没授权或写失败都不影响画布（不抛错）。 */
export function mirrorToLocalFolder(storageKey: string, blob: Blob) {
    if (storageKey.startsWith("server:") || !blob.size) return;
    void grantedHandle()
        .then((dir) => (dir ? writeToDirectory(dir, storageKey, blob) : false))
        .catch(() => undefined);
}

/** 浏览器里没有这个素材时，从本地文件夹找回来；找不到返回 null。 */
export async function readFromLocalFolder(storageKey: string) {
    if (storageKey.startsWith("server:")) return null;
    const dir = await grantedHandle().catch(() => null);
    return dir ? readFromDirectory(dir, storageKey).catch(() => null) : null;
}

/** 把浏览器里已有的素材（视频、音频、图片）补存一份到文件夹；已有同样大小的文件就跳过。返回写入的个数。 */
export async function backfillLocalFolder(onProgress?: (done: number, total: number) => void) {
    const dir = await grantedHandle();
    if (!dir) return 0;
    const stores = ["media_files", "image_files"].map((storeName) => localforage.createInstance({ name: "infinite-canvas", storeName }));
    const keys = (await Promise.all(stores.map((store) => store.keys()))).flatMap((list, index) => list.filter((key) => !key.startsWith("server:")).map((key) => [index, key] as const));
    let done = 0;
    let written = 0;
    for (const [index, key] of keys) {
        const blob = await stores[index].getItem<Blob>(key).catch(() => null);
        if (blob instanceof Blob && blob.size && (await writeToDirectory(dir, key, blob).catch(() => false))) written++;
        onProgress?.(++done, keys.length);
    }
    return written;
}
