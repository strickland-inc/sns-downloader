// 保存先フォルダの扱い（File System Access API）。
// Chrome と Edge では、選んだフォルダのハンドルを IndexedDB に残し、次からもそこへ書く。
// Safari と Firefox はこの API が無いので、ブラウザの通常のダウンロードに渡す。

// TypeScript 5.9 の DOM 型には、フォルダ選択と権限の API がまだ無い
type PermissionMode = { mode: "readwrite" };
interface DirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission(options: PermissionMode): Promise<PermissionState>;
  requestPermission(options: PermissionMode): Promise<PermissionState>;
}
interface PickerWindow {
  showDirectoryPicker(options: { id?: string; mode?: "readwrite"; startIn?: string }): Promise<DirectoryHandle>;
}

const DB_NAME = "sns-downloader";
const STORE = "handles";
const KEY = "save-folder";

export function canPickFolder(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window && window.isSecureContext;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB を開けません"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB の読み書きに失敗しました"));
    });
  } finally {
    db.close();
  }
}

export async function loadFolder(): Promise<DirectoryHandle | null> {
  if (!canPickFolder()) return null;
  try {
    const handle: unknown = await withStore("readonly", (s) => s.get(KEY));
    return handle instanceof FileSystemDirectoryHandle ? (handle as DirectoryHandle) : null;
  } catch {
    return null;
  }
}

export type PickResult = { ok: true; handle: DirectoryHandle } | { ok: false; message?: string };

// 利用者の操作（クリック）の中で呼ぶ。キャンセルなら message なし
export async function pickFolder(): Promise<PickResult> {
  try {
    const picker = window as unknown as PickerWindow;
    const handle = await picker.showDirectoryPicker({ id: "sns-downloader", mode: "readwrite", startIn: "downloads" });
    await withStore("readwrite", (s) => s.put(handle, KEY)).catch(() => undefined);
    return { ok: true, handle };
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") return { ok: false };
    // Chrome はホームやシステムのフォルダそのものを選ばせない
    return { ok: false, message: "このフォルダは選べません。中に新しいフォルダを作って、それを選んでください" };
  }
}

// interactive は利用者の操作の中でだけ true にする（許可のダイアログが出せる）
export async function hasPermission(handle: DirectoryHandle, interactive: boolean): Promise<boolean> {
  const opts: PermissionMode = { mode: "readwrite" };
  try {
    if ((await handle.queryPermission(opts)) === "granted") return true;
    return interactive && (await handle.requestPermission(opts)) === "granted";
  } catch {
    return false;
  }
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

// 同じ名前があれば「名前 (2).mp4」のようにずらす
async function freeName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  if (!(await exists(dir, name))) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await exists(dir, candidate))) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

// サーバーの MP4 を選んだフォルダへ流し込む。onProgress には書いたバイト数を渡す
export async function writeToFolder(
  dir: FileSystemDirectoryHandle,
  response: Response,
  name: string,
  onProgress: (written: number) => void,
): Promise<{ name: string; written: number }> {
  if (!response.body) throw new Error("サーバーから中身が届きませんでした");
  const finalName = await freeName(dir, name);
  const fileHandle = await dir.getFileHandle(finalName, { create: true });
  const writable = await fileHandle.createWritable();
  let written = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      written += chunk.byteLength;
      onProgress(written);
      controller.enqueue(chunk);
    },
  });
  try {
    await response.body.pipeThrough(counter).pipeTo(writable);
  } catch (e: unknown) {
    // 途中で切れた空のファイルを残さない
    await dir.removeEntry(finalName).catch(() => undefined);
    throw e instanceof Error ? e : new Error("保存先へ書き込めませんでした");
  }
  return { name: finalName, written };
}

// 書き込みに失敗したとき、利用者に見せる言葉に直す
export function describeWriteError(e: unknown): { message: string; permissionLost: boolean } {
  if (e instanceof DOMException) {
    if (e.name === "NotAllowedError" || e.name === "SecurityError") {
      return { message: "保存先に書き込む許可がありません。「許可する」を押してください", permissionLost: true };
    }
    if (e.name === "NotFoundError") {
      return { message: "保存先のフォルダが見つかりません。フォルダを選び直してください", permissionLost: true };
    }
    if (e.name === "QuotaExceededError") {
      return { message: "保存先の空き容量が足りません", permissionLost: false };
    }
  }
  return { message: e instanceof Error ? e.message : "保存先へ書き込めませんでした", permissionLost: false };
}

// API が無いブラウザでは、通常のダウンロードとして渡す
export function handToBrowser(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export type { DirectoryHandle };
