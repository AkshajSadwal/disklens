import { discoverInstalledPrograms } from "../services/programDiscovery.mjs";
import { buildProgramCandidates } from "../services/programAnalysis.mjs";

export function registerProgramRoutes(app, db) {
  app.get("/api/programs", async (request, reply) => {
    try {
      const programs = await discoverInstalledPrograms();
      return {
        programs,
        count: programs.length,
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({
        error: "Could not read installed programs from Windows.",
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

    const items = db.prepare(`
      SELECT
        id,
        root,
        path,
        name,
        type,
        size,
        created_at AS createdAt,
        modified_at AS modifiedAt
      FROM items
      WHERE type IN ('file', 'directory')
    `).all();

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
