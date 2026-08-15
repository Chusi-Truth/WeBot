import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const scripts = [
  "deploy/setup.sh",
  "deploy/setup-common.sh",
  "deploy/setup-local.sh",
  "deploy/setup-server.sh",
  "deploy/setup-codex-adapter.sh",
];
const windowsScripts = [
  "deploy/setup-windows.ps1",
  "deploy/start-webot-windows.ps1",
];

describe("deployment scripts", () => {
  it.each(scripts)("has valid Bash syntax: %s", (relativePath) => {
    expect(() =>
      execFileSync("bash", ["-n", path.join(root, relativePath)], {
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it.each([
    "deploy/setup.sh",
    "deploy/setup-local.sh",
    "deploy/setup-server.sh",
    "deploy/setup-codex-adapter.sh",
  ])("supports a read-only help mode: %s", (relativePath) => {
    const output = execFileSync(
      "bash",
      [path.join(root, relativePath), "--help"],
      { encoding: "utf8" },
    );
    expect(output.length).toBeGreaterThan(20);
  });

  it("keeps both service endpoints on loopback", () => {
    const source = scripts
      .map((relativePath) => readFileSync(path.join(root, relativePath), "utf8"))
      .join("\n");
    expect(source).toContain('host: "127.0.0.1"');
    expect(source).toContain("http://127.0.0.1:");
    expect(source).not.toContain('host: "0.0.0.0"');
  });

  it("updates dotenv values without printing or corrupting secrets", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "webot-deploy-"));
    const envFile = path.join(directory, ".env");
    const common = path.join(root, "deploy/setup-common.sh");
    const output = execFileSync(
      "bash",
      [
        "-c",
        '. "$1"; upsert_env "$2" SAMPLE_KEY \'value with # and "quotes"\'; upsert_env "$2" SAMPLE_KEY replacement',
        "bash",
        common,
        envFile,
      ],
      { encoding: "utf8" },
    );
    expect(output).toBe("");
    expect(readFileSync(envFile, "utf8")).toBe('SAMPLE_KEY="replacement"\n');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it("does not contain a real API key or management secret", () => {
    const source = scripts
      .map((relativePath) => readFileSync(path.join(root, relativePath), "utf8"))
      .join("\n");
    expect(source).not.toMatch(/sk-[a-zA-Z0-9_-]{16,}/u);
    expect(source).not.toMatch(/api-keys:\s*\n\s*-\s*"[a-f0-9]{32,}"/u);
    expect(source).not.toMatch(/secret-key:\s*"[a-f0-9]{32,}"/u);
  });

  it("ships the user-facing installers as executable files", () => {
    for (const relativePath of scripts.filter(
      (relativePath) => relativePath !== "deploy/setup-common.sh",
    )) {
      expect(statSync(path.join(root, relativePath)).mode & 0o111).not.toBe(0);
    }
  });

  it("provides a guarded Windows installer and background launcher", () => {
    const setup = readFileSync(
      path.join(root, "deploy/setup-windows.ps1"),
      "utf8",
    );
    const starter = readFileSync(
      path.join(root, "deploy/start-webot-windows.ps1"),
      "utf8",
    );
    expect(setup).toContain("Read-Host $Prompt -AsSecureString");
    expect(setup).toContain('[int]$Matches["major"] -lt 22');
    expect(setup).toContain("Register-ScheduledTask");
    expect(setup).toContain("-LogonType Interactive");
    expect(setup).toContain("http://127.0.0.1:$AdminPort/admin");
    expect(starter).toContain('Join-Path $env:LOCALAPPDATA "WeBot"');
    expect(starter).toContain('"dist\\cli.js"');
  });

  it("keeps Windows scripts free of embedded credentials and public binds", () => {
    const source = windowsScripts
      .map((relativePath) => readFileSync(path.join(root, relativePath), "utf8"))
      .join("\n");
    expect(source).not.toMatch(/sk-[a-zA-Z0-9_-]{16,}/u);
    expect(source).not.toContain("0.0.0.0");
    expect(source).not.toMatch(/[a-f0-9]{64}/u);
  });
});
