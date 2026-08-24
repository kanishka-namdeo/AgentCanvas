#!/usr/bin/env python3
"""Move the fidelity helper block out of createCanvasTools to module scope in tools.ts."""
import re

P = '/home/z/my-project/src/lib/agent/tools.ts'
src = open(P).read()

# The block: from the "/// Fidelity parameter" doc comment (inside the function)
# through the end of applyLofiFidelity, ending right before "  const createShape = defineTool({"
pattern = re.compile(
    r"\n  /// Fidelity parameter shared by the generator tools\..*?\n  /// Downgrade generated shapes.*?\n}\n\n(?=  const createShape = defineTool\(\{)",
    re.DOTALL,
)
m = pattern.search(src)
assert m, 'inner block not found'
block = m.group(0)

# Remove from inside the function
src = src[:m.start()] + '\n' + src[m.end():]

# Re-insert at module scope, just before the Tool factory comment
anchor = '// ---- Tool factory -----------------------------------------------------------'
assert anchor in src, 'factory anchor not found'
module_block = (
    '\n// ---- Generator fidelity (lo-fi downgrade) ----------------------------------\n'
    + block.strip('\n')
    + '\n\n'
)
src = src.replace(anchor, module_block + anchor, 1)

open(P, 'w').write(src)
print('moved OK — block now at module scope')
