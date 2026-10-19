import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { resolvePaperclipSkillsDir } from "@paperclipai/adapter-utils/server-utils";
import { agentPoolSkillsSchema, type AgentPoolSkills } from "@paperclipai/shared";

const bundles = new Map<string, Buffer>();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let pending: Promise<AgentPoolSkills> | null = null;

export function readAgentPoolSkills(root?: string, onboardingRoot?: string): Promise<AgentPoolSkills> {
  if (root || onboardingRoot) return buildSkillsBundle(root, onboardingRoot);
  // Concurrent dispatches share one snapshot and retain their reservation order.
  return pending ??= buildSkillsBundle().finally(() => { pending = null; });
}

async function buildSkillsBundle(root?: string, onboardingRoot?: string): Promise<AgentPoolSkills> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  if (!root) onboardingRoot ??= path.resolve(moduleDir, "../onboarding-assets");
  root ??= await resolvePaperclipSkillsDir(moduleDir, [path.resolve(moduleDir, "../../../skills")]) ?? undefined;
  if (!root) throw new Error("AgentPool bundled Paperclip skills are unavailable");
  const contents: Record<string, Uint8Array> = Object.create(null);
  const names = new Set<string>();
  let total = 0;
  async function walk(directory: string, relative = "") {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Skill bundle directories must not be links");
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      if (!relative) {
        const key = entry.name.toLowerCase();
        if (names.has(key)) throw new Error(`Duplicate AgentPool bundled skill name: ${entry.name}`);
        names.add(key);
      }
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(location, name);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(location);
        total += bytes.length;
        if (total > 8 * 1024 * 1024 || Object.keys(contents).length >= 256) {
          throw new Error("AgentPool skill bundle exceeds its size or file limit");
        }
        contents[name] = bytes;
      } else throw new Error(`Unsupported skill bundle entry: ${name}`);
    }
  }
  await walk(root);
  if (onboardingRoot) {
    const info = await fs.lstat(onboardingRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Onboarding skill roots must not be links");
    // Every onboarding flow contributes its entire skills/ tree, including future skills.
    for (const entry of await fs.readdir(onboardingRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Onboarding skill roots must not be links");
      if (!entry.isDirectory()) continue;
      const directory = path.join(onboardingRoot, entry.name, "skills");
      try {
        await fs.lstat(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await walk(directory);
    }
  }
  contents.LICENSE = await fs.readFile(path.join(root, "..", "LICENSE"));
  if (total + contents.LICENSE.length > 8 * 1024 * 1024 || Object.keys(contents).length > 256) {
    throw new Error("AgentPool skill bundle exceeds its size or file limit");
  }
  if (!Object.hasOwn(contents, "paperclip/SKILL.md")) throw new Error("AgentPool bundle is missing the Paperclip skill");
  const files = Object.keys(contents).sort().map(name => ({ path: name, sha256: digest(contents[name]!) }));
  const archive = Buffer.from(zipSync(Object.fromEntries(files.map(file => [file.path, contents[file.path]!])),
    { level: 6, mtime: new Date(1980, 0, 1) }));
  if (archive.length > 4 * 1024 * 1024) throw new Error("AgentPool skill ZIP exceeds 4 MiB");
  const sha256 = digest(archive);
  const manifest = agentPoolSkillsSchema.parse({ version: 1, sha256, url: `/api/agent-pool/skills/${sha256}.zip`, files });
  bundles.set(sha256, archive);
  if (bundles.size > 16) bundles.delete(bundles.keys().next().value!);
  return manifest;
}

export function agentPoolSkillsArchive(sha256: string) {
  return bundles.get(sha256);
}
