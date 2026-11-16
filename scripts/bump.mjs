/**
 * Release helper: bumps the version in manifest.json + package.json, records it
 * in versions.json, commits, tags, and pushes — which triggers the GitHub
 * Actions release workflow.
 *
 * Usage: node scripts/bump.mjs [patch|minor|major]   (default: patch)
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const bumpType = (process.argv[2] ?? "patch").toLowerCase();
if (!["patch", "minor", "major"].includes(bumpType)) {
	console.error(`Unknown bump type "${bumpType}" — use patch, minor or major.`);
	process.exit(1);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const manifest = readJson("manifest.json");
const pkg = readJson("package.json");
let versions = {};
try {
	versions = readJson("versions.json");
} catch {
	// first release — start empty
}

const [major, minor, patch] = manifest.version.split(".").map(Number);
const next =
	bumpType === "major"
		? `${major + 1}.0.0`
		: bumpType === "minor"
			? `${major}.${minor + 1}.0`
			: `${major}.${minor}.${patch + 1}`;

manifest.version = next;
pkg.version = next;
versions[next] = manifest.minAppVersion;

writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");
writeFileSync("package.json", JSON.stringify(pkg, null, "\t") + "\n");
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

execSync(
	`git add -A && git commit -m "Release ${next}" && git tag ${next} && git push origin main --tags`,
	{ stdio: "inherit" },
);

console.log(`\n✅ Released ${next} — GitHub Actions is now building and publishing the release.`);
console.log("   Check it at: https://github.com/bicybert/discord-to-obsidian/actions");
