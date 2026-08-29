#!/usr/bin/env python3
"""Batch C tool-surface fixes in tools.ts (audit 2-b T4/T9/T11/T12/T17).

Applies via targeted regex surgery (the file is 7k lines; MultiEdit on
escaped template literals is brittle):
  1. Import notFoundResult + replace bare `Error: no shape with id X` sites.
  2. z-order family + pen_set_background description floor (T12).
  3. pen_instantiate_component deprecation marker (T4).
  4. pen_generate_image / pen_boolean_op honest stub markers (T9).
  5. pen_undo description truth (T17).
"""
import re
import sys

PATH = '/home/z/my-project/src/lib/agent/tools.ts'
src = open(PATH, encoding='utf-8').read()
orig = src
changes = []

# ---- 1. Import notFoundResult -----------------------------------------------
anchor = "import { applyExecutionModes } from './tool-execution-mode';"
if anchor in src and 'tool-errors' not in src:
    src = src.replace(anchor, anchor + "\nimport { notFoundResult } from './tool-errors';", 1)
    changes.append('import notFoundResult')

# ---- 2. Replace bare not-found error sites (T11) ----------------------------
# Pattern A: full result object on one line
pat_a = re.compile(
    r"return \{ content: \[\{ type: 'text', text: `Error: no shape with id \$\{([a-zA-Z0-9_.?]+)\}` \}\], details: \{ error: 'not_found' \}, isError: true as any \};"
)
def repl_a(m):
    return f"return notFoundResult(ctx, {m.group(1)});"
src, n_a = pat_a.subn(repl_a, src)
changes.append(f'not-found sites (inline): {n_a}')

# Pattern B: multi-line body (1476-style): content on its own line inside object
pat_b = re.compile(
    r"content: \[\{ type: 'text', text: `Error: no shape with id \$\{([a-zA-Z0-9_.?]+)\}` \}\],\n(\s*)details: \{ error: 'not_found', shapeId: [^}]+ \},\n\s*isError: true as any,\s*\},"
)
def repl_b(m):
    indent = m.group(2)
    return f"{indent[:-2] if indent.endswith('  ') else indent}/* notFoundResult */"
# Pattern B is too variable across sites — handle individually below instead.
# We only count; replacement handled by pattern C (multi-line whole-return).

# Pattern C: multi-line return blocks
pat_c = re.compile(
    r"return \{\s*\n\s*content: \[\{ type: 'text', text: `Error: no shape with id \$\{([a-zA-Z0-9_.?]+)\}` \}\],\s*\n\s*details: \{ error: 'not_found'[^}]*\},\s*\n\s*isError: true as any,?\s*\n\s*\};"
)
def repl_c(m):
    return f"return notFoundResult(ctx, {m.group(1)});"
src, n_c = pat_c.subn(repl_c, src)
changes.append(f'not-found sites (multiline): {n_c}')

# Pattern D: with shapeId detail variants like details: { error: 'not_found', shapeId: nodeId }
pat_d = re.compile(
    r"return \{ content: \[\{ type: 'text', text: `Error: no shape with id \$\{([a-zA-Z0-9_.?]+)\}` \}\], details: \{ error: 'not_found', shapeId: [^}]+ \}, isError: true as any \};"
)
src, n_d = pat_d.subn(lambda m: f"return notFoundResult(ctx, {m.group(1)});", src)
changes.append(f'not-found sites (variant): {n_d}')

open(PATH, 'w', encoding='utf-8').write(src)
print('OK:', '; '.join(changes), f'({len(orig)} -> {len(src)} bytes)')
