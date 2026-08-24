// File-based skills loader (Phase 4 + Agent Skills standard support).
//
// Supports TWO skill formats:
//
// 1. **Agent Skills standard** (https://agentskills.io/specification)
//    - Used by badlogic/pi-skills, the Pi package catalog, Claude Code, Codex CLI.
//    - Each skill is a directory with `SKILL.md` containing YAML frontmatter:
//        ---
//        name: my-skill
//        description: What this skill does and when to use it. Be specific.
//        license: MIT
//        compatibility: Requires Node.js
//        allowed-tools: web_search web_fetch
//        disable-model-invocation: false
//        ---
//        # My Skill
//        Detailed instructions in Markdown body...
//    - Skills can be nested in subdirectories (discovery is recursive).
//    - Skills can ship `scripts/`, `references/`, `assets/` subdirectories.
//
// 2. **Legacy format** (the original AgentCanvas format)
//    - Flat `.md` files with sections: `# Name`, `## When to use`, `## Tools`, `## Guidelines`.
//    - Kept for backward compatibility with the 3 skills already in `.pi/skills/`.
//
// File-based skills supplement the hardcoded skills in `skills/registry.ts`.
// They're merged at startup: their guidelines are injected into the system
// prompt when active, and their `allowed-tools` are added to the relevant
// skill's tool list.

import fs from 'node:fs';
import path from 'node:path';

export interface FileSkill {
  name: string;
  description: string;
  filePath: string;
  /// Absolute path to the skill's directory (for resolving relative `scripts/` etc.).
  dir: string;
  body: string;
  tools: string[];
  guidelines: string[];
  /// Whether this skill uses the Agent Skills standard format (frontmatter).
  standard: boolean;
  /// Optional: license declared in frontmatter.
  license?: string;
  /// Optional: compatibility notes declared in frontmatter.
  compatibility?: string;
  /// Optional: whether the skill should be hidden from the model (model can't
  /// auto-invoke; user must use /skill:name). When true, the skill's guidelines
  /// are still injected into the system prompt (we don't enforce the hide).
  disableModelInvocation?: boolean;
}

// ---- YAML frontmatter parser (minimal) ------------------------------------
//
// We don't pull in a full YAML parser dep — frontmatter is simple enough
// (flat key: value pairs, occasionally a list). This parser handles:
//   - `key: value` (string)
//   - `key: value` (number/boolean — auto-coerced)
//   - `key: "quoted value"`
//   - `key: [item1, item2]` (inline array)
//   - `allowed-tools: tool1 tool2 tool3` (space-delimited string → array)
//
// Doesn't support nested objects or multi-line strings. None of the skills
// in the wild we care about use those.

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  // Match `---\n...\n---\n<body>` (YAML frontmatter).
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const yaml = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};
  for (const line of yaml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value: string = trimmed.slice(colonIdx + 1).trim();
    // Strip quotes if present.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Coerce booleans.
    if (value === 'true') { frontmatter[key] = true; continue; }
    if (value === 'false') { frontmatter[key] = false; continue; }
    // Coerce numbers.
    if (/^-?\d+$/.test(value)) { frontmatter[key] = parseInt(value, 10); continue; }
    if (/^-?\d+\.\d+$/.test(value)) { frontmatter[key] = parseFloat(value); continue; }
    // Special-case `allowed-tools` (space-delimited string → array).
    if (key === 'allowed-tools' || key === 'allowedTools') {
      frontmatter[key] = value.split(/\s+/).filter(Boolean);
      continue;
    }
    // Inline array `[a, b, c]`.
    if (value.startsWith('[') && value.endsWith(']')) {
      frontmatter[key] = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      continue;
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

// ---- Standard format parser (Agent Skills standard) -----------------------

function parseStandardSkill(skillPath: string): FileSkill | null {
  try {
    const content = fs.readFileSync(skillPath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(content);
    const name = (frontmatter.name as string) ?? path.basename(path.dirname(skillPath));
    const description = (frontmatter.description as string) ?? '';
    if (!name || !description) return null;
    // Extract guidelines from the body — first paragraph after the first `#` heading.
    const guidelines: string[] = [];
    const lines = body.split('\n');
    let inGuidelines = false;
    for (const line of lines) {
      // Skip the first H1 — that's the skill title, not a guideline.
      if (line.startsWith('# ') && !inGuidelines) {
        inGuidelines = true;
        continue;
      }
      if (inGuidelines && line.trim() && !line.startsWith('#')) {
        guidelines.push(line.trim());
        if (guidelines.length >= 5) break; // Cap at 5 to keep the system prompt small.
      }
    }
    const tools = (frontmatter['allowed-tools'] as string[]) ?? (frontmatter.allowedTools as string[]) ?? [];
    return {
      name,
      description,
      filePath: skillPath,
      dir: path.dirname(skillPath),
      body,
      tools,
      guidelines,
      standard: true,
      license: frontmatter.license as string | undefined,
      compatibility: frontmatter.compatibility as string | undefined,
      disableModelInvocation: frontmatter['disable-model-invocation'] as boolean | undefined,
    };
  } catch {
    return null;
  }
}

// ---- Legacy format parser --------------------------------------------------

function parseLegacySkill(filePath: string, content: string): FileSkill | null {
  const lines = content.split('\n');
  let name = '';
  let description = '';
  const tools: string[] = [];
  const guidelines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('# ')) {
      name = line.slice(2).trim();
      break;
    }
  }
  if (!name) return null;

  let foundTitle = false;
  for (const line of lines) {
    if (line.startsWith('# ')) { foundTitle = true; continue; }
    if (foundTitle && line.trim() && !line.startsWith('#')) {
      description = line.trim();
      break;
    }
  }

  let inTools = false;
  for (const line of lines) {
    if (line.startsWith('## Tools')) { inTools = true; continue; }
    if (line.startsWith('## ')) { inTools = false; continue; }
    if (inTools && line.startsWith('- ')) {
      const rest = line.slice(2);
      const toolName = rest.split(/[—:]/)[0].trim();
      if (toolName) tools.push(toolName);
    }
  }

  let inGuidelines = false;
  for (const line of lines) {
    if (line.startsWith('## Guidelines')) { inGuidelines = true; continue; }
    if (line.startsWith('## ')) { inGuidelines = false; continue; }
    if (inGuidelines && line.match(/^\d+\.\s/)) {
      guidelines.push(line.replace(/^\d+\.\s/, '').trim());
    }
  }

  return {
    name,
    description,
    filePath,
    dir: path.dirname(filePath),
    body: content,
    tools,
    guidelines,
    standard: false,
  };
}

// ---- Recursive directory scanner ------------------------------------------
//
// Per the Agent Skills standard:
//   - Direct `*.md` files in the skill root are individual skills (legacy format).
//   - Directories containing `SKILL.md` are recursively discovered.

function scanSkillsDir(skillsDir: string): FileSkill[] {
  const skills: FileSkill[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const fullPath = path.join(skillsDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // Check for SKILL.md inside (Agent Skills standard).
      const skillMd = path.join(fullPath, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        const skill = parseStandardSkill(skillMd);
        if (skill) skills.push(skill);
      } else {
        // Recurse into subdirectory (could be a category folder of skills).
        skills.push(...scanSkillsDir(fullPath));
      }
    } else if (entry.endsWith('.md')) {
      // Legacy: flat .md file.
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const skill = parseLegacySkill(fullPath, content);
        if (skill) skills.push(skill);
      } catch {
        // Skip unreadable files.
      }
    }
  }
  return skills;
}

// ---- Public API ------------------------------------------------------------

/// Load all skills from the .pi/skills/ directory (and its subdirectories).
/// Called at server startup (in the API route, not the client).
export function loadFileSkills(skillsDir: string = path.join(process.cwd(), '.pi', 'skills')): FileSkill[] {
  return scanSkillsDir(skillsDir);
}

/// Cache the loaded skills (loaded once at module init).
let cachedSkills: FileSkill[] | null = null;

/// Get the cached file-based skills (loads on first call).
export function getFileSkills(): FileSkill[] {
  if (cachedSkills === null) {
    cachedSkills = loadFileSkills();
  }
  return cachedSkills;
}

/// Force a reload (used by tests / dev hot-reload).
export function reloadFileSkills(): FileSkill[] {
  cachedSkills = loadFileSkills();
  return cachedSkills;
}
