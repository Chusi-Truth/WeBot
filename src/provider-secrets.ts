import crypto from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export class ProviderSecretStore {
  readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "api-keys.json");
  }

  async load(): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!isRecord(parsed)) throw new Error("API Key 文件必须是 JSON 对象。");
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] =>
            isEnvironmentName(entry[0]) &&
            typeof entry[1] === "string" &&
            Boolean(entry[1]),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`无法读取 API Key 存储：${String(error)}`, {
        cause: error,
      });
    }
  }

  async save(values: Record<string, string>): Promise<void> {
    await mkdir(path.dirname(this.filePath), {
      recursive: true,
      mode: 0o700,
    });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(values, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}

export function isEnvironmentName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]{0,127}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
