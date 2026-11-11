import path from "node:path";
import { buildProgramCandidates, getProgramCandidateSearchTerms } from "../services/programAnalysis.mjs";
import { discoverInstalledPrograms } from "../services/programDiscovery.mjs";
import { buildProgramStorageRows } from "../services/storageAdvisor.mjs";

export function registerProgramRoutes(app, db) {
  app.get("/api/programs", async (request, reply) => {
    try {
      const discoveredPrograms = await discoverInstalledPrograms();
      const sizedPrograms = await buildProgramStorageRows(db, discoveredPrograms);
      // Keep uninstall metadata required by Program Cleanup while exposing
      // accurate indexed sizes (or explicitly labelled package/registry estimates).
      const keyOf = (program) => [program.name, program.version, program.publisher]
        .map((value) => String(value || "").trim().toLowerCase()).join("|");
      const details = new Map(discoveredPrograms.map((program) => [keyOf(program), program]));
      const programs = sizedPrograms.map((row) => ({ ...(details.get(keyOf(row)) || {}), ...row }));
      programs.sort((a, b) => (Number(b.size) - Number(a.size)) || a.name.localeCompare(b.name));
      return { programs, count: programs.length };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({
        error: `Could not read installed programs on ${process.platform}.`,
        details: error.message,
      });
    }
  });

  app.post("/api/programs/candidates", async (request, reply) => {
    const program = request.body ?? {};

    if (typeof program.name !== "string" || !program.name.trim()) {
      return reply.code(400).send({
        error: "program.name is required",
      });
    }

    const predicates = [];
    const params = [];
    const installLocation = String(program.installLocation || "").trim().replace(/[\\/]+$/, "");
    if (installLocation) {
      const prefix = `${installLocation}${path.sep}`;
      predicates.push("(lower(path) = lower(?) OR substr(lower(path), 1, length(lower(?))) = lower(?))");
      params.push(installLocation, prefix, prefix);
    }
    if (program.displayIcon && typeof program.displayIcon === "string") {
      predicates.push("lower(path) = lower(?)");
      params.push(program.displayIcon.trim());
    }
    for (const term of getProgramCandidateSearchTerms(program)) {
      predicates.push("(lower(path) LIKE ? OR lower(name) LIKE ?)");
      params.push(`%${term}%`, `%${term}%`);
    }
    const where = predicates.length ? `AND (${predicates.join(" OR ")})` : "";
    const items = db.prepare(`
      SELECT id, root, path, name, type, size,
        created_at AS createdAt, modified_at AS modifiedAt
      FROM items
      WHERE type IN ('file', 'directory') ${where}
      ORDER BY size DESC
      LIMIT 10000
    `).all(...params);

    const analysis = buildProgramCandidates(items, program);

    return {
      program: analysis.program,
      candidates: analysis.candidates,
      summary: {
        total: analysis.candidates.length,
        verified: analysis.candidates.filter((item) => item.category === "verified").length,
        possibleLeftovers: analysis.candidates.filter((item) => item.category !== "verified").length,
        defaultSelected: analysis.candidates.filter((item) => item.defaultSelected).length,
      },
    };
  });
}
