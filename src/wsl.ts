// Windows ↔ WSL path translation, so tools accept the Linux paths models (and WSL projects) use.
// The default distribution comes from the registry rather than wsl.exe, which can take a long
// time when it has to start the WSL virtual machine.

import { spawnSync } from "node:child_process";

let distro: string | null | undefined;

export function defaultDistro(): string | null {
  if (distro !== undefined) return distro;
  distro = null;
  if (process.platform !== "win32") return distro;
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";
  const q = (args: string[]) => spawnSync("reg", ["query", ...args], { encoding: "utf8", windowsHide: true, timeout: 3000 }).stdout ?? "";
  const guid = /DefaultDistribution\s+REG_SZ\s+(\S+)/.exec(q([key, "/v", "DefaultDistribution"]))?.[1];
  if (guid) distro = /DistributionName\s+REG_SZ\s+(.+)/.exec(q([`${key}\\${guid}`, "/v", "DistributionName"]))?.[1]?.trim() ?? null;
  return distro;
}

// /mnt/c/Users/x → C:/Users/x · /home/x → \\wsl.localhost\Ubuntu\home\x · others unchanged.
export function fromWslPath(p: string): string {
  if (process.platform !== "win32") return p;
  const mnt = /^\/mnt\/([a-zA-Z])(\/|$)(.*)$/.exec(p);
  if (mnt) return `${mnt[1].toUpperCase()}:/${mnt[3]}`;
  if (/^\/(home|root|opt|srv)(\/|$)/.test(p)) {
    const d = defaultDistro();
    if (d) return `\\\\wsl.localhost\\${d}${p.replace(/\//g, "\\")}`;
  }
  return p;
}
