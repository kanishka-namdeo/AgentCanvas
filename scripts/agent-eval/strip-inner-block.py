#!/usr/bin/env python3
"""Remove the duplicated fidelity block inside createCanvasTools (module-scope copy stays)."""
P = '/home/z/my-project/src/lib/agent/tools.ts'
src = open(P).read()

start_marker = "  // =====================================================================\n  // CORE CANVAS OPS (existing)\n  // =====================================================================\n\n"
i = src.find(start_marker)
assert i >= 0, 'section header not found'

# The inner block starts with the doc comment and ends right before "  const createShape = defineTool({"
j = src.find('  const createShape = defineTool({', i)
assert j >= 0, 'createShape not found after header'

between = src[i + len(start_marker):j]
assert 'Fidelity parameter shared' in between, f'unexpected content between markers: {between[:120]!r}'
assert 'applyLofiFidelity' in between

# Replace the whole inner block with nothing (keep the section header + createShape)
src = src[:i + len(start_marker)] + src[j:]
open(P, 'w').write(src)
print('inner block removed OK')
