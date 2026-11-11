import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const v = await import("../src/vm.ts");

test("guest git: host user authors, role commits; role is both without a host identity", () => {
	const cfg = (env: Record<string, string>) =>
		Object.fromEntries(Array.from({ length: +env.GIT_CONFIG_COUNT }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
	const bot = { name: "bot[bot]", email: "1+bot[bot]@users.noreply.github.com" };
	const base = { projectPath: "/p", egress: [], secrets: {}, git: bot };
	const c = cfg(v.guestEnv({ ...base, author: { name: "Human", email: "h@x" } }, {}));
	assert.deepEqual(
		[c["author.name"], c["author.email"], c["committer.name"], c["committer.email"], c["user.name"], c["user.email"]],
		["Human", "h@x", bot.name, bot.email, bot.name, bot.email],
	);
	const f = cfg(v.guestEnv(base, {}));
	assert.deepEqual([f["author.name"], f["author.email"], f["committer.name"]], [bot.name, bot.email, bot.name]);
});

test("hidden names", () => {
	for (const p of ["/project.json", "/repos/a/.env", "/repos/a/.env.local", "/x/.pi/roles/r.json", "/.envrc", "/a/fnox.local.toml"]) assert.ok(v.isHidden(p), p);
	for (const p of ["/repos/a/project.json", "/repos/a/env.ts", "/memory.md", "/a/.github/x"]) assert.ok(!v.isHidden(p), p);
});

const cfg = v.loadConfig();
const hasImage = existsSync(join(cfg.image || join(v.CACHE, "pi-local-sandbox"), "manifest.json"));

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
		assert.equal((await vm.exec(["/bin/sh", "-c", "curl -s -o /dev/null -w '%{http_code}' https://github.com/"])).stdout, "200", "no network at boot: the image needs ip and udhcpc");
	} finally {
		await vm.close();
	}
});

test("tracked files with hidden names stay visible; untracked ones are hidden", async () => {
	const v = await import("../src/vm.ts");
	const d = mkdtempSync(join(tmpdir(), "pm-"));
	execFileSync("git", ["init", "-q", d]);
	mkdirSync(join(d, ".pi", "roles"), { recursive: true });
	writeFileSync(join(d, ".pi", "roles", "r.json"), "{}");
	writeFileSync(join(d, ".envrc"), "x");
	writeFileSync(join(d, ".env"), "SECRET=1");
	writeFileSync(join(d, ".pi", "secret-broker.json"), "{}");
	execFileSync("git", ["-C", d, "add", ".pi/roles/r.json", ".envrc"]);
	assert.ok(v.isTracked(join(d, ".pi")));
	assert.ok(v.isTracked(join(d, ".pi", "roles", "r.json")));
	assert.ok(v.isTracked(join(d, ".envrc")));
	assert.ok(!v.isTracked(join(d, ".env")));
	assert.ok(!v.isTracked(join(d, ".pi", "secret-broker.json")));
	assert.ok(!v.isTracked(join(tmpdir(), "project.json")));
});
