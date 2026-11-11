import path from "node:path";
import { buildProgramCandidates, getProgramCandidateSearchTerms } from "../services/programAnalysis.mjs";
import { discoverInstalledPrograms } from "../services/programDiscovery.mjs";

export function registerProgramRoutes(app, db) {
  app.get("/api/programs", async (request, reply) => {
    try {
      const discoveredPrograms = await discoverInstalledPrograms();
      // The list view only needs installed-program metadata. Previously this
      // endpoint ran one SQLite prefix aggregation per installed application,
      // which could block the UI for tens of seconds on large indexes. Keep the
      // registry/package estimate here and calculate indexed evidence only for
      // the specific program when the user requests analysis.
      const programs = discoveredPrograms.map((program) => {
        const estimatedSizeKB = Number(program.estimatedSizeKB) || 0;
        return {
          ...program,
          size: estimatedSizeKB * 1024,
          fileCount: 0,
          estimatedSizeKB,
          sizeBasis: estimatedSizeKB > 0 ? "package-manager-or-registry-estimate" : "not-available",
        };
      });
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
