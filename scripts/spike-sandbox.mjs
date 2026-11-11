#!/usr/bin/env node
// M1 spike: prints PASS/FAIL per check for the Mac sandbox design. Run on the laptop.
// Env: GONDOLIN (path to gondolin host dist index.js), IMAGE (pi-local-sandbox assets dir),
//      PUSH_REPO (owner/repo to push a throwaway branch to, optional), GH_TOKEN (optional, else `gh auth token`).
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

const G = await import(process.env.GONDOLIN || `${homedir()}/dev/gondolin/host/dist/src/index.js`);
const IMAGE = process.env.IMAGE || `${homedir()}/.cache/pi-mounts/pi-local-sandbox`;
const results = [];
const check = (id, ok, note = "") => { results.push([id, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${id}${note ? `  ${note}` : ""}`); };
const sh = (cmd, cwd) => { try { return execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return `ERR ${e.stderr || e.message}`; } };

// Scratch project: <root>/{project.json,.pi,repos/r/{.git,.env,.pi},worktrees,artifacts}
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pispike-")));
const repo = path.join(root, "repos/r");
mkdirSync(repo, { recursive: true }); mkdirSync(path.join(root, "worktrees/r"), { recursive: true });
mkdirSync(path.join(root, "artifacts")); mkdirSync(path.join(root, ".pi"));
writeFileSync(path.join(root, "project.json"), "{}"); writeFileSync(path.join(root, ".pi/x"), "x");
sh("git init -q -b main && git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init", repo);
writeFileSync(path.join(repo, "a.txt"), "a\n"); writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
mkdirSync(path.join(repo, ".pi")); writeFileSync(path.join(repo, ".pi/role.yaml"), "x");
symlinkSync(path.join(homedir(), ".ssh"), path.join(repo, "escape"));

const HIDDEN = new Set([".pi", ".envrc", "fnox.local.toml"]);
const hidden = ({ path: p }) => p.split("/").some(n => HIDDEN.has(n) || n.startsWith(".env")) || p === "/project.json";
const shadow = (prov) => new G.ShadowProvider(prov, { shouldShadow: hidden, writeMode: "deny" });
const mounts = {
  [root]: shadow(new G.ReadonlyProvider(new G.RealFSProvider(root))),
  [repo]: shadow(new G.ReadonlyProvider(new G.RealFSProvider(repo))),
  [path.join(repo, ".git")]: new G.RealFSProvider(path.join(repo, ".git")),
  [path.join(root, "worktrees")]: shadow(new G.RealFSProvider(path.join(root, "worktrees"))),
  [path.join(root, "artifacts")]: new G.RealFSProvider(path.join(root, "artifacts")),
};
const token = process.env.GH_TOKEN || (() => { try { return sh("gh auth token").trim(); } catch { return ""; } })();
const { httpHooks, env } = G.createHttpHooks({
  allowedHosts: ["registry.npmjs.org", "github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com",
    "release-assets.githubusercontent.com", "nodejs.org", "unofficial-builds.nodejs.org", "mise.jdx.dev", "mise-versions.jdx.dev",
    "platform-control-0.tail9e13b.ts.net"],
  secrets: { GH_TOKEN: { hosts: ["github.com", "api.github.com"], value: token || "none" } },
});

let t0 = Date.now();
const vm = await G.VM.create({ sandbox: { imagePath: IMAGE }, memory: "2G", cpus: 2, vfs: { mounts }, httpHooks,
  env: { ...env, HOME: "/root", PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" } });
const run = async (cmd, cwd = root) => { const r = await vm.exec(["/bin/bash", "-c", cmd], { cwd }); return { code: r.exitCode, out: (r.stdout || "") + (r.stderr || "") }; };
try {
  let r = await run("true");
  const boot = Date.now() - t0;
  check("(h) VM boot", r.code === 0, `${boot} ms`);
  r = await run("node --version; git --version; mise --version; rg --version | head -1; fd --version");
  check("(h) tools present", r.code === 0, r.out.replace(/\n/g, " | "));
  r = await run("while read -r _ dest _; do [ \"$dest\" = 00000000 ] && exit 0; done < /proc/net/route; exit 1");
  check("(h) guest has a default route at boot", r.code === 0);
  r = await run("getent hosts github.com");
  check("(h) guest resolves an allowed host at boot", r.code === 0, r.out.trim());

  r = await run(`echo b >> ${repo}/a.txt`);
  check("(a) repos/ read-only", r.code !== 0, r.out.trim());
  r = await run(`cat ${repo}/a.txt`);
  check("(a) repos/ readable", r.code === 0 && r.out.includes("a"));

  r = await run(`git -C ${repo} -c user.email=s@s -c user.name=s worktree add -q -b feat ${root}/worktrees/r/feat && cd ${root}/worktrees/r/feat && echo c > c.txt && git add c.txt && git -c user.email=s@s -c user.name=s commit -qm c && git log --oneline -1`);
  check("(b) worktree add + commit", r.code === 0, r.out.trim());
  check("(b) host sees commit", sh("git log --oneline -1 feat", repo).includes(" c"));

  for (const p of [`${root}/project.json`, `${root}/.pi/x`, `${repo}/.env`, `${repo}/.pi/role.yaml`]) {
    r = await run(`cat ${p}`); check(`(c) hidden ${path.relative(root, p)}`, r.code !== 0);
  }
  r = await run(`ls -a ${repo}`); check("(c) hidden from listing", !/\.env|\.pi\b/.test(r.out), r.out.replace(/\n/g, " "));
  r = await run(`echo X=1 > ${root}/worktrees/r/feat/.env`); check("(c) can't create .env in a worktree", r.code !== 0);

  r = await run(`git -C ${root}/worktrees/r/feat config core.hooksPath /tmp/x && git -C ${root}/worktrees/r/feat config --unset core.hooksPath`);
  check("(d) .git config writable (expected, accepted)", r.code === 0);

  r = await run(`ls ${repo}/escape/ 2>&1; cat ${repo}/escape/config 2>&1`);
  check("(e) symlink escape fails", !/Host |IdentityFile/.test(r.out) && r.code !== 0, r.out.trim().split("\n")[0]);

  r = await run("curl -sS -o /dev/null -w '%{http_code}' https://example.com; echo; curl -sS https://example.com | head -c 120");
  check("(f) unlisted host blocked", r.out.startsWith("403"), r.out.replace(/\n/g, " ").slice(0, 140));
  r = await run("curl -sS -o /dev/null -w '%{http_code}' https://registry.npmjs.org/");
  check("(f) listed host allowed", r.out.trim() === "200", r.out.trim());
  r = await run("git ls-remote https://github.com/bry-guy/pi-mounts.git HEAD 2>&1");
  check("(f) git trusts the proxy CA", r.code === 0, r.out.trim().slice(0, 80));
  r = await run("curl -sS -o /dev/null -o /dev/null -w '%{http_code} ' https://github.com https://github.com 2>&1");
  check("(f) TLS session resumption (2nd connection)", r.out.trim() === "200 200", r.out.trim());

  r = await run('echo "$GH_TOKEN"');
  check("(g) guest sees placeholder only", !!token && !r.out.includes(token), r.out.trim());
  r = await run('curl -sS -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user | jq -r .login');
  check("(g) placeholder works for api.github.com", /\w/.test(r.out) && !/null/.test(r.out), r.out.trim());
  if (process.env.PUSH_REPO) {
    const br = `spike-${Date.now()}`;
    r = await run(`git -c http.extraHeader= -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' push -q https://github.com/${process.env.PUSH_REPO}.git feat:${br} 2>&1`, `${root}/worktrees/r/feat`);
    check("(g) HTTPS push with injected token (Basic)", r.code === 0, r.out.trim());
    if (r.code === 0) sh(`gh api -X DELETE repos/${process.env.PUSH_REPO}/git/refs/heads/${br}`);
  } else console.log("SKIP  (g) push: set PUSH_REPO");

  t0 = Date.now();
  r = await run(`cd ${root}/worktrees/r/feat && printf '[tools]\\nnode = "22"\\n' > mise.toml && mise trust -q && mise install -q 2>&1 | tail -3 && mise exec -- node --version`);
  check("(h) mise install node 22", r.code === 0 && /v22\./.test(r.out), `${Date.now() - t0} ms: ${r.out.trim().split("\n").pop()}`);

  r = await run("curl -sS -m 10 -o /dev/null -w '%{http_code}' https://platform-control-0.tail9e13b.ts.net:6443/version 2>&1");
  check("(i) k3s API (tailnet IP) blocked from the VM, so kubectl goes through the broker", r.out.trim() === "403", r.out.trim());
} finally {
  await vm.close();
  console.log(`\nproject: ${root}`);
  console.log(`${results.filter(([, ok]) => ok).length}/${results.length} pass`);
}
