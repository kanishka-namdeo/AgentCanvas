// File-based skills loader (Phase 4).
//
// Reads skill definitions from .pi/skills/*.md files. Each file uses a
// simple Markdown format with frontmatter-like sections:
//   # Skill Name
//   ## When to use
//   ## Tools
//   ## Guidelines
//
// This mirrors the pi-agent SDK's loadSkills() / parseSkillBlock() pattern,
// but adapted for our web-app context (skills are bundled at build time,
// not loaded from the user's filesystem at runtime).
//
// The loaded skills supplement the hardcoded skills in skills/registry.ts.
// They're merged at startup: file-based skills are added to the registry,
// and their guidelines are injected into the system prompt when active.

import fs from 'node:fs';
import path from 'node:path';

export interface FileSkill {
  name: string;
  description: string;
  filePath: string;
  body: string;
  tools: string[];
  guidelines: string[];
}

/// Parse a skill Markdown file into a FileSkill.
/// Format:
///   # Skill Name
///   Description (first paragraph after the title)
///
///   ## When to use
///   - bullet points
///
///   ## Tools
///   - tool_name — description
///
///   ## Guidelines
///   1. numbered steps
function parseSkillFile(filePath: string, content: string): FileSkill | null {
  const lines = content.split('\n');
  let name = '';
  let description = '';
  let body = content;
  const tools: string[] = [];
  const guidelines: string[] = [];

  // Extract name from first # heading.
  for (const line of lines) {
    if (line.startsWith('# ')) {
      name = line.slice(2).trim();
      break;
    }
  }
  if (!name) return null;

  // Extract description (first non-empty, non-heading line after the title).
  let foundTitle = false;
  for (const line of lines) {
    if (line.startsWith('# ')) { foundTitle = true; continue; }
    if (foundTitle && line.trim() && !line.startsWith('#')) {
      description = line.trim();
      break;
    }
  }

  // Extract tools from "## Tools" section.
  let inTools = false;
  for (const line of lines) {
    if (line.startsWith('## Tools')) { inTools = true; continue; }
    if (line.startsWith('## ')) { inTools = false; continue; }
    if (inTools && line.startsWith('- ')) {
      // Extract tool name (before the — or : if present).
      const rest = line.slice(2);
      const toolName = rest.split(/[—:]/)[0].trim();
      if (toolName) tools.push(toolName);
    }
  }

  // Extract guidelines from "## Guidelines" section.
  let inGuidelines = false;
  for (const line of lines) {
    if (line.startsWith('## Guidelines')) { inGuidelines = true; continue; }
    if (line.startsWith('## ')) { inGuidelines = false; continue; }
    if (inGuidelines && line.match(/^\d+\.\s/)) {
      guidelines.push(line.replace(/^\d+\.\s/, '').trim());
    }
  }

  return { name, description, filePath, body, tools, guidelines };
}

/// Load all skills from the .pi/skills/ directory.
/// Called at server startup (in the API route, not the client).
export function loadFileSkills(skillsDir: string = path.join(process.cwd(), '.pi', 'skills')): FileSkill[] {
  try {
    if (!fs.existsSync(skillsDir)) return [];
    const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith('.md'));
    const skills: FileSkill[] = [];
    for (const file of files) {
      const filePath = path.join(skillsDir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const skill = parseSkillFile(filePath, content);
      if (skill) skills.push(skill);
    }
    return skills;
  } catch {
    return [];
  }
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
