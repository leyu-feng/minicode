import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { agentPoolSkillsArchive, readAgentPoolSkills } from "./agent-pool-skills.js";
import { agentPoolSkillsRoutes } from "../routes/agent-pools.js";
import { errorHandler } from "../middleware/error-handler.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pool-skills-"));
  directories.push(directory);
  const root = path.join(directory, "skills");
  await fs.mkdir(path.join(root, "paperclip", "references"), { recursive: true });
  await fs.writeFile(path.join(directory, "LICENSE"), "Fixture license");
  await fs.writeFile(path.join(root, "paperclip", "SKILL.md"), "# Fixture Paperclip skill");
  await fs.writeFile(path.join(root, "paperclip", "references", "api.md"), "Use the authenticated API");
  return root;
}

describe("AgentPool downloadable operational skills", () => {
  it("hashes deterministic ZIP bytes and snapshots references, skill content, and licensing", async () => {
    const root = await fixture();
    const first = await readAgentPoolSkills(root);
    expect(await readAgentPoolSkills(root)).toEqual(first);
    const archive = agentPoolSkillsArchive(first.sha256)!;
    expect(createHash("sha256").update(archive).digest("hex")).toBe(first.sha256);
    const contents = unzipSync(archive);
    for (const file of first.files) {
      expect(createHash("sha256").update(contents[file.path]!).digest("hex")).toBe(file.sha256);
    }
    expect(contents).toHaveProperty("LICENSE");
    await fs.writeFile(path.join(root, "paperclip", "references", "api.md"), "Updated API instructions");
    const changed = await readAgentPoolSkills(root);
    expect(changed.sha256).not.toBe(first.sha256);
    expect(agentPoolSkillsArchive(first.sha256)).toEqual(archive);
  });

  it("resolves the shipped skills without reading worker_shared and refuses linked or incomplete bundles", async () => {
    const shipped = await readAgentPoolSkills();
    expect(shipped.files.some(file => file.path === "paperclip/scripts/paperclip-issue-update.sh")).toBe(true);
    const root = await fixture();
    await fs.rm(path.join(root, "paperclip", "SKILL.md"));
    await expect(readAgentPoolSkills(root)).rejects.toThrow("missing the Paperclip skill");
    const other = await fixture();
    await fs.symlink(path.join(other, "paperclip"), path.join(root, "linked"), "junction");
    await expect(readAgentPoolSkills(root)).rejects.toThrow("Unsupported skill bundle entry");
  });

  it("serves immutable authenticated downloads and rejects anonymous or unavailable requests", async () => {
    const skills = await readAgentPoolSkills(await fixture());
    function app(actor: Express.Request["actor"]) {
      const result = express();
      result.use((req, _res, next) => { req.actor = actor; next(); });
      result.use("/api", agentPoolSkillsRoutes());
      result.use(errorHandler);
      return result;
    }
    await request(app({ type: "none", source: "none" })).get(skills.url).expect(403);
    const application = app({ type: "agent", agentId: "agent-a", companyId: "company-a", source: "agent_key" });
    const response = await request(application).get(skills.url).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
      res.on("error", done);
    }).expect(200).expect("Content-Type", /application\/zip/);
    expect(Buffer.from(response.body)).toEqual(agentPoolSkillsArchive(skills.sha256));
    await request(application).get(`/api/agent-pool/skills/${"0".repeat(64)}.zip`).expect(404);
  });
});
