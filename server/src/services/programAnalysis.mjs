const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "app", "application", "software",
  "program", "programs", "inc", "ltd", "llc", "corp", "corporation",
  "company", "technologies", "technology", "windows", "update", "helper",
  "service", "edition", "version",
]);

const GENERIC_FILE_NAMES = new Set([
  "setup.exe", "install.exe", "installer.exe", "uninstall.exe", "unins000.exe",
  "update.exe", "updater.exe", "launcher.exe", "bootstrapper.exe", "readme.txt",
  "license.txt", "eula.txt",
]);

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeCompact(value) {
  return normalize(value).replace(/\s+/g, "");
}

function tokensFor(value) {
  return [...new Set(
    normalize(value)
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  )];
}

export function getProgramCandidateSearchTerms(programInput) {
  return [...new Set([
    ...tokensFor(programInput?.name),
    ...tokensFor(programInput?.publisher),
  ])];
}

function cleanPath(value) {
  return String(value ?? "")
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/[\\/]+$/, "");
}

function lowerPath(value) {
  return cleanPath(value).replaceAll("/", "\\").toLowerCase();
}

function isUnder(child, parent) {
  const c = lowerPath(child);
  const p = lowerPath(parent);
  if (!p) return false;
  return c === p || c.startsWith(`${p}\\`);
}

function pathSegments(value) {
  return lowerPath(value)
    .split("\\")
    .map((segment) => normalize(segment))
    .filter(Boolean);
}

function basename(value) {
  const cleaned = cleanPath(value).replaceAll("/", "\\");
  const index = cleaned.lastIndexOf("\\");
  return index >= 0 ? cleaned.slice(index + 1) : cleaned;
}

function extractRegisteredExecutable(program) {
  const values = [program.uninstallString, program.quietUninstallString];

  for (const rawValue of values) {
    const value = String(rawValue ?? "").trim();
    if (!value) continue;

    const quoted = value.match(/^"([^"]+\.(?:exe|com|bat|cmd))"/i);
    if (quoted?.[1]) return cleanPath(quoted[1]);

    const exe = value.match(/([A-Za-z]:\\[^,]+?\.(?:exe|com|bat|cmd))/i);
    if (exe?.[1]) return cleanPath(exe[1]);
  }

  return "";
}

function isProtectedSystemPath(itemPath) {
  const lower = lowerPath(itemPath);
  return (
    /:\\windows(?:\\|$)/i.test(lower) ||
    /\\program files(?: \(x86\))?\\common files(?:\\|$)/i.test(lower) ||
    /:\\programdata\\microsoft(?:\\|$)/i.test(lower) ||
    /^(?:\\)?(?:usr|etc|bin|sbin|lib|lib64|boot|dev|proc|root|run|sys|var)(?:\\|$)/i.test(lower.replace(/^([a-z]:)/i, "").replace(/^\\/, "")) ||
    /^(?:\\)(?:system|library)(?:\\|$)/i.test(lower)
  );
}

function scoreCandidate(item, program, tokens) {
  const itemPath = cleanPath(item.path);
  const lowerItemPath = lowerPath(itemPath);
  const lowerItemName = String(item.name ?? "").toLowerCase();
  const normalizedItemName = normalize(item.name);
  const normalizedProgram = normalize(program.name);
  const installLocation = cleanPath(program.installLocation);
  const displayIcon = cleanPath(program.displayIcon);
  const registeredExecutable = extractRegisteredExecutable(program);
  const itemSegments = pathSegments(itemPath);

  const reasons = [];
  const signals = [];
  let score = 0;
  let category = "possible-leftover";
  let verified = false;

  if (displayIcon && lowerItemPath === lowerPath(displayIcon)) {
    score = 100;
    verified = true;
    category = "verified";
    signals.push("exact-display-icon");
    reasons.push("Exact match for the program's registered executable/icon path.");
  }

  if (installLocation && isUnder(itemPath, installLocation)) {
    score = 100;
    verified = true;
    category = "verified";
    signals.push("inside-install-location");
    reasons.push("Inside the program's registered InstallLocation.");
  }

  if (registeredExecutable && lowerItemPath === lowerPath(registeredExecutable)) {
    score = Math.max(score, 95);
    if (!verified) category = "strong-match";
    signals.push("exact-uninstall-executable");
    reasons.push("Exact match for an executable registered by the program's uninstall information.");
  }

  if (normalizedProgram) {
    const compactItemPath = normalizeCompact(itemPath);
    const compactProgram = normalizeCompact(program.name);

    const exactNameSegment = itemSegments.includes(normalizedProgram);
    const compactNameMatch = compactProgram && compactItemPath.includes(compactProgram);

    if (exactNameSegment || compactNameMatch) {
      score += 42;
      signals.push("program-name-path-match");
      reasons.push("The indexed path contains the program's normalized name.");
    } else {
      const matchedTokens = tokens.filter((token) =>
        itemSegments.some((segment) =>
          segment === token ||
          segment.includes(` ${token} `) ||
          segment.startsWith(`${token} `) ||
          segment.endsWith(` ${token}`) ||
          segment.includes(token),
        ),
      );

      if (matchedTokens.length) {
        const ratio = matchedTokens.length / Math.max(tokens.length, 1);
        score += ratio >= 0.75 ? 36 : ratio >= 0.5 ? 28 : 16;
        signals.push("program-token-path-match");
        reasons.push(`Path matches ${matchedTokens.length} of ${tokens.length} distinctive program name token(s).`);
      }
    }
  }

  const normalizedDisplayIconName = normalize(basename(displayIcon));
  const normalizedRegisteredExecutableName = normalize(basename(registeredExecutable));
  if (
    (normalizedDisplayIconName && normalizedDisplayIconName === normalizedItemName) ||
    (normalizedRegisteredExecutableName && normalizedRegisteredExecutableName === normalizedItemName)
  ) {
    score += 26;
    signals.push("registered-file-name-match");
    reasons.push("Filename matches a registered program executable name.");
  } else {
    const filenameTokenMatches = tokens.filter((token) => normalizedItemName.includes(token));
    if (filenameTokenMatches.length >= 2) {
      score += 18;
      signals.push("multi-token-file-name-match");
      reasons.push("Filename contains multiple distinctive program-name tokens.");
    } else if (filenameTokenMatches.length === 1) {
      score += 8;
      signals.push("single-token-file-name-match");
      reasons.push("Filename contains one distinctive program-name token.");
    }
  }

  if (normalizedProgram) {
    const compactTokens = tokens.filter((token) => lowerItemPath.includes(token));
    if (compactTokens.length && !signals.includes("program-token-path-match") && !signals.includes("program-name-path-match")) {
      score += 12;
      signals.push("program-substring-path-match");
      reasons.push("A distinctive program name token appears in the indexed path.");
    }
  }

  const publisherTokens = tokensFor(program.publisher);
  if (publisherTokens.length) {
    const publisherMatches = publisherTokens.filter((token) =>
      itemSegments.some((segment) => segment === token || segment.includes(token)),
    );
    if (publisherMatches.length) {
      score += Math.min(8, publisherMatches.length * 4);
      signals.push("publisher-path-match");
      reasons.push("Path also contains a publisher token.");
    }
  }

  if (/\\(appdata\\local|appdata\\roaming|programdata)(\\|$)/i.test(itemPath)) {
    score += 6;
    signals.push("common-app-data-location");
    reasons.push("Located in a common application-data location used by Windows programs.");
  }

  if (GENERIC_FILE_NAMES.has(lowerItemName) && !verified) {
    score -= 14;
    reasons.push("Generic installer/uninstaller-style filename lowers ownership confidence.");
  }

  if (isProtectedSystemPath(itemPath) && !verified) {
    score -= 45;
    signals.push("protected-system-path");
    reasons.push("Protected/shared Windows path is treated as weak evidence unless directly registered by the program.");
  }

  if (!signals.length) return null;

  score = Math.max(0, Math.min(100, Math.round(score)));

  if (verified) {
    category = "verified";
  } else if (score >= 85) {
    category = "strong-match";
  } else if (score >= 60) {
    category = "possible-leftover";
  } else {
    return null;
  }

  return {
    ...item,
    confidence: score,
    category,
    defaultSelected: category === "verified" && item.type === "file",
    reasons: [...new Set(reasons)],
  };
}

export function buildProgramCandidates(items, programInput) {
  const program = {
    name: String(programInput?.name ?? "").trim(),
    version: String(programInput?.version ?? "").trim(),
    publisher: String(programInput?.publisher ?? "").trim(),
    installLocation: cleanPath(programInput?.installLocation),
    displayIcon: cleanPath(programInput?.displayIcon),
    uninstallString: String(programInput?.uninstallString ?? "").trim(),
    quietUninstallString: String(programInput?.quietUninstallString ?? "").trim(),
  };

  if (!program.name) return { program, candidates: [] };

  const tokens = tokensFor(program.name);
  const candidates = [];

  for (const item of items) {
    const candidate = scoreCandidate(item, program, tokens);
    if (candidate) candidates.push(candidate);
  }

  candidates.sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return Number(b.size || 0) - Number(a.size || 0);
  });

  return {
    program,
    candidates: candidates.slice(0, 2000),
  };
}
