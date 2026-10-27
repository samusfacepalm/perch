// The only bridge between the window and Node. The page gets these functions and nothing else.

import { contextBridge, ipcRenderer, webUtils } from "electron";

const api = {
  init: () => ipcRenderer.invoke("init"),
  listModels: () => ipcRenderer.invoke("models:list"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSetting: (name: string, value: unknown) => ipcRenderer.invoke("settings:set", name, value),
  listKeys: () => ipcRenderer.invoke("keys:list"),
  saveKey: (opts: { id: string; key: string; baseURL?: string; name?: string }) => ipcRenderer.invoke("keys:save", opts),
  removeKey: (id: string) => ipcRenderer.invoke("keys:remove", id),
  allUsage: () => ipcRenderer.invoke("usage:all"),
  listProjects: () => ipcRenderer.invoke("projects:list"),
  localList: () => ipcRenderer.invoke("local:list"),
  setupFor: (cwd: string) => ipcRenderer.invoke("setup:for", cwd),
  localScan: () => ipcRenderer.invoke("local:scan"),
  localStart: (p: string) => ipcRenderer.invoke("local:start", p),
  localStop: (p: string) => ipcRenderer.invoke("local:stop", p),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  newSession: (cwd: string | null, model?: string) => ipcRenderer.invoke("session:new", { cwd, model }),
  openSession: (id: string) => ipcRenderer.invoke("session:open", id),
  deleteSession: (id: string) => ipcRenderer.invoke("session:delete", id),
  setModel: (id: string, model: string) => ipcRenderer.invoke("session:setModel", id, model),
  setCwd: (id: string, cwd: string) => ipcRenderer.invoke("session:setCwd", id, cwd),
  setAuto: (id: string, on: boolean) => ipcRenderer.invoke("session:setAuto", id, on),
  setMode: (id: string, mode: "ask" | "edits" | "all") => ipcRenderer.invoke("session:setMode", id, mode),
  setThinking: (id: string, level: "off" | "low" | "high" | "max") => ipcRenderer.invoke("session:setThinking", id, level),
  pickFolder: () => ipcRenderer.invoke("folder:pick"),
  openFolder: (dir: string) => ipcRenderer.invoke("folder:open", dir),
  setPhone: (on: boolean) => ipcRenderer.invoke("window:phone", on),
  send: (id: string, text: string, images?: string[]) => ipcRenderer.invoke("agent:send", id, text, images),
  listShots: (id: string) => ipcRenderer.invoke("shots:list", id),
  playDetect: (id: string) => ipcRenderer.invoke("play:detect", id),
  playRun: (id: string, opts?: { seconds?: number; shots?: number[]; keys?: { at: number; key: string }[] }) => ipcRenderer.invoke("play:run", id, opts ?? {}),
  saveGolden: (id: string, shots: string[]) => ipcRenderer.invoke("golden:save", id, shots),
  imageInfo: (file: string, frame?: { w: number; h: number }) => ipcRenderer.invoke("image:info", file, frame),
  imageDiff: (a: string, b: string) => ipcRenderer.invoke("image:diff", a, b),
  listAssets: (id: string) => ipcRenderer.invoke("assets:list", id),
  saveAttachment: (bytes: Uint8Array, mime: string) => ipcRenderer.invoke("attach:save", bytes, mime),
  reveal: (p: string) => ipcRenderer.invoke("file:reveal", p),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  abort: (id: string) => ipcRenderer.invoke("agent:abort", id),
  compact: (id: string) => ipcRenderer.invoke("agent:compact", id),
  answer: (reqId: number, decision: { allow: boolean; always?: boolean; feedback?: string }) =>
    ipcRenderer.invoke("permission:answer", reqId, decision),
  onEvent: (fn: (e: any) => void) => {
    const listener = (_: unknown, e: any) => fn(e);
    ipcRenderer.on("event", listener);
    return () => {
      ipcRenderer.removeListener("event", listener);
    };
  },
};

contextBridge.exposeInMainWorld("perch", api);
export type PerchApi = typeof api;
