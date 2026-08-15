import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Credential } from "./types.js";

export interface StateStoreOptions {
  stateDir?: string;
}

export class StateStore {
  readonly stateDir: string;
  readonly credentialPath: string;
  readonly cursorPath: string;

  constructor(options: StateStoreOptions = {}) {
    this.stateDir =
      options.stateDir ??
      process.env.WEBOT_STATE_DIR?.trim() ??
      path.join(os.homedir(), ".webot");
    this.credentialPath = path.join(this.stateDir, "credential.json");
    this.cursorPath = path.join(this.stateDir, "cursor.json");
  }

  async loadCredential(): Promise<Credential | null> {
    return this.readJson<Credential>(this.credentialPath);
  }

  async saveCredential(credential: Credential): Promise<void> {
    await this.writePrivateJson(this.credentialPath, credential);
  }

  async clearCredential(): Promise<void> {
    await rm(this.credentialPath, { force: true });
    await rm(this.cursorPath, { force: true });
  }

  async loadCursor(): Promise<string> {
    const data = await this.readJson<{ get_updates_buf?: string }>(
      this.cursorPath,
    );
    return data?.get_updates_buf ?? "";
  }

  async saveCursor(cursor: string): Promise<void> {
    await this.writePrivateJson(this.cursorPath, {
      get_updates_buf: cursor,
    });
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as T;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw new Error(`无法读取状态文件 ${filePath}: ${String(error)}`, {
        cause: error,
      });
    }
  }

  private async writePrivateJson(
    filePath: string,
    value: unknown,
  ): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  }
}
