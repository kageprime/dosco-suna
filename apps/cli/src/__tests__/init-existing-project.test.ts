import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  readlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cli = resolve(import.meta.dir, "..", "index.ts");

describe("init in an existing cloned project", () => {
  test("--force wires the current Kortix repo in place without creating a child project", () => {
    const repo = mkdtempSync(resolve(tmpdir(), "kortix-init-existing-"));
    mkdirSync(resolve(repo, ".kortix", "opencode"), { recursive: true });
    mkdirSync(resolve(repo, "skills", "kortix-cli"), { recursive: true });
    writeFileSync(resolve(repo, "skills", "kortix-cli", "SKILL.md"), "# cli\n");
    writeFileSync(resolve(repo, "kortix.yaml"), "project:\n  name: Existing\n");
    writeFileSync(resolve(repo, "README.md"), "keep me\n");
    spawnSync("git", ["init", "-b", "main"], { cwd: repo });
    spawnSync("git", ["add", "."], { cwd: repo });
    spawnSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "seed",
      ],
      { cwd: repo },
    );

    const result = spawnSync(process.execPath, [cli, "init", "--force"], {
      cwd: repo,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `Configured this Kortix workspace in ${realpathSync(repo)}`,
    );
    // A .kortix/opencode folder is not read: every link points at the root folders.
    expect(readlinkSync(resolve(repo, ".agents", "skills"))).toBe("../skills");
    expect(() => lstatSync(resolve(repo, ".opencode"))).toThrow();
    expect(lstatSync(resolve(repo, ".claude")).isDirectory()).toBe(true);
    expect(
      lstatSync(resolve(repo, ".claude", "skills")).isSymbolicLink(),
    ).toBe(true);
    expect(readFileSync(resolve(repo, "AGENTS.md"), "utf8")).toContain(
      "This repository is a",
    );
    expect(readFileSync(resolve(repo, "README.md"), "utf8")).toBe("keep me\n");
    expect(() => lstatSync(resolve(repo, "kortix-project"))).toThrow();
    expect(
      spawnSync("git", ["status", "--porcelain"], {
        cwd: repo,
        encoding: "utf8",
      }).stdout,
    ).toBe("");
  });

  test("--force keeps the repository's own AGENTS.md and links each skill kortix.yaml registers under .kortix/", () => {
    const repo = mkdtempSync(resolve(tmpdir(), "kortix-init-existing-"));
    mkdirSync(resolve(repo, ".kortix", "loops", "skills", "weekly"), { recursive: true });
    writeFileSync(resolve(repo, ".kortix", "loops", "skills", "weekly", "SKILL.md"), "# weekly\n");
    writeFileSync(resolve(repo, "kortix.yaml"), "project:\n  name: Existing\nskills:\n  weekly: .kortix/loops/skills/weekly\n");
    writeFileSync(resolve(repo, "AGENTS.md"), "# House rules\n\nNever push to main.\n");
    spawnSync("git", ["init", "-b", "main"], { cwd: repo });

    const run = () => spawnSync(process.execPath, [cli, "init", "--force"], { cwd: repo, encoding: "utf8" });
    const first = run();
    expect(first.status).toBe(0);
    const agentsMd = readFileSync(resolve(repo, "AGENTS.md"), "utf8");
    expect(agentsMd.startsWith("# House rules\n\nNever push to main.\n")).toBe(true);
    expect(agentsMd).toContain("kortix skills get kortix-cli");
    expect(first.stdout).toContain("AGENTS.md (Kortix section added, the rest kept)");
    // No root skills/ folder: one link per registered skill, and no dangling folder link.
    expect(readlinkSync(resolve(repo, ".claude", "skills", "weekly"))).toBe("../../.kortix/loops/skills/weekly");
    expect(readFileSync(resolve(repo, ".agents", "skills", "weekly", "SKILL.md"), "utf8")).toBe("# weekly\n");
    expect(() => lstatSync(resolve(repo, ".claude", "agents"))).toThrow();

    // A second run adds no second section.
    expect(run().status).toBe(0);
    expect(readFileSync(resolve(repo, "AGENTS.md"), "utf8")).toBe(agentsMd);
  });
});
