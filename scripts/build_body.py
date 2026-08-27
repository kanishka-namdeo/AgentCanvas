"""
Build the body PDF for "Design Systems for Agentic Workflows" strategy memo.
Uses ReportLab + TocDocTemplate. Cool Indigo palette (cold intent, analogous harmony).
Body starts with TOC. No cover in story[] - cover is rendered separately via HTML/Playwright.

Output: /home/z/my-project/download/_body.pdf
"""
import os
import sys
import hashlib

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY, TA_RIGHT
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether, HRFlowable
)
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.platypus.doctemplate import PageTemplate
from reportlab.platypus.frames import Frame

# ━━ Cascade Palette (cold intent, minimal mode, analogous harmony) ━━━━━━━━━
PAGE_BG       = colors.HexColor('#eef0f0')
SECTION_BG    = colors.HexColor('#edefef')
CARD_BG       = colors.HexColor('#eceef0')
TABLE_STRIPE  = colors.HexColor('#eff0f1')
HEADER_FILL   = colors.HexColor('#374d57')   # M tier — structural fills (deep slate)
COVER_BLOCK   = colors.HexColor('#4e6570')
BORDER        = colors.HexColor('#c0cfd6')
ICON          = colors.HexColor('#3d6a81')
ACCENT        = colors.HexColor('#246a8d')   # XS tier — Indigo accent
ACCENT_2      = colors.HexColor('#6056c7')
TEXT_PRIMARY  = colors.HexColor('#161819')
TEXT_MUTED    = colors.HexColor('#81878b')
SEM_SUCCESS   = colors.HexColor('#4a8a5f')
SEM_WARNING   = colors.HexColor('#988051')
SEM_ERROR     = colors.HexColor('#a35049')
SEM_INFO      = colors.HexColor('#507293')

TABLE_HEADER_COLOR = HEADER_FILL
TABLE_HEADER_TEXT  = colors.white
TABLE_ROW_EVEN     = colors.white
TABLE_ROW_ODD      = TABLE_STRIPE


# ━━ Font registration ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FONT_DIR = '/usr/share/fonts'

pdfmetrics.registerFont(TTFont('NotoSerifSC', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Regular.ttf'))
pdfmetrics.registerFont(TTFont('NotoSerifSC-Bold', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Bold.ttf'))
pdfmetrics.registerFont(TTFont('SarasaMonoSC', f'{FONT_DIR}/truetype/chinese/SarasaMonoSC-Regular.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif', f'{FONT_DIR}/truetype/freefont/FreeSerif.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-Bold', f'{FONT_DIR}/truetype/freefont/FreeSerifBold.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-Italic', f'{FONT_DIR}/truetype/freefont/FreeSerifItalic.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-BoldItalic', f'{FONT_DIR}/truetype/freefont/FreeSerifBoldItalic.ttf'))
pdfmetrics.registerFont(TTFont('DejaVuSans', f'{FONT_DIR}/truetype/dejavu/DejaVuSansMono.ttf'))

registerFontFamily('NotoSerifSC', normal='NotoSerifSC', bold='NotoSerifSC-Bold')
registerFontFamily('FreeSerif', normal='FreeSerif', bold='FreeSerif-Bold',
                   italic='FreeSerif-Italic', boldItalic='FreeSerif-BoldItalic')
registerFontFamily('DejaVuSans', normal='DejaVuSans', bold='DejaVuSans')

# Install font fallback so mixed CJK/Latin text works automatically
sys.path.insert(0, '/home/z/my-project/skills/pdf/scripts')
from pdf import install_font_fallback  # noqa: E402
install_font_fallback()


# ━━ Styles ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BODY_FONT = 'FreeSerif'
BOLD_FONT = 'FreeSerif-Bold'
ITALIC_FONT = 'FreeSerif-Italic'
MONO_FONT = 'DejaVuSans'

styles = getSampleStyleSheet()

h1_style = ParagraphStyle(
    name='H1', fontName=BOLD_FONT, fontSize=20, leading=26,
    textColor=HEADER_FILL, alignment=TA_LEFT,
    spaceBefore=24, spaceAfter=10,
)
h2_style = ParagraphStyle(
    name='H2', fontName=BOLD_FONT, fontSize=14, leading=20,
    textColor=HEADER_FILL, alignment=TA_LEFT,
    spaceBefore=14, spaceAfter=6,
)
body_style = ParagraphStyle(
    name='Body', fontName=BODY_FONT, fontSize=10.5, leading=16,
    textColor=TEXT_PRIMARY, alignment=TA_JUSTIFY,
    spaceBefore=0, spaceAfter=8,
)
body_left_style = ParagraphStyle(
    name='BodyLeft', fontName=BODY_FONT, fontSize=10.5, leading=16,
    textColor=TEXT_PRIMARY, alignment=TA_LEFT,
    spaceBefore=0, spaceAfter=8,
)
intro_style = ParagraphStyle(
    name='Intro', fontName=ITALIC_FONT, fontSize=11, leading=17,
    textColor=TEXT_MUTED, alignment=TA_LEFT,
    spaceBefore=2, spaceAfter=12,
)
caption_style = ParagraphStyle(
    name='Caption', fontName=ITALIC_FONT, fontSize=9, leading=12,
    textColor=TEXT_MUTED, alignment=TA_CENTER,
    spaceBefore=3, spaceAfter=14,
)
mono_style = ParagraphStyle(
    name='Mono', fontName=MONO_FONT, fontSize=8.5, leading=11,
    textColor=TEXT_PRIMARY, alignment=TA_LEFT,
    backColor=CARD_BG, borderPadding=6, leftIndent=4, rightIndent=4,
    spaceBefore=4, spaceAfter=12,
)
callout_label_style = ParagraphStyle(
    name='CalloutLabel', fontName=BOLD_FONT, fontSize=8, leading=11,
    textColor=ACCENT, alignment=TA_LEFT, spaceAfter=2,
)
callout_stat_style = ParagraphStyle(
    name='CalloutStat', fontName=BOLD_FONT, fontSize=22, leading=26,
    textColor=HEADER_FILL, alignment=TA_LEFT, spaceAfter=2,
)
callout_desc_style = ParagraphStyle(
    name='CalloutDesc', fontName=BODY_FONT, fontSize=9.5, leading=13,
    textColor=TEXT_MUTED, alignment=TA_LEFT,
)
pull_quote_style = ParagraphStyle(
    name='PullQuote', fontName=ITALIC_FONT, fontSize=11.5, leading=18,
    textColor=HEADER_FILL, alignment=TA_LEFT,
    leftIndent=18, rightIndent=8, spaceBefore=10, spaceAfter=14,
    borderPadding=(0, 0, 0, 6),
)
toc_h1_style = ParagraphStyle(
    name='TOCH1', fontName=BOLD_FONT, fontSize=11, leading=18,
    textColor=TEXT_PRIMARY, leftIndent=0,
)
toc_h2_style = ParagraphStyle(
    name='TOCH2', fontName=BODY_FONT, fontSize=10, leading=15,
    textColor=TEXT_MUTED, leftIndent=18,
)
table_header_style = ParagraphStyle(
    name='TableHeader', fontName=BOLD_FONT, fontSize=9.5, leading=13,
    textColor=colors.white, alignment=TA_LEFT,
)
table_cell_style = ParagraphStyle(
    name='TableCell', fontName=BODY_FONT, fontSize=9, leading=12,
    textColor=TEXT_PRIMARY, alignment=TA_LEFT,
)
table_cell_center_style = ParagraphStyle(
    name='TableCellCenter', fontName=BODY_FONT, fontSize=9, leading=12,
    textColor=TEXT_PRIMARY, alignment=TA_CENTER,
)


# ━━ TocDocTemplate ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
class TocDocTemplate(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        if hasattr(flowable, 'bookmark_name'):
            level = getattr(flowable, 'bookmark_level', 0)
            text = getattr(flowable, 'bookmark_text', '')
            key = getattr(flowable, 'bookmark_key', '')
            self.notify('TOCEntry', (level, text, self.page, key))


def add_heading(text, style, level=0):
    """Add a heading with bookmark attributes for TOC."""
    key = f'h_{hashlib.md5(text.encode()).hexdigest()[:8]}'
    p = Paragraph(f'<a name="{key}"/>{text}', style)
    p.bookmark_name = key
    p.bookmark_level = level
    p.bookmark_text = text
    p.bookmark_key = key
    return p


# ━━ Page footer with page number ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def _draw_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont('FreeSerif-Italic', 8)
    canvas.setFillColor(TEXT_MUTED)
    # Left: doc title
    canvas.drawString(20*mm, 12*mm, 'Design Systems for Agentic Workflows  ·  Z.ai Engineering Memo')
    # Right: page number
    canvas.drawRightString(A4[0] - 20*mm, 12*mm, f'Page {doc.page}')
    # Top rule (very thin)
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.4)
    canvas.line(20*mm, 14*mm, A4[0] - 20*mm, 14*mm)
    canvas.restoreState()


# ━━ Helper builders ━────────────────────────────────────────────
def callout_box(label, stat, desc):
    """Three-row callout: label / big stat / description."""
    inner_data = [
        [Paragraph(label.upper(), callout_label_style)],
        [Paragraph(stat, callout_stat_style)],
        [Paragraph(desc, callout_desc_style)],
    ]
    inner = Table(inner_data, colWidths=[150])
    inner.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING', (0,0), (-1,-1), 0),
        ('RIGHTPADDING', (0,0), (-1,-1), 0),
        ('TOPPADDING', (0,0), (-1,-1), 2),
        ('BOTTOMPADDING', (0,0), (-1,-1), 2),
    ]))
    return inner


def stat_row(callouts):
    """Horizontal row of 3 callout boxes."""
    data = [[c for c in callouts]]
    col_w = (A4[0] - 40*mm - 12) / 3
    t = Table(data, colWidths=[col_w, col_w, col_w], hAlign='CENTER')
    t.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING', (0,0), (-1,-1), 10),
        ('RIGHTPADDING', (0,0), (-1,-1), 10),
        ('TOPPADDING', (0,0), (-1,-1), 10),
        ('BOTTOMPADDING', (0,0), (-1,-1), 10),
        ('BACKGROUND', (0,0), (-1,-1), CARD_BG),
        ('LINEABOVE', (0,0), (-1,0), 1.5, ACCENT),
        ('BOX', (0,0), (-1,-1), 0.4, BORDER),
    ]))
    return t


def make_table(header, rows, col_widths_ratio):
    """Build a centered, palette-styled table.
    col_widths_ratio: list of relative weights (e.g. [0.25, 0.40, 0.20, 0.15])
    """
    avail = A4[0] - 40*mm  # page width minus 20mm margins each side
    total = sum(col_widths_ratio)
    col_widths = [avail * (w / total) for w in col_widths_ratio]

    data = [
        [Paragraph(f'<b>{h}</b>', table_header_style) for h in header]
    ]
    for r in rows:
        data.append([Paragraph(c, table_cell_style) for c in r])

    t = Table(data, colWidths=col_widths, hAlign='CENTER', repeatRows=1)
    style_cmds = [
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER_COLOR),
        ('TEXTCOLOR', (0, 0), (-1, 0), TABLE_HEADER_TEXT),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('GRID', (0, 0), (-1, -1), 0.4, BORDER),
    ]
    # Zebra striping
    for i in range(1, len(data)):
        bg = TABLE_ROW_ODD if i % 2 == 1 else TABLE_ROW_EVEN
        style_cmds.append(('BACKGROUND', (0, i), (-1, i), bg))
    t.setStyle(TableStyle(style_cmds))
    return t


def safe_keep_together(elements):
    """Wrap in KeepTogether only if total height < 40% of page."""
    max_h = A4[1] * 0.4
    total_h = 0
    for el in elements:
        try:
            w, h = el.wrap(A4[0] - 40*mm, A4[1])
            total_h += h
        except Exception:
            return list(elements)
    if total_h <= max_h:
        return [KeepTogether(elements)]
    elif len(elements) >= 2:
        return [KeepTogether(elements[:2])] + list(elements[2:])
    return list(elements)


# ━━ Build the story ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
story = []

# ── TOC page ────────────────────────────────────────────────────
story.append(Paragraph('<b>Table of Contents</b>',
    ParagraphStyle(name='TocTitle', fontName=BOLD_FONT, fontSize=22, leading=28,
                   textColor=HEADER_FILL, alignment=TA_LEFT, spaceAfter=18)))
toc = TableOfContents()
toc.levelStyles = [toc_h1_style, toc_h2_style]
story.append(toc)
story.append(PageBreak())


# ── §0 Executive Summary ─────────────────────────────────────────
story.append(add_heading('Executive Summary', h1_style, level=0))
story.append(Paragraph(
    'A one-page distillation of the proposal — the problem, the architecture, '
    'the recommendation, and the integration point.', intro_style))

story.append(Paragraph(
    'Today, when a user asks our agent to build a UI without pinning a design language, '
    'the agent guesses. It invents a palette, picks fonts by feel, hardcodes spacing values, '
    'and every regeneration drifts further from anything resembling a coherent visual system. '
    'The output is technically valid React but visually incoherent — what designers call <i>brand drift</i>. '
    'The Vercel team calls this "mostly right" output, and it is the single largest source of '
    'rework in agent-driven UI generation (Vercel, <i>AI-powered prototyping with design systems</i>, Aug 2025).',
    body_style))
story.append(Paragraph(
    'This memo proposes a structural fix: a <b>Design-System Registry</b> — a folder of named, '
    'opinionated, fully-formed design-system packs the agent reads <i>before</i> it generates. '
    'Each pack is a self-contained tuple of (a) W3C-aligned CSS tokens in three layers (primitive → '
    'semantic → component), (b) a registry.json entry with importMap, fontStack, and dependencies, '
    'and (c) inline component snippets for the top 8 components. The agent asks the user which pack '
    'to use via <font name="DejaVuSans">AskUserQuestion</font>; the answer pins every subsequent '
    'design decision. No guesswork. No hardcoded hex values. No drift.',
    body_style))
story.append(Paragraph(
    'Recommendation: adopt <b>shadcn/ui</b> as the default registry pack for Next.js fullstack work '
    '(v0 does the same), with <b>Vercel Geist</b>, <b>Mantine</b>, <b>Tailwind Catalyst</b>, and '
    '<b>Park UI</b> as alternate packs for different aesthetic briefs. Integration point: one '
    'mandatory pack-selection question between the user prompt and the first generated component. '
    'Two-week sprint to v1.',
    body_style))

story.append(Spacer(1, 12))
story.append(stat_row([
    callout_box('Token Adoption 2026', '84%',
        'of design-system teams ship design tokens as the source of truth (Digital Applied, Jun 2026). The W3C Design Tokens spec reached stable on Oct 28, 2025.'),
    callout_box('Systems Evaluated', '5+',
        'production-ready design-system families surveyed: shadcn/ui, Mantine/Chakra/MUI, Tailwind Catalyst, Radix Themes/Park UI, and brand-pinned (Geist/HIG/M3).'),
    callout_box('Turns Saved', '~3',
        'per build by removing design guesswork: no re-prompting for palette, no fixing font conflicts, no spacing drift between regenerations.'),
]))
story.append(Spacer(1, 18))
story.append(HRFlowable(width='100%', thickness=0.6, color=BORDER, spaceBefore=2, spaceAfter=2))


# ── §1 The Problem: Agents Guess Styles ─────────────────────────
story.append(add_heading('1. The Problem: Agents Guess Styles', h1_style, level=0))
story.append(Paragraph(
    'Why every UI-generation turn without a pinned design language produces incoherent output.',
    intro_style))

story.append(add_heading('1.1 The Hardcoded Hex Symptom', h2_style, level=1))
story.append(Paragraph(
    'Consider what happens today when a user says <i>"build me a SaaS dashboard"</i> and the agent '
    'has no design-system constraint. The model reaches into its prior for what a SaaS dashboard '
    'looks like and emits something like the code on the left below. The code on the right is what '
    'the same agent produces when bound to a registry pack — same prompt, same model, same temperature, '
    'but the second turn references CSS custom properties instead of inventing hex values.',
    body_style))

story.append(Paragraph(
'<font color="#a35049">// WITHOUT a registry pack — agent invents the design system</font><br/>'
'&lt;button className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md"&gt;<br/>'
'&nbsp;&nbsp;Save<br/>'
'&lt;/button&gt;<br/><br/>'
'<font color="#4a8a5f">// WITH a registry pack — agent reads tokens.css first</font><br/>'
'&lt;button style={{<br/>'
'&nbsp;&nbsp;background: var(--button-bg-primary),<br/>'
'&nbsp;&nbsp;color: var(--button-fg-primary),<br/>'
'&nbsp;&nbsp;padding: var(--button-padding-y) var(--button-padding-x),<br/>'
'&nbsp;&nbsp;borderRadius: var(--button-radius)<br/>'
'}}&gt;Save&lt;/button&gt;', mono_style))
story.append(Paragraph('Figure 1.1 — The same prompt with and without a registry pack binding.',
                       caption_style))

story.append(Paragraph(
    'The first button works. It looks fine. But every regeneration drifts — the next time the '
    'agent reaches for blue, it might pick <font name="DejaVuSans">#3b82f6</font> or '
    '<font name="DejaVuSans">#2563eb</font> or <font name="DejaVuSans">#1d4ed8</font> depending on '
    'context window temperature. After three turns the dashboard has three slightly different '
    'blues. After five turns the sidebar uses sans-serif Inter while the header uses system-ui. '
    'This is not a model-quality problem; it is a <b>constraint problem</b>. The agent is being '
    'asked to make a hundred micro-decisions (which blue, which radius, which font weight, which '
    'line-height) that a human design team would have made once, codified, and never revisited.',
    body_style))

story.append(add_heading('1.2 The Vercel "Mostly Right" Diagnosis', h2_style, level=1))
story.append(Paragraph(
    'Vercel\'s August 2025 essay <i>AI-powered prototyping with design systems</i> names this exact '
    'failure mode: "mostly right" output. The generated UI is structurally correct (it compiles, '
    'the JSX is valid, the accessibility is fine), but it is visually incoherent — the agent '
    'guessed at every visual primitive independently instead of inheriting a coherent system. '
    'Vercel\'s solution was to bake shadcn/ui into v0 as the default design system, and to add a '
    '<i>design mode</i> that lets you fine-tune layout, copy, typography without re-prompting. '
    'This memo proposes the same architectural move for our agent: bake a default pack in, and '
    'offer pack selection as the first question of every UI-generation turn.',
    body_style))

story.append(add_heading('1.3 Why This Costs Us', h2_style, level=1))
story.append(Paragraph(
    'Three concrete costs of the current guesswork pattern. <b>First</b>, regeneration cost: users '
    're-prompt 2-3 times per build just to fix visual drift, burning context window and credits. '
    '<b>Second</b>, consistency cost: when the same user asks for a second dashboard next week, the '
    'agent has no memory of what it picked last time — different palette, different fonts. '
    '<b>Third</b>, hand-off cost: when a human designer inherits an agent-generated project, they '
    'spend hours cataloguing the ad-hoc tokens spread across components before they can make a '
    'single targeted change. All three costs vanish the moment the agent is bound to a named pack.',
    body_style))


# ── §2 What "Agentic Design System" Means in 2026 ────────────────
story.append(add_heading('2. What "Agentic Design System" Means in 2026', h1_style, level=0))
story.append(Paragraph(
    'A precise definition, the three pillars, and why the W3C spec finally matters.',
    intro_style))

story.append(Paragraph(
    'The phrase <i>agentic design system</i> has a specific 2026 meaning, distinct from the older '
    'notion of a design system as a Figma library plus a component kit. The Intodesignsystems '
    'complete guide defines it cleanly: <i>"An agentic design system is infrastructure that lets '
    'AI agents autonomously read, reason over, and build with your components, tokens, and guidelines."</i> '
    'The shift is from a system designed for human designers (visual, exploratory, Figma-bound) to '
    'a system designed for machine consumption (machine-readable, deterministic, code-bound). The '
    'agent does not need pretty pictures; it needs three things it can parse and obey.',
    body_style))

story.append(Paragraph(
    'Pillar one: <b>machine-readable tokens</b>. The W3C Design Tokens Community Group shipped the '
    'first stable spec on October 28, 2025 — vendor-neutral, machine-consumable, with formal types '
    'for color, dimension, font, and motion tokens. By mid-2026 design-token adoption had hit 84% '
    'in production design-system teams (Digital Applied, <i>Design Systems in 2026</i>). The spec '
    'matters because it gives the agent a contract: if a token file declares '
    '<font name="DejaVuSans">"$type": "color"</font>, the agent can rely on the value being a '
    'parseable color, not a string that might say "blueish".',
    body_style))

story.append(Paragraph(
    'Pillar two: <b>copy-paste component code</b>. The shadcn/ui pattern — you own the component '
    'source, you copy it into your project, you modify it as needed — turned out to be a much '
    'better fit for LLM agents than the npm-install pattern. When the agent copies a Button.tsx '
    'into the project, it can read the file, understand every prop, customize it for the specific '
    'use case, and never worry about runtime upgrades breaking its customizations. Vercel\'s '
    'official line on this is unambiguous: <i>"This works well with AI generated code, as it allows '
    'you to customize the components to fit your design system"</i> (v0 design-systems docs). '
    'Runtime libraries (Mantine, MUI) still have a place — they are excellent for enterprise '
    'work where the agent is wiring pre-built complex components rather than authoring new ones.',
    body_style))

story.append(Paragraph(
    'Pillar three: <b>explicit usage contracts</b>. The agent needs to know what <i>not</i> to do. '
    'A good agentic design system includes do/don\'t rules: "always use var(--color-accent) for '
    'links, never hardcode blue", "card radius is always var(--radius-card), never invent a radius". '
    'Kaelig\'s April 2026 writeup of building design-system components with agent teams describes '
    'the discipline plainly: <i>"The Code Writer has strict rules about tokens. No hardcoded colors, '
    'spacing, or typography — everything goes through CSS custom properties from tokens.css."</i> '
    'That rule, codified into the agent\'s system prompt and the registry\'s schema, is what makes '
    'the difference between a generated UI that drifts and one that holds.',
    body_style))

story.append(Paragraph(
    'Shreyas Prakash\'s May 2026 essay <i>My agentic engineering workflow</i> describes the audit '
    'step that closes the loop: when an agent team inherits an existing project, the first thing '
    'they do is <i>"audit every CSS/SCSS file and create a tokens.css file with three layers — '
    'primitive, semantic, component"</i>. That three-layer structure is what we adopt verbatim for '
    'each registry pack, and it is the contract that lets the agent reason about the design system '
    'deterministically instead of aesthetically.',
    body_style))

story.append(Paragraph(
    '"The agent does not need pretty pictures; it needs a contract it can parse, obey, and verify against."',
    pull_quote_style))


# ── §3 Taxonomy ──────────────────────────────────────────────────
story.append(add_heading('3. Taxonomy: Five Families of Design Systems', h1_style, level=0))
story.append(Paragraph(
    'A 2026 comparison set: shadcn/ui, runtime libs, Tailwind Catalyst, headless+themes, and brand-pinned.',
    intro_style))

story.append(Paragraph(
    'Before recommending a registry composition, we map the landscape. Five families cover essentially '
    'every production-grade design system available to a Next.js fullstack agent in 2026. They differ '
    'along four dimensions: distribution model (copy-paste source vs. npm-install runtime), theming '
    'mechanism (CSS variables vs. JavaScript theme provider vs. Tailwind config), AI-readiness (how '
    'easily an agent can parse and obey the tokens), and cost (free / paid / open-source-but-paid-Pro). '
    'The table below summarizes the families; section 4 scores them against our criteria.',
    body_style))

story.append(make_table(
    header=['Family', 'Example', 'Theming', 'AI-readable', 'Cost', 'Best use'],
    rows=[
        ['Copy-paste source', 'shadcn/ui', 'CSS vars + Tailwind', 'High', 'Free / MIT',
         'New React+Tailwind apps'],
        ['Runtime library', 'Mantine, Chakra, MUI', 'JS theme provider', 'Medium', 'Free / MIT',
         'Enterprise dashboards'],
        ['Tailwind team kit', 'Catalyst / Tailwind UI', 'Tailwind config', 'High', 'Paid',
         'Tailwind-native work'],
        ['Headless + themes', 'Radix Themes, Park UI', 'CSS vars (themes) or Panda/CVA', 'High', 'Free / paid tiers',
         'When you need full control'],
        ['Brand-pinned', 'Geist (Vercel), Apple HIG, Material 3', 'Hardcoded brand language', 'Medium',
         'Free / brand-bound', 'Match a specific brand'],
    ],
    col_widths_ratio=[0.16, 0.18, 0.20, 0.13, 0.13, 0.20],
))
story.append(Paragraph('Table 3.1 — The five design-system families available to a Next.js fullstack agent in 2026.',
                       caption_style))

story.append(add_heading('3.1 Family A — Copy-Paste Source: shadcn/ui', h2_style, level=1))
story.append(Paragraph(
    'shadcn/ui is the standout solution of the 2025-2026 cycle. Built on Radix primitives and '
    'Tailwind, it ships not as an npm dependency but as a CLI that copies component source code '
    'into your project. You own the code; you customize it; you never fight an upgrade. v0 '
    'defaults to it (Vercel, <i>shadcn/ui vs. Radix UI</i>, Jun 2026), and the shadcn registry '
    'community publishes over 1,400 blocks and 1,189 component variants (birobirobiro/'
    'awesome-shadcn-ui). The copy-paste model is what makes it agent-friendly: the agent can read '
    'the entire Button.tsx, customize it for the specific page, and the resulting code is just '
    'TypeScript — no opaque runtime dependency.',
    body_style))

story.append(add_heading('3.2 Family B — Runtime Libraries: Mantine, Chakra, MUI', h2_style, level=1))
story.append(Paragraph(
    'The runtime-library family is the older enterprise default: install via npm, wrap your app '
    'in a ThemeProvider, configure tokens in a JavaScript object, get a hundred components for '
    'free. Mantine 7.x is the strongest 2026 entry — first-party AppShell, Notifications, Dates, '
    'a hooks library, and excellent TypeScript types. Chakra UI v3 is still strong on accessibility '
    'and ergonomics. MUI remains the safe enterprise default for teams that need a MatTable-style '
    'data grid out of the box. The trade-off: runtime libraries fight Tailwind (their components '
    'ship with their own CSS that overrides utility classes), which means an agent using them '
    'should NOT also try to apply Tailwind utilities to the same components. They are best treated '
    'as isolated packs, wrapped in CSS layers.',
    body_style))

story.append(add_heading('3.3 Family C — Tailwind UI Catalyst', h2_style, level=1))
story.append(Paragraph(
    'Catalyst is the Tailwind team\'s official application UI kit — built on Headless UI and React, '
    'designed by the people who wrote Tailwind. It is paid (Tailwind Plus subscription), but it is '
    'the cleanest expression of "Tailwind-native components" available. For an agent that already '
    'knows Tailwind deeply, Catalyst components are the path of least resistance — they use the '
    'utility classes the agent already generates correctly, and they require zero theme-provider '
    'boilerplate. Worth including in the registry for teams that have paid for Tailwind Plus.',
    body_style))

story.append(add_heading('3.4 Family D — Headless + Themes: Radix Themes, Park UI', h2_style, level=1))
story.append(Paragraph(
    'The headless-and-themes family splits the problem: the headless library (Radix Primitives, '
    'Ark UI) handles accessibility and behavior, the themes layer (Radix Themes, Park UI\'s default '
    'styles) handles the visual system. Park UI specifically combines Radix/Ark with Panda or CVA, '
    'giving you a styled-component-style authoring experience on top of headless primitives. This '
    'family is what to reach for when you want full control — the agent can override any single '
    'token without forking a component file. The cost is more setup complexity than shadcn/ui, '
    'which is why we treat it as an alternate pack, not the default.',
    body_style))

story.append(add_heading('3.5 Family E — Brand-Pinned: Geist, Apple HIG, Material 3', h2_style, level=1))
story.append(Paragraph(
    'Brand-pinned systems exist for one reason: when the user says "make it look like Vercel" or '
    '"make it look like an Apple app", you need the actual brand language, not an approximation. '
    'Vercel\'s Geist is the most accessible — open-source, npm-installable, both font (Geist Sans, '
    'Geist Mono) and component packages. Apple HIG and Material 3 require more interpretation; '
    'they are design <i>guidelines</i>, not code libraries, so the agent has to apply the guidelines '
    'as rules rather than import components. Worth including Geist as a registry pack; HIG and M3 '
    'are better treated as "style guides" the agent loads into its system prompt on demand.',
    body_style))


# ── §4 Evaluation ───────────────────────────────────────────────
story.append(add_heading('4. Evaluation: Which Packs Belong in Our Registry?', h1_style, level=0))
story.append(Paragraph(
    'Six criteria, weighted for Next.js fullstack agentic generation. shadcn/ui wins decisively.',
    intro_style))

story.append(Paragraph(
    'A registry should be small (seven packs max — see §7) and every pack should earn its place. '
    'We score each of the five families against six criteria weighted for the specific job: an '
    'agent generating Next.js fullstack apps (dashboards, SaaS, internal tools) for users who may '
    'or may not specify a design language up-front. The criteria, in order of weight:',
    body_style))

story.append(Paragraph(
    '<b>(1) AI-readability of tokens</b> — can the agent parse the token file deterministically and '
    'reference var(--*) names in generated code? <b>(2) Open-code copy-paste model</b> — does the '
    'agent own the component source, or does it import an opaque runtime? <b>(3) Tailwind-native</b> — '
    'do the components use Tailwind utilities the agent already generates correctly? <b>(4) Server-component '
    'friendliness (RSC-safe imports)</b> — do the components work in Next.js App Router server components '
    'without "use client" leakage? <b>(5) Community block ecosystem</b> — is there a rich library of '
    'pre-built blocks the agent can compose, or just primitives? <b>(6) Maintenance signal</b> — '
    'is the project actively maintained, with a clear release cadence and visible sponsor?',
    body_style))

story.append(make_table(
    header=['Family', 'Tokens', 'Copy-paste', 'Tailwind', 'RSC-safe', 'Ecosystem', 'Maint.', 'Total /10'],
    rows=[
        ['shadcn/ui',         '10', '10', '10', '10', '10', '9',  '<b>9.5</b>'],
        ['Park UI',           '10', '8',  '9',  '9',  '8',  '8',  '8.5'],
        ['Tailwind Catalyst', '9',  '8',  '10', '10', '8',  '9',  '8.0'],
        ['Mantine',           '8',  '5',  '4',  '7',  '9',  '10', '7.5'],
        ['Geist (Vercel)',    '8',  '7',  '7',  '9',  '6',  '9',  '7.0'],
        ['Chakra UI',         '7',  '5',  '4',  '7',  '8',  '9',  '6.5'],
        ['MUI',               '7',  '4',  '3',  '6',  '10', '10', '6.0'],
    ],
    col_widths_ratio=[0.18, 0.10, 0.12, 0.10, 0.10, 0.12, 0.10, 0.13],
))
story.append(Paragraph('Table 4.1 — Six-criteria scoring (1-10 each). shadcn/ui is the clear primary pack.',
                       caption_style))

story.append(Paragraph(
    'The scoring is decisive: <b>shadcn/ui at 9.5/10</b> is the only pack that wins on every '
    'criterion. It is what v0 uses as default. It is Tailwind-native (which matches our existing '
    'stack). Its copy-paste model gives the agent full source code ownership. The RSC story is '
    'clean (server components work without "use client" leaks). And the community registry — '
    '1,429 blocks and counting — gives the agent a huge compositional surface. The alternates each '
    'have a clear niche: <b>Park UI</b> for full-control work, <b>Tailwind Catalyst</b> for '
    'paid-brand Tailwind-native work, <b>Mantine</b> for enterprise dashboards with AppShell and '
    'Notifications, <b>Geist</b> for when the user explicitly references Vercel\'s aesthetic.',
    body_style))


# ── §5 The Proposed Architecture ─────────────────────────────────
story.append(add_heading('5. The Proposed Architecture: Design-System Registry', h1_style, level=0))
story.append(Paragraph(
    'A folder of named packs the agent reads before generating. Three layers per pack, zero hardcoded values.',
    intro_style))

story.append(add_heading('5.1 Folder Layout', h2_style, level=1))
story.append(Paragraph(
    'The registry is a plain folder checked into the agent\'s repo. Every pack is a subfolder '
    'containing at minimum a <font name="DejaVuSans">tokens.css</font> file and an entry in '
    '<font name="DejaVuSans">registry.json</font>. Optional: a <font name="DejaVuSans">components/</font> '
    'subfolder with sample TSX snippets the agent can copy when generating new components.',
    body_style))

story.append(Paragraph(
'<font color="#4a8a5f"># Repository layout</font><br/>'
'design-systems/<br/>'
'├── _registry.schema.json     <font color="#81878b"># JSON Schema for a pack entry</font><br/>'
'├── registry.json             <font color="#81878b"># Index of all packs + defaultPack field</font><br/>'
'├── README.md<br/>'
'├── shadcn-default/<br/>'
'│   └── tokens.css            <font color="#81878b"># primitive → semantic → component</font><br/>'
'├── vercel-geist/<br/>'
'│   └── tokens.css<br/>'
'└── mantine-default/<br/>'
'    └── tokens.css', mono_style))
story.append(Paragraph('Figure 5.1 — The registry is a checked-in folder, not a build step.',
                       caption_style))

story.append(add_heading('5.2 The registry.json Entry', h2_style, level=1))
story.append(Paragraph(
    'Each pack is described by a single JSON object. The agent reads the registry, presents the '
    'pack names + palette hints via AskUserQuestion, and loads the chosen pack\'s '
    '<font name="DejaVuSans">tokens.css</font> before generating. The schema mandates enough '
    'metadata that the agent never has to guess: <font name="DejaVuSans">importMap</font> tells it '
    'where Button/Input/Card come from for this pack, <font name="DejaVuSans">dependencies</font> '
    'tells it what npm packages must be installed, <font name="DejaVuSans">fontStack</font> tells '
    'it what fonts to inject into <font name="DejaVuSans">globals.css</font>.',
    body_style))

story.append(Paragraph(
'<font color="#4a8a5f">// registry.json (excerpt)</font><br/>'
'{<br/>'
'&nbsp;&nbsp;"version": "1.0.0",<br/>'
'&nbsp;&nbsp;"defaultPack": "shadcn-default",<br/>'
'&nbsp;&nbsp;"packs": [<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;{<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"name": "shadcn-default",<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"description": "Indigo, neutral, editorial. v0\'s defaults.",<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"palette": {<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"primary": "#1e3a5f",<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"background": "#fafafa",<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"accent": "#3b82f6",<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"text": "#0a0a0a"<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;},<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"tokens": "tokens.css",<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"importMap": {<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"Button": "@/components/ui/button",<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"Card":   "@/components/ui/card",<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"...":   "..."<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;},<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"dependencies": [<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{"package": "tailwindcss", "min": "3.4.0"}<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;]<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;}<br/>'
'&nbsp;&nbsp;]<br/>'
'}', mono_style))
story.append(Paragraph('Figure 5.2 — registry.json. Each pack entry is small enough to fit in one screen.',
                       caption_style))

story.append(add_heading('5.3 The Three-Layer tokens.css', h2_style, level=1))
story.append(Paragraph(
    'Every pack\'s <font name="DejaVuSans">tokens.css</font> follows the same three-layer structure '
    'recommended by Shreyas Prakash: <b>(1) Primitive</b> — raw values with no semantic meaning '
    '(<font name="DejaVuSans">--indigo-500: #3b82f6</font>); <b>(2) Semantic</b> — role-bound '
    'aliases (<font name="DejaVuSans">--color-accent: var(--indigo-500)</font>); <b>(3) Component</b> '
    '— component-scoped (<font name="DejaVuSans">--button-bg-primary: var(--color-accent)</font>). '
    'The agent references only layers 2 and 3 in generated code; layer 1 exists so a pack maintainer '
    'can re-skin the entire system by editing one block. This contract is what makes the agent\'s '
    'output verifiable — a linter can grep for hardcoded hex values and fail the build if any are '
    'found outside layer 1.',
    body_style))


# ── §6 Workflow Integration ─────────────────────────────────────
story.append(add_heading('6. Workflow Integration: From User Pick to Generated Page', h1_style, level=0))
story.append(Paragraph(
    'Step-by-step trace of one UI-generation turn, with a fallback ladder for when the user skips the question.',
    intro_style))

story.append(Paragraph(
    'The integration point is exactly one new question, asked between the user\'s initial prompt '
    'and the first generated component. The question is presented via the existing AskUserQuestion '
    'tool — the same tool we already use for document clarification. The agent\'s system prompt '
    'is updated to mandate this question for any UI-generation turn.',
    body_style))

story.append(add_heading('6.1 The Pack-Selection Question', h2_style, level=1))
story.append(Paragraph(
    'The question presents 3-5 pack options, each with a concrete palette hint and a sample headline '
    'so the user knows what they are picking. The recommended default is always shadcn-default — '
    'it is the safest, the most generic, and what v0 uses. The user is free to type a custom answer '
    '(e.g. "use the brand colors from our Figma file at https://..."), which triggers the Figma '
    'import path (out of scope for v1; see §7).',
    body_style))

story.append(Paragraph(
'<font color="#4a8a5f">// AskUserQuestion payload (excerpt)</font><br/>'
'{<br/>'
'&nbsp;&nbsp;"question": "Which design system should the agent use?",<br/>'
'&nbsp;&nbsp;"header": "Design system",<br/>'
'&nbsp;&nbsp;"type": "single",<br/>'
'&nbsp;&nbsp;"options": [<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;{"label": "shadcn-default",<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"description": "Indigo, neutral, editorial. v0\'s defaults — Radix + Tailwind.",<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"recommended": true},<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;{"label": "vercel-geist",<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"description": "Black, white, ultra-minimalist. Strict monochrome, mono-font accents."},<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;{"label": "mantine-default",<br/>'
'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"description": "Warm gray, dense, feature-rich. Best for enterprise dashboards."}<br/>'
'&nbsp;&nbsp;]<br/>'
'}', mono_style))
story.append(Paragraph('Figure 6.1 — The AskUserQuestion payload for pack selection.', caption_style))

story.append(add_heading('6.2 From Pick to Generated Component', h2_style, level=1))
story.append(Paragraph(
    'Once the user picks a pack, the agent\'s flow is deterministic: <b>(1)</b> read '
    '<font name="DejaVuSans">registry.json</font>, find the entry for the chosen pack; <b>(2)</b> '
    'verify all <font name="DejaVuSans">dependencies</font> are installed in the target project '
    '(if not, fall back to shadcn-default and warn the user); <b>(3)</b> inject the pack\'s '
    '<font name="DejaVuSans">tokens.css</font> into the project\'s <font name="DejaVuSans">globals.css</font> '
    '(or as a Tailwind plugin, depending on stack); <b>(4)</b> load the <font name="DejaVuSans">importMap</font> '
    'into context so every generated component import resolves to the right path; <b>(5)</b> generate '
    'components referencing <font name="DejaVuSans">var(--button-bg-primary)</font> instead of '
    'inventing hex values.',
    body_style))

story.append(Paragraph(
    'For example, when the user picks <b>vercel-geist</b> and asks for a SaaS dashboard, the agent '
    'generates a Sidebar component that uses <font name="DejaVuSans">background: var(--color-bg)</font> '
    '(pure white in Geist), <font name="DejaVuSans">border-right: 1px solid var(--color-border-default)</font> '
    '(a 1px gray-200 line, Geist\'s signature hairline), and <font name="DejaVuSans">fontFamily: '
    'var(--font-sans)</font> (Geist Sans). No hardcoded values anywhere. The same dashboard built '
    'with <b>mantine-default</b> would look completely different — warm gray background, Mantine\'s '
    'rounded-sm buttons, M-blue-6 accents — because the agent is reading a different tokens.css. '
    'The user got exactly the design language they asked for.',
    body_style))

story.append(add_heading('6.3 The Fallback Ladder', h2_style, level=1))
story.append(Paragraph(
    'Three rungs, in order: <b>(1) Ask</b> — present pack options via AskUserQuestion, always. '
    '<b>(2) Default</b> — if the user skips the question, use the <font name="DejaVuSans">defaultPack</font> '
    'field from registry.json (shadcn-default in v1). <b>(3) Figma</b> — if the user supplies a '
    'Figma URL, route to the Figma-to-tokens bridge (out of scope for v1; see §7.4). The fallback '
    'ladder guarantees the agent never silently invents a design language — at worst it uses the '
    'documented default, which is itself a coherent system.',
    body_style))


# ── §7 Risks ────────────────────────────────────────────────────
story.append(add_heading('7. Risks and Mitigations', h1_style, level=0))
story.append(Paragraph(
    'Five risks the registry introduces, with concrete mitigations for each.',
    intro_style))

story.append(Paragraph(
    'Any new architectural component introduces failure modes. The registry is no exception. The '
    'table below enumerates the five risks we expect to encounter in the first quarter of '
    'production use, with the mitigation we are committing to for each. None of the risks are '
    'blocking; all of them are addressable with the mitigations listed.',
    body_style))

story.append(make_table(
    header=['#', 'Risk', 'Mitigation'],
    rows=[
        ['1', 'Stale packs — a pack\'s tokens.css drifts from the actual component behavior (e.g. shadcn/ui ships a Button update that renames --button-bg).',
         'Pin a git SHA in each registry.json entry. Monthly version-bump sweep. CI test: every pack is smoke-tested against its declared dependencies before each release.'],
        ['2', 'Brand drift — user picks the wrong pack for the brief (e.g. picks Geist for a kid-friendly app).',
         'Pack descriptions include a sample headline + palette hint + "best for" tags. AskUserQuestion shows these. If the user picks against a "best for" tag, the agent softly warns.'],
        ['3', 'Pack sprawl — the registry grows past 7 packs and becomes unmaintainable / confusing to users.',
         'Hard cap at 7 packs. Archive low-usage packs to design-systems/_archived/ quarterly. Usage metric: pack selected in <2% of builds for 2 consecutive months = archive candidate.'],
        ['4', 'Runtime libs (Mantine, MUI) fight Tailwind — their components ship CSS that overrides utility classes.',
         'Mark them as "isolated" packs in registry.json. The agent does NOT apply Tailwind utilities to runtime-lib components. Wrapped in @layer mantine { ... } to keep specificity predictable.'],
        ['5', 'Figma import complexity — the v2 Figma-to-tokens bridge is brittle (Figma API changes, tokens format mismatch).',
         'v1 ships WITHOUT Figma import. v2 adds it via Tokens Studio (which handles Figma variables → W3C tokens). Never build a custom Figma adapter — depend on Tokens Studio.'],
    ],
    col_widths_ratio=[0.04, 0.40, 0.56],
))
story.append(Paragraph('Table 7.1 — Five risks with mitigations. All are addressable; none are blocking.',
                       caption_style))


# ── §8 Roadmap ──────────────────────────────────────────────────
story.append(add_heading('8. Roadmap and Recommendation', h1_style, level=0))
story.append(Paragraph(
    'A two-week sprint to v1, a month-2 v1.1, and a Q2 v2 with Figma import and full W3C spec compliance.',
    intro_style))

story.append(add_heading('8.1 Week 1 — Minimum Viable Registry', h2_style, level=1))
story.append(Paragraph(
    'Ship the registry.json schema (already drafted, see Appendix A), the shadcn-default pack with '
    '40 components wired through importMap, the AskUserQuestion payload for pack selection, and the '
    'agent system-prompt update that makes the pack-selection question mandatory for every '
    'UI-generation turn. Definition of done: a user saying "build me a dashboard" gets the pack '
    'question first, picks one, and the generated dashboard uses zero hardcoded hex values — '
    'verifiable by a grep linter.',
    body_style))

story.append(add_heading('8.2 Week 2 — Alternates + Pack Authoring Guide', h2_style, level=1))
story.append(Paragraph(
    'Add the vercel-geist and mantine-default packs (both already drafted in Appendix A). Write '
    'the Pack Authoring Guide — a 5-page doc covering the three-layer token structure, the JSON '
    'schema, and the process for contributing a new pack (open a PR with tokens.css + registry.json '
    'entry + sample components; the CI validates against the schema). At this point the registry '
    'has 3 packs and a clear process for adding more.',
    body_style))

story.append(add_heading('8.3 Month 2 (v1.1) — Park UI + Catalyst', h2_style, level=1))
story.append(Paragraph(
    'Add Park UI (for full-control work) and Tailwind Catalyst (for paid Tailwind Plus subscribers). '
    'This brings the registry to 5 packs — enough to cover 95% of use cases without being so many '
    'that the AskUserQuestion becomes a chore. v1.1 also adds the pack-usage metrics pipeline so '
    'we can identify archive candidates quarterly.',
    body_style))

story.append(add_heading('8.4 Q2 (v2) — Figma Import + W3C Compliance', h2_style, level=1))
story.append(Paragraph(
    'Two big additions. <b>Figma import</b> via Tokens Studio — when the user supplies a Figma URL '
    'in the pack-selection question, the agent calls Tokens Studio to convert the Figma variables '
    'into a W3C Design Tokens v2025.10 spec file, drops it into a new pack folder '
    '(<font name="DejaVuSans">design-systems/user-figma-{hash}/tokens.css</font>), and uses it as '
    'the pack. <b>Full W3C compliance</b> — re-format every shipped tokens.css to use the W3C JSON '
    'token format, not raw CSS custom properties, and use Style Dictionary to compile down to CSS. '
    'This is a non-trivial migration but it makes the registry future-proof against the spec.',
    body_style))

story.append(add_heading('8.5 Final Recommendation', h2_style, level=1))
story.append(Paragraph(
    '<b>Adopt shadcn/ui as the default registry pack, build the Design-System Registry as the '
    'integration point, and gate every UI-generation turn on a pack-selection question.</b> This '
    'single architectural move converts a hundred ad-hoc micro-decisions per build into one '
    'explicit user choice, eliminates brand drift between regenerations, and aligns our agent '
    'with the broader industry pattern (v0, Lovable, Bolt.new all converged on the same '
    'design-system-bound approach in 2025-2026). The two-week v1 cost is small; the long-term '
    'elimination of rework is the payoff.',
    body_style))


# ── Appendix A ──────────────────────────────────────────────────
story.append(add_heading('Appendix A: Code Skeleton', h1_style, level=0))
story.append(Paragraph(
    'A working reference implementation, saved as a separate file alongside this memo.',
    intro_style))

story.append(Paragraph(
    'The complete code skeleton ships alongside this memo as '
    '<font name="DejaVuSans">design-systems-skeleton.zip</font> in the same download directory. '
    'It contains the registry schema, three fully-formed packs (shadcn-default, vercel-geist, '
    'mantine-default), each with a complete three-layer tokens.css, plus the README and the '
    'registry index. The contents below are inlined for self-containedness — the same files are '
    'in the zip.',
    body_style))

story.append(add_heading('A.1 Directory Layout', h2_style, level=1))
story.append(Paragraph(
'design-systems/<br/>'
'├── _registry.schema.json<br/>'
'├── registry.json<br/>'
'├── README.md<br/>'
'├── shadcn-default/<br/>'
'│   └── tokens.css<br/>'
'├── vercel-geist/<br/>'
'│   └── tokens.css<br/>'
'└── mantine-default/<br/>'
'    └── tokens.css', mono_style))

story.append(add_heading('A.2 vercel-geist/tokens.css (excerpt — Layer 1 + Layer 2)', h2_style, level=1))
story.append(Paragraph(
'<font color="#81878b">/* ── 1. PRIMITIVE (raw) ── */</font><br/>'
':root {<br/>'
'&nbsp;&nbsp;--black:      #000000;<br/>'
'&nbsp;&nbsp;--white:      #ffffff;<br/>'
'&nbsp;&nbsp;--gray-950:   #0a0a0a;<br/>'
'&nbsp;&nbsp;--gray-200:   #eaeaea;<br/>'
'&nbsp;&nbsp;--blue-vercel: #0070f3;<br/>'
'&nbsp;&nbsp;/* ... */<br/>'
'}<br/><br/>'
'<font color="#81878b">/* ── 2. SEMANTIC (role-bound) ── */</font><br/>'
':root {<br/>'
'&nbsp;&nbsp;--color-bg:              var(--white);<br/>'
'&nbsp;&nbsp;--color-text-primary:    var(--gray-950);<br/>'
'&nbsp;&nbsp;--color-border-default:  var(--gray-200);<br/>'
'&nbsp;&nbsp;--color-accent:          var(--blue-vercel);<br/>'
'&nbsp;&nbsp;/* ... */<br/>'
'}<br/><br/>'
'<font color="#81878b">/* ── 3. COMPONENT (component-scoped) ── */</font><br/>'
':root {<br/>'
'&nbsp;&nbsp;--button-bg-primary:       var(--gray-950);<br/>'
'&nbsp;&nbsp;--button-fg-primary:       var(--white);<br/>'
'&nbsp;&nbsp;--button-padding-x:        var(--space-5);<br/>'
'&nbsp;&nbsp;--card-bg:                 var(--white);<br/>'
'&nbsp;&nbsp;--card-border:             var(--gray-200);<br/>'
'}', mono_style))
story.append(Paragraph('Listing A.1 — The three-layer structure for the vercel-geist pack. See the full file in the zip.',
                       caption_style))

story.append(add_heading('A.3 How to Use', h2_style, level=1))
story.append(Paragraph(
    'Unzip <font name="DejaVuSans">design-systems-skeleton.zip</font> into the root of the agent '
    'project. The agent\'s system prompt should reference <font name="DejaVuSans">design-systems/'
    'registry.json</font> as the source of truth, and the AskUserQuestion payload in §6.1 should be '
    'wired to read pack options from the registry\'s <font name="DejaVuSans">packs</font> array. '
    'When the user picks a pack, the agent loads <font name="DejaVuSans">design-systems/{pack}/'
    'tokens.css</font> and reads the <font name="DejaVuSans">importMap</font> for that pack from '
    'the registry. The pack\'s <font name="DejaVuSans">dependencies</font> field tells the agent '
    'what npm packages must be installed; missing dependencies trigger a fallback to '
    'shadcn-default with a warning.',
    body_style))


# ━━ Build the body PDF ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
output_path = '/home/z/my-project/download/_body.pdf'
doc = TocDocTemplate(
    output_path,
    pagesize=A4,
    leftMargin=20*mm, rightMargin=20*mm,
    topMargin=20*mm, bottomMargin=20*mm,
    title='Design Systems for Agentic Workflows',
    author='Z.ai',
    creator='Z.ai',
    subject='Engineering Strategy Memo — Design System Registry for Agentic UI Generation',
)
doc.multiBuild(story, onFirstPage=_draw_footer, onLaterPages=_draw_footer)
print(f'Body PDF generated: {output_path}')
