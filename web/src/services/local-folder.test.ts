import assert from "node:assert/strict";
import test from "node:test";
import { folderBaseName, folderFileName, readFromDirectory, writeToDirectory } from "./local-folder";

/** 内存里的假文件夹：只实现 getFileHandle / getFile / createWritable。 */
function fakeFolder() {
    const files = new Map<string, Blob>();
    let writes = 0;
    const dir = {
        async getFileHandle(name: string, options?: { create?: boolean }) {
            if (!files.has(name) && !options?.create) throw new DOMException("not found", "NotFoundError");
            return {
                getFile: async () => new File([files.get(name) || new Blob()], name, { type: "" }),
                createWritable: async () => {
                    let pending = new Blob();
                    return { write: async (blob: Blob) => { pending = blob; }, close: async () => { files.set(name, pending); writes++; } };
                },
            };
        },
    } as unknown as FileSystemDirectoryHandle;
    return { dir, files, writes: () => writes };
}

test("文件名：冒号等换成连字符，按类型带扩展名", () => {
    assert.equal(folderBaseName("generated-video:Ab_c1"), "generated-video-Ab_c1");
    assert.equal(folderFileName("generated-video:Ab_c1", "video/mp4"), "generated-video-Ab_c1.mp4");
    assert.equal(folderFileName("image:x", "image/jpeg"), "image-x.jpg");
    assert.equal(folderFileName("file:x", ""), "file-x.bin");
});

test("写进文件夹后能按素材键读回来；同样大小的文件不重写", async () => {
    const folder = fakeFolder();
    const video = new Blob([new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112])], { type: "video/mp4" });
    assert.equal(await writeToDirectory(folder.dir, "generated-video:k1", video), true);
    assert.equal(await writeToDirectory(folder.dir, "generated-video:k1", video), false);
    assert.equal(folder.writes(), 1);
    assert.deepEqual([...folder.files.keys()], ["generated-video-k1.mp4"]);

    const back = await readFromDirectory(folder.dir, "generated-video:k1");
    assert.ok(back);
    assert.equal(back.size, video.size);
    assert.equal(back.type, "video/mp4", "文件没带类型时按扩展名补上");
    assert.equal(await readFromDirectory(folder.dir, "generated-video:missing"), null);
});
