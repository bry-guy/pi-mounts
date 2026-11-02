import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const v = await import("../src/vm.ts");

test("hidden names", () => {
	for (const p of ["/project.json", "/repos/a/.env", "/repos/a/.env.local", "/x/.pi/roles/r.json", "/.envrc", "/a/fnox.local.toml"]) assert.ok(v.isHidden(p), p);
	for (const p of ["/repos/a/project.json", "/repos/a/env.ts", "/memory.md", "/a/.github/x"]) assert.ok(!v.isHidden(p), p);
});

const cfg = v.loadConfig();
const hasImage = existsSync(join(cfg.image || join(v.CACHE, "pi-worker"), "manifest.json"));

test("VM: repos read-only, .git and worktrees writable, hidden files gone, unlisted egress blocked", { skip: !hasImage && "no image" }, async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pimounts-")));
	const repo = join(root, "repos", "app");
	mkdirSync(repo, { recursive: true });
	writeFileSync(join(root, "project.json"), "{}");
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	writeFileSync(join(repo, ".env"), "S=1");
	const vm = await v.createVm(cfg, { projectPath: root, egress: [], secrets: {} });
	try {
		const run = async (c: string) => (await vm.exec(["/bin/bash", "-c", c], { cwd: root })).exitCode;
		assert.notEqual(await run(`echo x > ${repo}/f`), 0);
		assert.equal(await run(`git -C ${repo} -c user.email=a@a -c user.name=a commit -q --allow-empty -m x`), 0);
		assert.equal(await run(`echo x > ${root}/worktrees/f`), 0);
		assert.notEqual(await run(`cat ${repo}/.env`), 0);
		assert.notEqual(await run(`cat ${root}/project.json`), 0);
		assert.equal((await vm.exec(["/bin/sh", "-c", "curl -s -o /dev/null -w '%{http_code}' https://example.com"])).stdout, "403");
	} finally {
		await vm.close();
	}
});
